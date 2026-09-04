#!/bin/sh
#
# export-workflows.sh — export n8n workflows and promote a complete snapshot.
#
# Runs INSIDE the n8n container (the only place with the n8n Server CLI +
# SQLite; runs as the unprivileged `node` user). The exporter sidecar bakes
# this file into its image and copies it into the shared export_staging volume
# at startup (see Dockerfile.exporter), so the Coolify export task runs it
# with:
#
#   sh /exports/export-workflows.sh
#
# Why a script instead of a `&&` one-liner: `n8n export:workflow --all` exits
# non-zero with "No workflows found with specified filters" when the instance
# is empty. That is a VALID state (the user deleted the last workflow), not an
# error — but a naive `&&` chain treats it as failure and never writes .ready,
# so Git never records the deletion. This script distinguishes three outcomes:
#
#   1. success           -> promote /exports/next -> current, write .ready
#   2. zero workflows    -> promote an EMPTY current, write .ready
#   3. any other failure -> leave current + .ready untouched, exit non-zero
#
# Failure-state safety:
#   - `.ready` carries a snapshot token (not just presence), so git-sync can
#     detect that a new export superseded the snapshot mid-sync.
#   - Both tasks take the same atomic `.lock` on the shared volume; the exporter
#     holds it through CLI export and promotion, while git-sync holds it from
#     marker read through push and marker consumption.
#   - The previous current and marker are journaled as `.old` files. The new
#     marker is written to a temporary file and renamed only after current is
#     complete; failures restore the journal or leave readiness absent for
#     recovery on the next export.

set -eu

EXPORT_DIR="${EXPORT_DIR:-/exports}"
NEXT_DIR="${NEXT_DIR:-$EXPORT_DIR/next}"
CURRENT_DIR="${CURRENT_DIR:-$EXPORT_DIR/current}"
READY_FILE="${READY_FILE:-$EXPORT_DIR/.ready}"
LOCK_DIR="${LOCK_DIR:-$EXPORT_DIR/.lock}"
OLD_DIR="${CURRENT_DIR}.old"
READY_BACKUP="${READY_FILE}.old"
READY_TMP="${READY_FILE}.new"
TXN_FILE="$EXPORT_DIR/.promotion"
TXN_TMP="$TXN_FILE.new"
LOCK_HELD=0
TEST_FAIL_AT="${AUTOPILOT_TEST_FAIL_AT:-}"

log() { printf '[export] %s\n' "$*"; }
fail() { printf '[export] ERROR: %s\n' "$*" >&2; exit 1; }

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
  [ "$LOCK_DIR" != "$EXPORT_DIR" ] || fail "export lock must not be the export directory"
  [ "$LOCK_DIR" != "$NEXT_DIR" ] || fail "export lock must not be the next directory"
  [ "$LOCK_DIR" != "$CURRENT_DIR" ] || fail "export lock must not be the current directory"
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

maybe_fail() {
  failpoint="$1"
  case ",${TEST_FAIL_AT}," in
    *,"$failpoint",*)
      log "test fault injected at $failpoint" >&2
      return 1
      ;;
  esac
  return 0
}

write_txn_phase() {
  phase="$1"
  if ! maybe_fail "write-txn-$phase"; then
    return 1
  fi
  if ! printf '%s\n' "$phase" > "$TXN_TMP"; then
    return 1
  fi
  if ! maybe_fail "move-txn-$phase"; then
    return 1
  fi
  if ! mv "$TXN_TMP" "$TXN_FILE"; then
    return 1
  fi
  return 0
}

clear_txn() {
  if [ -e "$TXN_TMP" ]; then
    if ! maybe_fail "cleanup-txn-temp"; then
      return 1
    fi
    if ! rm -f "$TXN_TMP"; then
      return 1
    fi
  fi
  if [ -e "$TXN_FILE" ]; then
    if ! maybe_fail "cleanup-txn"; then
      return 1
    fi
    if ! rm -f "$TXN_FILE"; then
      return 1
    fi
  fi
  return 0
}

finalize_published() {
  # A published pair remains authoritative even after git-sync consumes .ready.
  # The transaction phase, not marker presence, tells recovery not to roll it
  # back. Never discard journal backups unless current still exists.
  [ -d "$CURRENT_DIR" ] || return 1

  if [ -e "$READY_TMP" ]; then
    if [ -e "$READY_FILE" ]; then
      if ! maybe_fail "recover-cleanup-ready-temp"; then
        return 1
      fi
      if ! rm -f "$READY_TMP"; then
        return 1
      fi
    else
      if ! maybe_fail "recover-move-ready-into-place"; then
        return 1
      fi
      if ! mv "$READY_TMP" "$READY_FILE"; then
        return 1
      fi
    fi
  fi

  if [ -e "$READY_BACKUP" ]; then
    if ! maybe_fail "recover-cleanup-ready-backup"; then
      return 1
    fi
    if ! rm -f "$READY_BACKUP"; then
      return 1
    fi
  fi
  if [ -e "$OLD_DIR" ]; then
    if ! maybe_fail "recover-cleanup-old"; then
      return 1
    fi
    if ! rm -rf "$OLD_DIR"; then
      return 1
    fi
  fi
  return 0
}

recover_prepared() {
  # The prepared phase is before the new marker can be committed. Restore the
  # old current before restoring its marker, and refuse to restore a marker
  # when no current exists to make it meaningful.
  if [ -e "$READY_BACKUP" ]; then
    if [ -e "$READY_FILE" ]; then
      return 1
    fi
    if [ -e "$OLD_DIR" ]; then
      if [ -e "$CURRENT_DIR" ]; then
        if ! maybe_fail "recover-remove-new-current"; then
          return 1
        fi
        if ! rm -rf "$CURRENT_DIR"; then
          return 1
        fi
      fi
      if ! maybe_fail "recover-restore-current"; then
        return 1
      fi
      if ! mv "$OLD_DIR" "$CURRENT_DIR"; then
        return 1
      fi
    elif [ ! -e "$CURRENT_DIR" ]; then
      return 1
    fi
    if ! maybe_fail "recover-restore-ready"; then
      return 1
    fi
    if ! mv "$READY_BACKUP" "$READY_FILE"; then
      return 1
    fi
  elif [ ! -e "$READY_FILE" ] && [ -e "$OLD_DIR" ]; then
    if [ -e "$CURRENT_DIR" ]; then
      if ! maybe_fail "recover-remove-new-current"; then
        return 1
      fi
      if ! rm -rf "$CURRENT_DIR"; then
        return 1
      fi
    fi
    if ! maybe_fail "recover-restore-current"; then
      return 1
    fi
    if ! mv "$OLD_DIR" "$CURRENT_DIR"; then
      return 1
    fi
  elif [ -e "$READY_FILE" ] && [ -e "$OLD_DIR" ]; then
    [ -e "$CURRENT_DIR" ] || return 1
    if ! maybe_fail "recover-cleanup-old"; then
      return 1
    fi
    if ! rm -rf "$OLD_DIR"; then
      return 1
    fi
  fi
  return 0
}

# Recover a transaction left by a killed export before touching next. The
# journal distinguishes a pre-commit rollback from a published pair whose
# marker may already have been consumed by git-sync.
recover_transaction() {
  if [ -e "$TXN_FILE" ]; then
    TXN_PHASE="$(cat "$TXN_FILE" 2>/dev/null)" || return 1
    case "$TXN_PHASE" in
      published)
        if ! finalize_published; then
          return 1
        fi
        ;;
      committing)
        [ -d "$CURRENT_DIR" ] || return 1
        if [ -e "$READY_FILE" ]; then
          if ! finalize_published; then
            return 1
          fi
        elif [ -e "$READY_TMP" ]; then
          if ! maybe_fail "recover-move-ready-into-place"; then
            return 1
          fi
          if ! mv "$READY_TMP" "$READY_FILE"; then
            return 1
          fi
          if ! finalize_published; then
            return 1
          fi
        else
          # .ready was installed and consumed while cleanup was pending.
          if ! finalize_published; then
            return 1
          fi
        fi
        ;;
      prepared)
        if ! recover_prepared; then
          return 1
        fi
        ;;
      *)
        return 1
        ;;
    esac
    if ! clear_txn; then
      return 1
    fi
  else
    if ! recover_prepared; then
      return 1
    fi
  fi

  if [ -e "$READY_TMP" ]; then
    if ! maybe_fail "recover-cleanup-ready-temp"; then
      return 1
    fi
    if ! rm -f "$READY_TMP"; then
      return 1
    fi
  fi
  if [ -e "$TXN_TMP" ]; then
    if ! maybe_fail "recover-cleanup-txn-temp"; then
      return 1
    fi
    if ! rm -f "$TXN_TMP"; then
      return 1
    fi
  fi
  return 0
}

# mkdir is atomic across the shared volume. The lock is deliberately fail-closed:
# a killed container can leave it behind, so an operator must verify no task is
# running before removing a stale lock and retrying. Publishing stale data is
# worse than requiring that recovery step.
trap 'release_lock' 0
trap 'exit 1' HUP INT TERM

# The lock covers the CLI export as well as promotion. This prevents two n8n
# tasks from interleaving writes to the shared next directory.
mkdir -p "$EXPORT_DIR"
acquire_lock
if ! recover_transaction; then
  fail "could not recover a previous promotion safely — refusing to export"
fi

# Reset only the transient output dir (the CLI never cleans its target dir, so
# this rm makes a genuine workflow deletion real). Do NOT touch current or
# .ready here — they change only on a confirmed outcome.
rm -rf "$NEXT_DIR"
mkdir -p "$NEXT_DIR"

# Capture BOTH exit status and output. The `|| rc=$?` keeps `set -e` from
# aborting on the CLI's expected non-zero "zero workflows" exit.
rc=0
out="$(n8n export:workflow --all --separate --pretty --output "$NEXT_DIR" 2>&1)" || rc=$?

# Restore the previous snapshot and its marker after a failed promotion. The
# marker is restored only after the old current is known to be back in place;
# if rollback itself fails, the marker backup remains and sync stays fail-closed.
rollback() {
  rollback_rc=0
  current_safe=1

  if [ "$NEXT_MOVE_STARTED" -eq 1 ] && [ -e "$CURRENT_DIR" ]; then
    if ! maybe_fail "rollback-remove-new-current"; then
      rollback_rc=1
      current_safe=0
    elif ! rm -rf "$CURRENT_DIR"; then
      rollback_rc=1
      current_safe=0
    fi
  fi

  if [ "$CURRENT_MOVED" -eq 1 ]; then
    if [ "$current_safe" -eq 1 ]; then
      if [ ! -e "$OLD_DIR" ]; then
        rollback_rc=1
        current_safe=0
      elif ! maybe_fail "rollback-restore-current"; then
        rollback_rc=1
        current_safe=0
      elif ! mv "$OLD_DIR" "$CURRENT_DIR"; then
        rollback_rc=1
        current_safe=0
      fi
    fi
  fi

  # A failed move can leave the old current missing even though the command did
  # not return success. Do not restore readiness in that ambiguous state.
  if [ "$HAD_CURRENT" -eq 1 ] && [ "$CURRENT_MOVED" -eq 0 ] && [ ! -e "$CURRENT_DIR" ]; then
    rollback_rc=1
    current_safe=0
  fi

  if [ -e "$READY_TMP" ]; then
    if ! maybe_fail "rollback-remove-ready-temp"; then
      rollback_rc=1
    elif ! rm -f "$READY_TMP"; then
      rollback_rc=1
    fi
  fi

  if [ "$current_safe" -eq 1 ]; then
    if [ "$READY_MOVED" -eq 1 ]; then
      if [ -e "$READY_FILE" ]; then
        if ! maybe_fail "rollback-remove-new-ready"; then
          rollback_rc=1
          current_safe=0
        elif ! rm -f "$READY_FILE"; then
          rollback_rc=1
          current_safe=0
        fi
      fi
      if [ "$current_safe" -eq 1 ]; then
        if ! maybe_fail "rollback-restore-ready"; then
          rollback_rc=1
        elif ! mv "$READY_BACKUP" "$READY_FILE"; then
          rollback_rc=1
        fi
      fi
    elif [ "$HAD_READY" -eq 1 ] && [ ! -e "$READY_FILE" ]; then
      rollback_rc=1
    elif [ "$HAD_READY" -eq 0 ] && [ -e "$READY_FILE" ]; then
      if ! maybe_fail "rollback-remove-new-ready"; then
        rollback_rc=1
      elif ! rm -f "$READY_FILE"; then
        rollback_rc=1
      fi
    fi
  fi

  if [ "$rollback_rc" -eq 0 ]; then
    if ! clear_txn; then
      rollback_rc=1
    fi
  fi

  return "$rollback_rc"
}

rollback_and_fail() {
  if ! rollback; then
    log "ERROR: promotion rollback incomplete; transaction artifacts retained for recovery" >&2
  fi
  return 1
}

# Move the complete next snapshot into place under the shared lock. Every
# command is checked explicitly; the caller captures the status with errexit
# disabled around this simple function call, so BusyBox ash cannot hide a
# promotion error in conditional context.
publish_next() {
  TOKEN="$$-$(date +%s)"
  HAD_READY=0
  HAD_CURRENT=0
  READY_MOVED=0
  CURRENT_MOVED=0
  NEXT_MOVE_STARTED=0

  if [ -e "$OLD_DIR" ]; then
    if ! maybe_fail "cleanup-stale-old"; then
      return 1
    fi
    if ! rm -rf "$OLD_DIR"; then
      return 1
    fi
  fi

  if ! write_txn_phase prepared; then
    return 1
  fi

  if [ -e "$READY_FILE" ]; then
    HAD_READY=1
    if ! maybe_fail "move-ready-to-backup"; then
      if ! clear_txn; then
        log "ERROR: promotion journal cleanup failed before promotion; retry will recover" >&2
      fi
      return 1
    fi
    if ! mv "$READY_FILE" "$READY_BACKUP"; then
      rollback_and_fail
      return 1
    fi
    READY_MOVED=1
  fi

  if [ -e "$CURRENT_DIR" ]; then
    HAD_CURRENT=1
    if ! maybe_fail "move-current-to-old"; then
      rollback_and_fail
      return 1
    fi
    if ! mv "$CURRENT_DIR" "$OLD_DIR"; then
      rollback_and_fail
      return 1
    fi
    CURRENT_MOVED=1
  fi

  if ! maybe_fail "move-next-to-current"; then
    rollback_and_fail
    return 1
  fi
  NEXT_MOVE_STARTED=1
  if ! mv "$NEXT_DIR" "$CURRENT_DIR"; then
    rollback_and_fail
    return 1
  fi

  if ! maybe_fail "write-ready-temp"; then
    rollback_and_fail
    return 1
  fi
  if ! printf '%s\n' "$TOKEN" > "$READY_TMP"; then
    rollback_and_fail
    return 1
  fi

  if ! write_txn_phase committing; then
    rollback_and_fail
    return 1
  fi

  if ! maybe_fail "move-ready-into-place"; then
    if write_txn_phase prepared; then
      rollback_and_fail
    else
      log "ERROR: promotion journal could not enter rollback state; retry will recover" >&2
    fi
    return 1
  fi
  if ! mv "$READY_TMP" "$READY_FILE"; then
    if write_txn_phase prepared; then
      rollback_and_fail
    else
      log "ERROR: promotion journal could not enter rollback state; retry will recover" >&2
    fi
    return 1
  fi

  if ! write_txn_phase published; then
    log "ERROR: snapshot published but promotion journal update failed; retry will recover" >&2
    return 1
  fi

  # Once the new marker exists, current + .ready are a valid published pair.
  # Cleanup failures are reported but never roll that pair back; the journal
  # artifacts remain for recover_transaction on the next export.
  if [ "$READY_MOVED" -eq 1 ]; then
    if ! maybe_fail "cleanup-ready-backup"; then
      log "ERROR: snapshot published but old marker cleanup failed; retry will recover" >&2
      return 1
    fi
    if ! rm -f "$READY_BACKUP"; then
      log "ERROR: snapshot published but old marker cleanup failed; retry will recover" >&2
      return 1
    fi
  fi
  if [ "$CURRENT_MOVED" -eq 1 ]; then
    if ! maybe_fail "cleanup-old-current"; then
      log "ERROR: snapshot published but old current cleanup failed; retry will recover" >&2
      return 1
    fi
    if ! rm -rf "$OLD_DIR"; then
      log "ERROR: snapshot published but old current cleanup failed; retry will recover" >&2
      return 1
    fi
  fi

  if ! clear_txn; then
    log "ERROR: snapshot published but promotion journal cleanup failed; retry will recover" >&2
    return 1
  fi

  return 0
}

promote_and_report() {
  # publish_next is a simple command while errexit is explicitly disabled;
  # every operation inside it already has an explicit status branch.
  set +e
  publish_next
  promotion_rc=$?
  set -e
  if [ "$promotion_rc" -ne 0 ]; then
    log "ERROR: snapshot promotion failed" >&2
    return 1
  fi
  return 0
}

if [ "$rc" -eq 0 ]; then
  if ! promote_and_report; then
    exit 1
  fi
  log "export ok — snapshot promoted"
  exit 0
fi

# Zero workflows is a valid empty snapshot — but only when the CLI truly wrote
# nothing. `ls -A` includes hidden files, and its exit status is checked, so a
# partial export that printed the phrase (even to a dotfile) or a failed `ls`
# falls through to the hard failure below. If n8n ever rewords the message,
# update the pattern.
case "$out" in
  *"No workflows found with specified filters"*)
    set +e
    entries="$(ls -A "$NEXT_DIR" 2>/dev/null)"
    ls_rc=$?
    set -e
    if [ "$ls_rc" -eq 0 ] && [ -z "$entries" ]; then
      if ! promote_and_report; then
        exit 1
      fi
      log "zero workflows found — empty snapshot promoted"
      exit 0
    fi
    ;;
esac

# Hard failure: never replace current, never write .ready. Re-emit the CLI
# output so Coolify logs show why the export failed.
printf '%s\n' "$out" >&2
log "ERROR: export failed (exit $rc) — snapshot not promoted" >&2
exit "$rc"
