#!/bin/sh
#
# test-export-protocol.sh — exercise the workflow export + sync protocol
# end-to-end against a local file:// "remote" and a fake `n8n` CLI. No network,
# no real n8n, no GitHub. Intended to run inside the pinned alpine/git image
# (git + sh only, matching the exporter) so the scripts under test see the
# same BusyBox tools they get in production.
#
# Run (alpine/git defaults to the `git` entrypoint, so override it to sh):
#   docker run --rm --entrypoint sh -v "$PWD:/src:ro" \
#     alpine/git:2.54.0 /src/tests/test-export-protocol.sh
#
# Cases:
#   1. 1 workflow -> 0 workflows commits deletion of the final JSON
#   2. 0 workflows -> 0 workflows produces no commit and consumes .ready
#   3. real export error with partial files -> no .ready, no Git deletion
#   4. normal multi-workflow deletion still works
#   + export script unit cases (success / empty / hard-failure)
#   + shared-lock/marker-identity overlap cases
#   + promotion journal and rollback fault-injection cases

set -u

SRC="${SRC:-/src}"
GIT_SYNC="$SRC/scripts/git-sync.sh"
EXPORT="$SRC/scripts/export-workflows.sh"
REAL_GIT="$(command -v git)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' 0

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
PATH="$FAKE_BIN:$PATH"
export PATH

pass=0
fail=0

ok()  { pass=$((pass + 1)); printf 'ok   - %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf 'FAIL - %s\n' "$*"; }

# --- fake n8n CLI -------------------------------------------------------------
cat > "$FAKE_BIN/n8n" <<'FAKE'
#!/bin/sh
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "--output" ] && out="$a"
  prev="$a"
done
case "${FAKE_N8N_MODE:-success}" in
  empty)
    echo "No workflows found with specified filters" >&2
    exit 1
    ;;
  error)
    echo "boom: simulated export failure" >&2
    exit 3
    ;;
  partial)
    mkdir -p "$out"
    printf '{"name":"partial","nodes":[]}\n' > "$out/partial.json"
    echo "boom: simulated export failure" >&2
    exit 4
    ;;
  empty-partial)
    mkdir -p "$out"
    printf '{"name":"partial","nodes":[]}\n' > "$out/partial.json"
    echo "No workflows found with specified filters" >&2
    exit 1
    ;;
  empty-hidden)
    mkdir -p "$out"
    printf '{"name":"hidden","nodes":[]}\n' > "$out/.hidden.json"
    echo "No workflows found with specified filters" >&2
    exit 1
    ;;
  *)
    mkdir -p "$out"
    printf '{"name":"wf-a","nodes":[]}\n' > "$out/wf-a.json"
    printf '{"name":"wf-b","nodes":[]}\n' > "$out/wf-b.json"
    exit 0
    ;;
esac
FAKE
chmod +x "$FAKE_BIN/n8n"

# --- helpers ------------------------------------------------------------------
seed_remote() {
  # $1 = remote path; remaining args = workflow names to seed
  r="$1"; shift
  git init -q --bare -b main "$r"
  seed="$WORK/seed"
  rm -rf "$seed"
  mkdir -p "$seed/workflows"
  touch "$seed/workflows/.gitkeep"   # guarantees an initial commit even with 0 workflows
  for n in "$@"; do
    printf '{"name":"%s","nodes":[]}\n' "$n" > "$seed/workflows/$n.json"
  done
  git -C "$seed" init -q
  git -C "$seed" config user.name test
  git -C "$seed" config user.email test@local
  git -C "$seed" add .
  git -C "$seed" commit -qm seed
  git -C "$seed" branch -M main
  git -C "$seed" remote add origin "file://$r"
  git -C "$seed" push -q origin main
  rm -rf "$seed"
}

remote_workflows() { # $1 = remote path — list tracked workflow JSONs
  git --git-dir="$1" ls-tree --name-only HEAD -- workflows/ 2>/dev/null | grep '\.json$'
}

remote_head() { # $1 = remote path
  git --git-dir="$1" rev-parse HEAD
}

stage() {
  # $1 = staging parent dir; remaining args = workflow names to place in current/
  s="$1"; shift
  rm -rf "$s"
  mkdir -p "$s/current"
  for n in "$@"; do
    printf '{"name":"%s","nodes":[]}\n' "$n" > "$s/current/$n.json"
  done
  touch "$s/.ready"
}

run_sync() {
  # $1 = remote path; $2 = repo dir; $3 = staging parent dir
  GIT_REPO_URL="file://$1" GIT_BRANCH=main GIT_TOKEN=dummy \
  REPO_DIR="$2" STAGING_DIR="$3/current" READY_FILE="$3/.ready" \
    sh "$GIT_SYNC" > "$3/sync.log" 2>&1
}

wait_for_file() {
  target="$1"
  attempts=0
  while [ ! -f "$target" ] && [ "$attempts" -lt 100 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  [ -f "$target" ]
}

install_git_add_pause_wrapper() {
  cat > "$FAKE_BIN/git" <<'FAKE_GIT'
#!/bin/sh
if [ "$1" = "add" ]; then
  : > "$AUTOPILOT_TEST_GIT_ADD_PAUSE"
  while [ ! -f "$AUTOPILOT_TEST_GIT_ADD_RELEASE" ]; do
    sleep 0.1
  done
fi
exec "$AUTOPILOT_REAL_GIT" "$@"
FAKE_GIT
  chmod +x "$FAKE_BIN/git"
}

# --- export script cases ------------------------------------------------------
export_success() {
  d="$WORK/exp-success"
  FAKE_N8N_MODE=success EXPORT_DIR="$d" sh "$EXPORT" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && [ -f "$d/.ready" ] && [ -f "$d/current/wf-a.json" ] && [ -f "$d/current/wf-b.json" ]
}

export_empty() {
  d="$WORK/exp-empty"
  FAKE_N8N_MODE=empty EXPORT_DIR="$d" sh "$EXPORT" >/dev/null 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && [ -f "$d/.ready" ] && [ -d "$d/current" ] && [ -z "$(ls -A "$d/current" 2>/dev/null)" ]
}

export_hard_failure_preserves_current() {
  d="$WORK/exp-hard"
  mkdir -p "$d/current"
  printf 'sentinel\n' > "$d/current/prev.json"
  touch "$d/.ready"   # pre-existing pending snapshot that must survive a failure
  FAKE_N8N_MODE=partial EXPORT_DIR="$d" sh "$EXPORT" >/dev/null 2>&1
  rc=$?
  # non-zero exit, .ready PRESERVED, current still holds the sentinel
  [ "$rc" -ne 0 ] && [ -f "$d/.ready" ] && [ -f "$d/current/prev.json" ]
}

export_empty_phrase_with_partial_files_is_hard_failure() {
  d="$WORK/exp-empty-partial"
  mkdir -p "$d/current"
  printf 'sentinel\n' > "$d/current/prev.json"
  FAKE_N8N_MODE=empty-partial EXPORT_DIR="$d" sh "$EXPORT" >/dev/null 2>&1
  rc=$?
  # the zero-workflow phrase plus a partial file must NOT become a deletion
  [ "$rc" -ne 0 ] && [ ! -f "$d/.ready" ] && [ -f "$d/current/prev.json" ]
}

export_empty_phrase_with_hidden_file_is_hard_failure() {
  d="$WORK/exp-empty-hidden"
  mkdir -p "$d/current"
  printf 'sentinel\n' > "$d/current/prev.json"
  FAKE_N8N_MODE=empty-hidden EXPORT_DIR="$d" sh "$EXPORT" >/dev/null 2>&1
  rc=$?
  # a hidden partial file must still defeat the empty-snapshot match
  [ "$rc" -ne 0 ] && [ ! -f "$d/.ready" ] && [ -f "$d/current/prev.json" ]
}

seed_pending_snapshot() {
  d="$1"
  mkdir -p "$d/current"
  printf 'prior\n' > "$d/current/prior.json"
  printf 'prior-token\n' > "$d/.ready"
}

assert_pending_snapshot() {
  d="$1"
  [ -f "$d/current/prior.json" ] \
    && [ "$(cat "$d/current/prior.json")" = "prior" ] \
    && [ -f "$d/.ready" ] \
    && [ "$(cat "$d/.ready")" = "prior-token" ] \
    && [ ! -e "$d/.lock" ] \
    && [ ! -e "$d/.promotion" ] \
    && [ ! -e "$d/.promotion.new" ]
}

export_forward_faults_preserve_previous() {
  for failpoint in \
    move-ready-to-backup \
    move-current-to-old \
    move-next-to-current \
    write-ready-temp \
    move-ready-into-place; do
    d="$WORK/fault-$failpoint"
    seed_pending_snapshot "$d"
    rc=0
    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT="$failpoint" EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
    [ "$rc" -ne 0 ] || return 1
    assert_pending_snapshot "$d" || return 1
  done
  return 0
}

export_cleanup_failures_keep_published_pair() {
  for failpoint in cleanup-ready-backup cleanup-old-current; do
    d="$WORK/cleanup-$failpoint"
    seed_pending_snapshot "$d"
    rc=0
    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT="$failpoint" EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
    [ "$rc" -ne 0 ] \
      && [ -f "$d/.ready" ] \
      && [ -f "$d/current/wf-a.json" ] \
      && [ -f "$d/current/wf-b.json" ] \
      && [ -f "$d/current.old/prior.json" ] || return 1

    # The published pair may be consumed before the next export task gets to
    # clean its journal. Recovery must not mistake that consumed marker for an
    # interrupted pre-commit promotion.
    rm -f "$d/.ready" || return 1

    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT= EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/retry.log" 2>&1 || return 1
    [ -f "$d/.ready" ] \
      && [ -f "$d/current/wf-a.json" ] \
      && [ -f "$d/current/wf-b.json" ] \
      && [ ! -e "$d/current.old" ] \
      && [ ! -e "$d/.ready.old" ] || return 1
  done
  return 0
}

export_journal_failures_recover_after_marker_consumption() {
  for failpoint in write-txn-published move-txn-published cleanup-txn; do
    d="$WORK/journal-$failpoint"
    seed_pending_snapshot "$d"
    rc=0
    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT="$failpoint" EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
    [ "$rc" -ne 0 ] \
      && [ -f "$d/current/wf-a.json" ] \
      && [ -f "$d/.ready" ] || return 1
    rm -f "$d/.ready" || return 1

    # Force the retry to stop after recovery. The already-published current
    # must survive even though its marker was consumed before recovery ran.
    rc=0
    FAKE_N8N_MODE=error AUTOPILOT_TEST_FAIL_AT= EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/retry.log" 2>&1 || rc=$?
    [ "$rc" -ne 0 ] \
      && [ -f "$d/current/wf-a.json" ] \
      && [ ! -e "$d/current.old" ] \
      && [ ! -e "$d/.ready.old" ] \
      && [ ! -e "$d/.promotion" ] \
      && [ ! -e "$d/.promotion.new" ] || return 1
  done
  return 0
}

export_rollback_failures_recover_on_retry() {
  for failpoints in \
    write-ready-temp,rollback-remove-new-current \
    write-ready-temp,rollback-restore-current \
    write-ready-temp,rollback-restore-ready; do
    d="$WORK/rollback-$failpoints"
    seed_pending_snapshot "$d"
    rc=0
    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT="$failpoints" EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
    [ "$rc" -ne 0 ] \
      && [ ! -f "$d/.ready" ] \
      && { [ -e "$d/current.old" ] || [ -e "$d/.ready.old" ]; } || return 1

    FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT= EXPORT_DIR="$d" \
      sh "$EXPORT" > "$d/retry.log" 2>&1 || return 1
    [ -f "$d/.ready" ] \
      && [ -f "$d/current/wf-a.json" ] \
      && [ -f "$d/current/wf-b.json" ] \
      && [ ! -e "$d/current.old" ] \
      && [ ! -e "$d/.ready.old" ] || return 1
  done
  return 0
}

export_recovery_cleanup_failure_is_safe() {
  d="$WORK/recovery-cleanup"
  seed_pending_snapshot "$d"
  mkdir -p "$d/current.old"
  printf 'stale\n' > "$d/current.old/stale.json"

  rc=0
  FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT=recover-cleanup-old EXPORT_DIR="$d" \
    sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
  [ "$rc" -ne 0 ] \
    && assert_pending_snapshot "$d" \
    && [ -f "$d/current.old/stale.json" ] || return 1

  FAKE_N8N_MODE=success AUTOPILOT_TEST_FAIL_AT= EXPORT_DIR="$d" \
    sh "$EXPORT" > "$d/retry.log" 2>&1 || return 1
  [ -f "$d/.ready" ] \
    && [ -f "$d/current/wf-a.json" ] \
    && [ ! -e "$d/current.old" ]
}

export_recovery_does_not_restore_marker_without_current() {
  r="$WORK/remote-recovery-missing-current"; seed_remote "$r" wf-old
  d="$WORK/recovery-missing-current"; mkdir -p "$d"
  printf 'prior-token\n' > "$d/.ready.old"

  rc=0
  FAKE_N8N_MODE=error AUTOPILOT_TEST_FAIL_AT= EXPORT_DIR="$d" \
    sh "$EXPORT" > "$d/export.log" 2>&1 || rc=$?
  sync_rc=0
  run_sync "$r" "$WORK/repo-recovery-missing-current" "$d" || sync_rc=$?
  [ "$rc" -ne 0 ] \
    && [ "$sync_rc" -ne 0 ] \
    && [ ! -e "$d/.ready" ] \
    && [ -f "$d/.ready.old" ] \
    && [ ! -e "$d/current" ] \
    && printf '%s\n' "$(remote_workflows "$r")" | grep -q 'wf-old.json'
}

# --- git-sync cases -----------------------------------------------------------
sync_deletes_final_workflow() {
  r="$WORK/remote-1to0"; seed_remote "$r" wf-final
  repo="$WORK/repo-1to0"; stage="$WORK/stage-1to0"
  stage "$stage"                 # empty snapshot + .ready
  run_sync "$r" "$repo" "$stage"
  rc=$?
  [ "$rc" -eq 0 ] && [ -z "$(remote_workflows "$r")" ] && [ ! -f "$stage/.ready" ]
}

sync_empty_to_empty_no_commit() {
  r="$WORK/remote-0to0"; seed_remote "$r"   # seed zero workflows
  before="$(remote_head "$r")"
  repo="$WORK/repo-0to0"; stage="$WORK/stage-0to0"
  stage "$stage"
  run_sync "$r" "$repo" "$stage"
  rc=$?
  after="$(remote_head "$r")"
  [ "$rc" -eq 0 ] && [ "$before" = "$after" ] && [ ! -f "$stage/.ready" ]
}

sync_multi_workflow_deletion() {
  r="$WORK/remote-multi"; seed_remote "$r" wf-a wf-b
  repo="$WORK/repo-multi"; stage="$WORK/stage-multi"
  stage "$stage" wf-a           # only wf-a survives; wf-b must be deleted
  run_sync "$r" "$repo" "$stage"
  rc=$?
  rem="$(remote_workflows "$r")"
  [ "$rc" -eq 0 ] && printf '%s\n' "$rem" | grep -q 'wf-a.json' && ! printf '%s\n' "$rem" | grep -q 'wf-b.json' && [ ! -f "$stage/.ready" ]
}

sync_refuses_without_ready() {
  # a failed export leaves no .ready -> sync must refuse and change nothing
  r="$WORK/remote-noready"; seed_remote "$r" wf-final
  repo="$WORK/repo-noready"; stage="$WORK/stage-noready"
  mkdir -p "$stage/current"      # partial files present, but no .ready
  printf '{"name":"partial","nodes":[]}\n' > "$stage/current/partial.json"
  run_sync "$r" "$repo" "$stage"
  rc=$?
  [ "$rc" -ne 0 ] && [ -n "$(remote_workflows "$r")" ]
}

sync_refuses_missing_current_with_ready() {
  r="$WORK/remote-missing-current"; seed_remote "$r" wf-old
  d="$WORK/stage-missing-current"; mkdir -p "$d"
  printf 'snapshot-token\n' > "$d/.ready"
  before="$(remote_head "$r")"
  run_sync "$r" "$WORK/repo-missing-current" "$d"
  rc=$?
  [ "$rc" -ne 0 ] \
    && [ "$before" = "$(remote_head "$r")" ] \
    && [ -f "$d/.ready" ] \
    && [ ! -e "$d/current" ]
}

sync_export_overlap_cannot_replace_snapshot() {
  r="$WORK/remote-overlap"; seed_remote "$r" wf-old
  repo="$WORK/repo-overlap"; stage_dir="$WORK/stage-overlap"
  stage "$stage_dir" wf-new
  before="$(remote_head "$r")"
  pause="$WORK/overlap.pause"; release="$WORK/overlap.release"
  install_git_add_pause_wrapper

  (
    export AUTOPILOT_REAL_GIT="$REAL_GIT"
    export AUTOPILOT_TEST_GIT_ADD_PAUSE="$pause"
    export AUTOPILOT_TEST_GIT_ADD_RELEASE="$release"
    run_sync "$r" "$repo" "$stage_dir"
  ) > "$stage_dir/sync.log" 2>&1 &
  sync_pid=$!
  if ! wait_for_file "$pause"; then
    : > "$release"
    wait "$sync_pid" 2>/dev/null || true
    rm -f "$FAKE_BIN/git"
    return 1
  fi

  export_rc=0
  FAKE_N8N_MODE=success EXPORT_DIR="$stage_dir" sh "$EXPORT" > "$stage_dir/export.log" 2>&1 || export_rc=$?
  still_pending=false
  if [ "$export_rc" -ne 0 ] \
    && [ "$before" = "$(remote_head "$r")" ] \
    && [ -f "$stage_dir/.ready" ] \
    && [ -f "$stage_dir/current/wf-new.json" ]; then
    still_pending=true
  fi

  : > "$release"
  sync_rc=0
  wait "$sync_pid" || sync_rc=$?
  rm -f "$FAKE_BIN/git"

  [ "$still_pending" = true ] \
    && [ "$sync_rc" -eq 0 ] \
    && printf '%s\n' "$(remote_workflows "$r")" | grep -q 'wf-new.json' \
    && ! printf '%s\n' "$(remote_workflows "$r")" | grep -q 'wf-old.json'
}

sync_rejects_marker_replacement_after_initial_check() {
  r="$WORK/remote-marker-replacement"; seed_remote "$r" wf-old
  repo="$WORK/repo-marker-replacement"; stage_dir="$WORK/stage-marker-replacement"
  stage "$stage_dir" wf-new
  before="$(remote_head "$r")"
  pause="$WORK/marker.pause"; release="$WORK/marker.release"
  install_git_add_pause_wrapper

  (
    export AUTOPILOT_REAL_GIT="$REAL_GIT"
    export AUTOPILOT_TEST_GIT_ADD_PAUSE="$pause"
    export AUTOPILOT_TEST_GIT_ADD_RELEASE="$release"
    run_sync "$r" "$repo" "$stage_dir"
  ) > "$stage_dir/sync.log" 2>&1 &
  sync_pid=$!
  if ! wait_for_file "$pause"; then
    : > "$release"
    wait "$sync_pid" 2>/dev/null || true
    rm -f "$FAKE_BIN/git"
    return 1
  fi

  printf 'replacement-token\n' > "$stage_dir/.ready"
  : > "$release"
  sync_rc=0
  wait "$sync_pid" || sync_rc=$?
  rm -f "$FAKE_BIN/git"

  [ "$sync_rc" -ne 0 ] \
    && [ "$before" = "$(remote_head "$r")" ] \
    && [ -f "$stage_dir/.ready" ]
}

sync_does_not_recreate_current_while_export_holds_lock() {
  r="$WORK/remote-current-absent"; seed_remote "$r" wf-old
  repo="$WORK/repo-current-absent"; stage_dir="$WORK/stage-current-absent"
  mkdir -p "$stage_dir"
  before="$(remote_head "$r")"
  mkdir "$stage_dir/.lock"

  sync_rc=0
  run_sync "$r" "$repo" "$stage_dir" > "$stage_dir/sync.log" 2>&1 || sync_rc=$?
  rmdir "$stage_dir/.lock"

  [ "$sync_rc" -ne 0 ] \
    && [ "$before" = "$(remote_head "$r")" ] \
    && [ ! -d "$stage_dir/current" ]
}

# --- run ----------------------------------------------------------------------
export_success                      && ok "export: success promotes current + .ready"                    || bad "export: success promotes current + .ready"
export_empty                        && ok "export: zero workflows promotes empty current + .ready"       || bad "export: zero workflows promotes empty current + .ready"
export_hard_failure_preserves_current && ok "export: hard failure keeps current + .ready, non-zero"     || bad "export: hard failure keeps current + .ready, non-zero"
export_empty_phrase_with_partial_files_is_hard_failure && ok "export: empty-phrase + partial file is hard failure" || bad "export: empty-phrase + partial file is hard failure"
export_empty_phrase_with_hidden_file_is_hard_failure && ok "export: empty-phrase + hidden file is hard failure" || bad "export: empty-phrase + hidden file is hard failure"
sync_deletes_final_workflow         && ok "sync: 1->0 commits deletion of final JSON"                    || bad "sync: 1->0 commits deletion of final JSON"
sync_empty_to_empty_no_commit       && ok "sync: 0->0 no commit, consumes .ready"                        || bad "sync: 0->0 no commit, consumes .ready"
sync_multi_workflow_deletion        && ok "sync: multi-workflow deletion"                                 || bad "sync: multi-workflow deletion"
sync_refuses_without_ready          && ok "sync: refuses without .ready (no deletion)"                   || bad "sync: refuses without .ready (no deletion)"
sync_export_overlap_cannot_replace_snapshot && ok "sync/export: lock blocks overlap"                       || bad "sync/export: lock blocks overlap"
sync_rejects_marker_replacement_after_initial_check && ok "sync: rejects marker replacement"                || bad "sync: rejects marker replacement"
sync_does_not_recreate_current_while_export_holds_lock && ok "sync: does not recreate current before lock"    || bad "sync: does not recreate current before lock"
export_forward_faults_preserve_previous            && ok "export: rename faults preserve prior pair"        || bad "export: rename faults preserve prior pair"
export_cleanup_failures_keep_published_pair         && ok "export: cleanup faults keep published pair"       || bad "export: cleanup faults keep published pair"
export_rollback_failures_recover_on_retry           && ok "export: rollback faults recover on retry"         || bad "export: rollback faults recover on retry"
export_recovery_cleanup_failure_is_safe              && ok "export: recovery cleanup fault is safe"           || bad "export: recovery cleanup fault is safe"
export_journal_failures_recover_after_marker_consumption && ok "export: journal survives consumed marker"       || bad "export: journal survives consumed marker"
export_recovery_does_not_restore_marker_without_current && ok "export: no marker without current"              || bad "export: no marker without current"
sync_refuses_missing_current_with_ready             && ok "sync: refuses missing current even with marker"   || bad "sync: refuses missing current even with marker"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
