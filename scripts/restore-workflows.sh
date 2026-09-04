#!/bin/sh
#
# restore-workflows.sh — stage committed workflow JSONs for re-import into n8n.
#
# Runs INSIDE the exporter sidecar (git + sh only). It cannot import directly:
# only the n8n container owns the SQLite DB, so restore is two steps:
#
#   Step 1 (exporter — this script): copy JSONs from Git history to staging:
#     sh /repo/scripts/restore-workflows.sh --file <name>.json
#     sh /repo/scripts/restore-workflows.sh --all [--commit <ref>]
#
#   Step 2 (n8n container — Coolify Scheduled Task with a pasted command,
#   or "Execute Now" for a one-off restore):
#     n8n import:workflow --separate --input /exports/restore
#
# Official n8n semantics (not our choice, see docs/RESTORE.md):
#   - Imported workflows arrive DEACTIVATED; verify then activate in the UI.
#   - Workflow JSON holds credential NAMES/IDs, never secret values — recreate
#     secrets in the UI and re-link nodes after import.
#   - Importing over an existing ID OVERWRITES that workflow.
#
# Usage:
#   restore-workflows.sh --file NAME.json [--commit REF]
#   restore-workflows.sh --all [--commit REF]
#   --commit defaults to origin/<branch> tip (fetched first).
#
# Env: REPO_DIR (default /repo), RESTORE_DIR (default /exports/restore),
#      GIT_REPO_URL, GIT_BRANCH (default main). No push token needed (read-only).

set -eu

REPO_DIR="${REPO_DIR:-/repo}"
RESTORE_DIR="${RESTORE_DIR:-/exports/restore}"
GIT_BRANCH="${GIT_BRANCH:-main}"
GIT_REPO_URL="${GIT_REPO_URL:?set GIT_REPO_URL}"
export GIT_TERMINAL_PROMPT=0

MODE=""
ONLY_FILE=""
COMMIT_REF=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all)  MODE="all"; shift ;;
    --file) ONLY_FILE="${2:?--file needs a filename}"; MODE="file"; shift 2 ;;
    --commit) COMMIT_REF="${2:?--commit needs a git ref}"; shift 2 ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[ -n "$MODE" ] || { printf 'Usage: %s --file NAME.json|--all [--commit REF]\n' "$0" >&2; exit 1; }

log()  { printf '[restore-workflows] %s\n' "$*"; }
fail() { printf '[restore-workflows] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git not found"
[ -d "$REPO_DIR/.git" ] || fail "no checkout at $REPO_DIR (run git-sync once first, or clone $GIT_REPO_URL)"
cd "$REPO_DIR"
git fetch origin || fail "fetch failed"
REF="${COMMIT_REF:-origin/$GIT_BRANCH}"
git cat-file -e "$REF" 2>/dev/null || fail "ref '$REF' not found after fetch"

rm -rf "$RESTORE_DIR"
mkdir -p "$RESTORE_DIR"

if [ "$MODE" = "file" ]; then
  git show "$REF:workflows/$ONLY_FILE" > "$RESTORE_DIR/$ONLY_FILE" \
    || fail "workflows/$ONLY_FILE not present at $REF"
  log "staged: $ONLY_FILE (from $REF)"
else
  count=0
  for f in $(git ls-tree --name-only "$REF" -- workflows/); do
    case "$f" in *.json) ;; *) continue ;; esac
    git show "$REF:$f" > "$RESTORE_DIR/$(basename "$f")"
    count=$((count + 1))
  done
  [ "$count" -gt 0 ] || fail "no workflow JSONs at $REF"
  log "staged $count workflow file(s) (from $REF)"
fi

log "STEP 2: run this in the n8n container (Scheduled Task command or Execute Now):"
log "  n8n import:workflow --separate --input /exports/restore"
log "then in the UI: recreate credential secrets, re-link nodes, test, activate."
