#!/bin/sh
#
# git-sync.sh — turn staged n8n workflow exports into GitHub commits.
#
# Runs INSIDE the exporter sidecar (alpine/git: git + sh only — no python, no
# jq, no docker). Invoked by Coolify Scheduled Task 2 (see docs/BACKUP.md).
# The script is baked into the exporter image as /usr/local/bin/git-sync
# (see Dockerfile.exporter) — deliberately NOT loaded from /repo, because
# the script itself clones /repo (loading it from /repo would be a
# chicken-and-egg bootstrap failure on an empty volume). The task command is
# simply:
#
#   /usr/local/bin/git-sync
#
# What it does:
#   1. ensures /repo is a fresh checkout of origin/$GIT_BRANCH
#      (clone if missing, else fetch + hard reset — local drift is discarded)
#   2. prepares /exports as world-writable (exporter runs as root; the n8n
#      container writes there as the unprivileged node user)
#   3. REFUSES unless /exports/.ready exists. The export task writes to
#      /exports/next, promotes it to /exports/current (an EMPTY snapshot when
#      the instance has zero workflows), and creates .ready last — so a
#      failed/partial export can never present a half-populated set here.
#   4. treats .ready as authoritative: an EMPTY /exports/current is a valid
#      "zero workflows" snapshot that deletes every tracked workflow JSON
#      (the user deleted the last workflow). Emptiness alone is not an error.
#   5. replaces workflows/*.json with the staged files, normalising formatting
#      (python3 -> jq -> perl/JSON::PP -> as-is fallback; CLI --pretty output
#      is already stable, this is belt-and-braces)
#   6. FAIL-CLOSED secret scan BEFORE git add: any likely secret aborts the
#      run with a non-zero exit (file + category reported, value never
#      printed). Nothing is committed or pushed.
#   7. holds the shared /exports/.lock from the first marker read through push
#      and marker consumption, and re-validates the marker token before git add
#      and before committing. A cooperating re-export cannot replace current;
#      an out-of-band marker replacement is rejected by the token comparison.
#   8. commits + pushes ONLY on real change (safe to run on a schedule)
#   9. consumes /exports/.ready after a successful push OR a successful
#      no-change sync, so each export is synced at most once. A failed push
#      keeps .ready so the next run retries the same complete set.
#
# Env (all from the exporter service definition, i.e. Coolify env):
#   GIT_REPO_URL  https remote of this repo (required)
#   GIT_BRANCH    branch to sync (default: main)
#   GIT_TOKEN     HTTPS token, fine-grained PAT with Contents: Read and write
#                 on this repo only (required for push; clone is public-or-token)
#   REPO_DIR      checkout location (default: /repo)
#   STAGING_DIR   promoted CLI export output (default: /exports/current)
#   READY_FILE    export-completion flag (default: <staging-parent>/.ready)
#   LOCK_DIR      shared export/sync lock (default: <staging-parent>/.lock)
#
# Exit codes: 0 = success (including "nothing changed"), 1 = real failure
# (including secret detection — Coolify records the task as failed).

set -eu

REPO_DIR="${REPO_DIR:-/repo}"
STAGING_DIR="${STAGING_DIR:-/exports/current}"
READY_FILE="${READY_FILE:-$(dirname "$STAGING_DIR")/.ready}"
LOCK_DIR="${LOCK_DIR:-$(dirname "$READY_FILE")/.lock}"
WORKFLOWS_SUBDIR="workflows"
GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_REPO_URL="${GIT_REPO_URL:?set GIT_REPO_URL}"
GIT_TOKEN="${GIT_TOKEN:?set GIT_TOKEN}"
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-autopilot-export}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-autopilot-export@localhost}"
LOCK_HELD=0
export GIT_TERMINAL_PROMPT=0

log()  { printf '[git-sync] %s\n' "$*"; }
fail() { printf '[git-sync] ERROR: %s\n' "$*" >&2; exit 1; }

release_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
      log "ERROR: could not release export lock $LOCK_DIR" >&2
    fi
    LOCK_HELD=0
  fi
}

acquire_lock() {
  [ "$LOCK_DIR" != "/" ] || fail "refusing to use / as the export lock"
  [ "$LOCK_DIR" != "$STAGING_DIR" ] || fail "export lock must not be the staging directory"
  [ "$LOCK_DIR" != "$READY_FILE" ] || fail "export lock must not be the completion marker"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "export lock $LOCK_DIR is held; refusing to overlap an export or sync"
  fi
  LOCK_HELD=1
  if ! chmod 777 "$LOCK_DIR" 2>/dev/null; then
    release_lock
    fail "could not make export lock $LOCK_DIR accessible to both containers"
  fi
}

# This lock is the synchronization boundary shared with the n8n-side export.
# It is fail-closed so a stale lock must be removed only after an operator has
# verified that no export or sync task is still running.
trap 'release_lock' 0
trap 'exit 1' HUP INT TERM

command -v git >/dev/null 2>&1 || fail "git not found"

# --- 1. Fresh checkout -------------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  log "no checkout at $REPO_DIR — cloning $GIT_BRANCH"
  # $REPO_DIR is a volume mountpoint: removing it outright fails with
  # "Resource busy", so clear its contents instead (empty on first run,
  # stale/corrupt after a failed clone) and clone into the emptied dir.
  mkdir -p "$REPO_DIR"
  find "$REPO_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  git clone --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$REPO_DIR" \
    || fail "clone failed (check GIT_REPO_URL and token/visibility)"
fi
cd "$REPO_DIR"
git config --global --add safe.directory "$REPO_DIR" 2>/dev/null || true
git fetch origin || fail "fetch failed"
# -B: (re)create local branch exactly at the remote tip, discarding drift.
git checkout -B "$GIT_BRANCH" "origin/$GIT_BRANCH"
git reset --hard "origin/$GIT_BRANCH"

# --- 2. Staging permissions (exporter is root; n8n writes as node) ------------
# Both the staging dir AND its parent: on a fresh export_staging volume the
# export task (n8n container, unprivileged node user) must create
# /exports/next and /exports/.ready inside the parent before this script ever
# promotes anything into $STAGING_DIR. Without the parent chmod the very
# first export fails with permission denied.
STAGING_PARENT="$(dirname "$STAGING_DIR")"
# Never chmod the filesystem root even under a pathological STAGING_DIR.
[ "$STAGING_PARENT" != "/" ] || fail "refusing to chmod / (check STAGING_DIR)"

# Establish only the parent before locking. Recreating a missing current
# directory here would turn an export's in-progress state into a false empty
# snapshot, so no shared snapshot path is touched until the lock is held.
mkdir -p "$STAGING_PARENT"

# Hold the shared lock before inspecting/chmodding the staging directory, then
# keep it through the first marker read, commit/push, and marker consumption.
# The exporter cannot replace current while this snapshot is live.
acquire_lock

[ -d "$STAGING_DIR" ] || fail "staged snapshot directory $STAGING_DIR missing — refusing to sync"
chmod 777 "$STAGING_DIR" "$STAGING_PARENT"

# --- 3. Require the export-completion flag ------------------------------------
# The export task writes /exports/next, promotes it to /exports/current (empty
# when the instance has zero workflows), and creates .ready last. No flag
# means no complete snapshot exists (export failed or never ran) — never sync.
[ -f "$READY_FILE" ] || fail "completion flag $READY_FILE missing — refusing to sync (export task may have failed or not run yet)"
READY_TOKEN="$(cat "$READY_FILE" 2>/dev/null)" || fail "could not read completion flag $READY_FILE — refusing to sync"

verify_ready() {
  [ -f "$READY_FILE" ] || fail "completion flag $READY_FILE disappeared during sync — refusing to commit"
  CURRENT_READY_TOKEN="$(cat "$READY_FILE" 2>/dev/null)" || fail "could not reread completion flag $READY_FILE — refusing to commit"
  [ "$CURRENT_READY_TOKEN" = "$READY_TOKEN" ] || fail "completion flag $READY_FILE changed during sync — refusing to commit"
}

# --- 4. Staged snapshot (may be legitimately empty) ---------------------------
# .ready is authoritative: it guarantees /exports/current is a COMPLETE
# snapshot of the instance, including the valid zero-workflow case. An empty
# snapshot means "delete every tracked workflow JSON" (the last workflow was
# deleted in n8n). Missing .ready — not emptiness — is what guards against
# partial exports.
count=0
for f in "$STAGING_DIR"/*.json; do
  [ -e "$f" ] || continue
  count=$((count + 1))
done
log "staged snapshot ready (flag $READY_FILE present): $count workflow file(s)"

# --- 5. Replace workflows/*.json with the staged snapshot ----------------------
# rm -f tolerates an unmatched glob; cp is guarded so a zero-file snapshot
# deletes all tracked JSONs instead of erroring on an empty glob.
mkdir -p "$WORKFLOWS_SUBDIR"
rm -f "$WORKFLOWS_SUBDIR"/*.json
for f in "$STAGING_DIR"/*.json; do
  [ -e "$f" ] || continue
  cp "$f" "$WORKFLOWS_SUBDIR"/
done

normalize_one() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PYEOF'
import json, sys
p = sys.argv[1]
with open(p, encoding="utf-8") as fh:
    data = json.load(fh)
with open(p, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2, sort_keys=True, ensure_ascii=False)
    fh.write("\n")
PYEOF
  elif command -v jq >/dev/null 2>&1; then
    jq -S '.' "$1" > "$1.tmp" && mv "$1.tmp" "$1"
  elif command -v perl >/dev/null 2>&1; then
    perl -MJSON::PP -0777 -pi -e '$_ = JSON::PP->new->utf8->canonical->pretty->encode(JSON::PP->new->utf8->decode($_))' "$1"
  else
    log "no python3/jq/perl — keeping CLI --pretty output as-is: $1"
  fi
}
for f in "$WORKFLOWS_SUBDIR"/*.json; do
  [ -e "$f" ] || continue
  normalize_one "$f"
done

# --- 6. Secret scan (FAIL-CLOSED, before git add) -------------------------------
# Any likely secret aborts with a non-zero exit so Coolify marks the task as
# failed and nothing is committed or pushed. Only the file path, line number,
# and detection category are reported — the suspected value is NEVER printed.
# If legitimate content trips the scan later, add a narrow explicit allowlist
# (file + category); do not weaken these patterns globally.
if [ "$count" -gt 0 ]; then
  log "scanning for secret-looking patterns…"
  scan_hits=""
  check_category() {
    _cat="$1"; _pat="$2"
    # BusyBox grep (alpine/git) has no --include option: scope to workflow
    # JSONs via the shell glob instead. A non-matching glob stays literal and
    # grep errors (suppressed) — equivalent to "no files matched".
    # Fail CLOSED on grep errors (exit >= 2): only exit 0 (hits) and exit 1
    # (no hits) may proceed. An errored scan must never read as a clean scan.
    set +e
    _files="$(grep -rlinE "$_pat" "$WORKFLOWS_SUBDIR"/*.json 2>/dev/null)"
    _rc=$?
    set -e
    [ "$_rc" -le 1 ] || fail "secret scan errored (grep exit $_rc, category $_cat) — refusing to sync"
    if [ -n "$_files" ]; then
      for _f in $_files; do
        _lines="$(grep -nEoi "$_pat" "$_f" | cut -d: -f1 | tr '\n' ',' | sed 's/,$//')"
        [ -n "$_lines" ] || fail "secret scan errored (no match lines for $_f, category $_cat) — refusing to sync"
        log "BLOCKED: $_f (category: $_cat, line(s): $_lines)"
        scan_hits="${scan_hits} ${_f}:${_cat}"
      done
    fi
  }
  check_category "authorization-header" '"authorization"'
  check_category "bearer-token" 'bearer [A-Za-z0-9._~+/-]{16,}'
  check_category "api-key-header" 'x-api-key'
  check_category "client-secret" 'client[_-]?secret'
  check_category "aws-secret" 'aws_secret'
  check_category "private-key" 'BEGIN [A-Z ]*PRIVATE KEY'
  if [ -n "$scan_hits" ]; then
    fail "secret scan BLOCKED the sync — remove/anonymize the flagged content in n8n and re-export. Do not force-push."
  fi
  log "scan clean"
else
  log "empty snapshot — nothing to scan"
fi

# --- 7. Confirm the snapshot identity after staging ----------------------------
# The shared lock blocks the cooperating exporter for the whole sync. The token
# comparison is a second defense against an out-of-band marker replacement.
verify_ready

# --- 8. Commit + push only on real change --------------------------------------
git add "$WORKFLOWS_SUBDIR"
verify_ready
if git diff --cached --quiet; then
  log "no workflow changes — nothing to commit"
  rm -f "$READY_FILE"
  log "consumed $READY_FILE"
  exit 0
fi

STAMP="$(date -u '+%Y-%m-%d %H:%M UTC')"
CHANGED="$(git diff --cached --name-only | tr '\n' ' ')"
git -c user.name="$GIT_AUTHOR_NAME" \
    -c user.email="$GIT_AUTHOR_EMAIL" \
    commit -m "chore(workflows): export ${STAMP} (${count} file(s))" \
             -m "Changed: ${CHANGED}" >/dev/null
log "committed: $CHANGED"

# Token via in-memory credential helper: never written to .git/config, never
# embedded in the remote URL, never shown in ps output beyond the env itself.
git -c credential.helper='!f() { printf "username=%s\npassword=%s\n" "x-access-token" "$GIT_TOKEN"; }; f' \
    push origin "HEAD:$GIT_BRANCH"
log "pushed to origin/$GIT_BRANCH"
# Consume the flag only now: each export is synced at most once, while a
# failed push keeps .ready so the next run retries the same complete set.
rm -f "$READY_FILE"
log "consumed $READY_FILE"
log "done"
