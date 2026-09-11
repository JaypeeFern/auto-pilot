# BACKUP

Two separate layers. Neither is optional.

## Layer 1 — Workflow-level backup (GitHub)

- **What:** `workflows/*.json` (one file per workflow), plus compose, scripts,
  docs, `.env.example` — everything in this repo.
- **How (two Coolify Scheduled Tasks, no host tooling):**
  - **Task 1 — export (target: `n8n` container, daily 02:00 UTC):**
    ```text
    sh /exports/export-workflows.sh
    ```
    Runs as the container's default `node` user. The script
    (`scripts/export-workflows.sh`) is baked into the exporter image and
    copied into `/exports` by the exporter's entrypoint at startup — the n8n
    container cannot host it (no checkout, no custom image) and `/exports` is
    the only shared path. It distinguishes three outcomes so a valid
    zero-workflow instance is never mistaken for a failure:
    - **success** (CLI exit 0): promote `/exports/next` → `/exports/current`,
      create `/exports/.ready`.
    - **zero workflows** (CLI exits non-zero with `No workflows found with
      specified filters`): promote an **empty** `/exports/current`, create
      `/exports/.ready`, log that zero workflows were found. This is what lets
      Git record deletion of the final workflow.
    - **any other failure**: leave `/exports/current` and `.ready` untouched,
      re-emit the CLI output, exit non-zero.
    The handoff is serialized by an atomic `/exports/.lock` directory shared by
    both tasks. The CLI writes to `/exports/next`; promotion journals the prior
    `current` and `.ready` as `.old` files and records the phase in a temporary-
    file-renamed `.promotion` journal, replaces `current` only on a confirmed
    outcome, then writes `.ready` through a temporary file and rename. Cleanup
    happens after the new `current` + `.ready` pair is published. A failure
    before that point restores the old pair when safe, or leaves the marker
    absent and journal artifacts for the next export to recover. The journal
    also prevents recovery from rolling back a published pair whose `.ready`
    marker was already consumed by sync. The leading `rm` makes genuine
    workflow deletions real (the CLI never cleans its target dir).
  - **Task 2 — sync (target: `exporter` container, daily 02:15 UTC):**
    ```text
    /usr/local/bin/git-sync
    ```
    The sync script is baked into the exporter image (`Dockerfile.exporter`,
    derived from the pinned `alpine/git:2.54.0`) — never loaded from `/repo`,
    so an empty `repo_data` volume bootstraps cleanly on the very first run
    (no `cp /repo/scripts/...` chicken-and-egg). `scripts/git-sync.sh` ensures a fresh checkout (clone if missing, else
    fetch + hard reset — local drift is discarded), prepares `/exports`
    permissions, REFUSES unless `/exports/.ready` exists, treats an **empty**
    `/exports/current` as a valid zero-workflow snapshot (deleting every
    tracked workflow JSON), normalises formatting for stable diffs, runs a
    FAIL-CLOSED secret scan (any hit aborts before `git add` with a non-zero
    exit — file and category reported, value never printed), and commits +
    pushes **only on real change**. The `.ready` flag is consumed after a
    successful push or a successful no-change sync, so each export is synced
    at most once; a failed push keeps the flag so the next run retries the
    identical set.
  - Why two containers: Coolify tasks execute INSIDE the selected container,
    and the n8n container has no repo checkout (and must not gain git
    tooling). The `exporter` sidecar (thin wrapper around the pinned
    `alpine/git:2.54.0` via `Dockerfile.exporter`, git + sh only, ~64 MB)
    owns all Git responsibilities and also delivers the export script into
    the shared volume; the `export_staging` volume is the only coupling. The
    sync/restore scripts live baked into the image at `/usr/local/bin/` (the
    persistent `/repo` checkout cannot host the script that clones it), and
    the container copies the export script into `/exports` then idles
    (`sleep infinity`) so tasks have a running target to exec into.
- **Trigger:** the two Coolify Scheduled Tasks above (export first, sync with
  a ~15 min offset). No GitHub Actions, no n8n paid Source Control — both
  deliberately avoided. Failure mode is safe in every direction: a failed or
  partial CLI export leaves `/exports/current` and `.ready` untouched; a
  promotion failure either restores the prior pair or leaves readiness absent
  with journal artifacts for recovery; an empty `/exports/current` is a valid
  zero-workflow snapshot only when `.ready` is present (deletes every tracked
  workflow); a secret hit aborts before `git add` and fails the task visibly;
  a failed sync leaves staging and the flag intact for the next run. The
  shared lock is fail-closed: if a container is killed while holding it, verify
  that no export or sync task is running before removing the stale `.lock` and
  retrying. If legitimate content ever trips the scanner, add a narrow
  explicit file+category allowlist — never weaken the patterns.
- **Git auth:** `GIT_TOKEN` env on the `exporter` service (Coolify env,
  secret): a fine-grained PAT on the AutoPilot repo with the minimum
  permission **Contents: Read and write**. The sync script passes it via an
  in-memory `credential.helper` — never in the remote URL, never written to
  `.git/config`, never embedded in this repo.
- **Guarantees:** portable per-workflow version history. NOT a full restore:
  exports contain credential names/IDs but never secret values.

## Layer 2 — Full-instance backup (Coolify → Cloudflare R2)

- **What to back up:** exactly one volume — the n8n data volume:
  - Volume: `auto-pilot_n8n_data`
  - Container path: `/home/node/.n8n`
  - Contains: `database.sqlite` (workflows, credentials, users, executions),
    instance config/keys, binary data.
- **Plus, when the browser service is deployed:** the browser profile volume:
  - Volume: `auto-pilot_browser_profile`
  - Container path: `/profile`
  - Contains: the persistent Chromium profile (Facebook session cookies).
  - Same stop-containers treatment: Coolify stops only the containers USING
    the selected storages, so selecting both volumes stops `auto-pilot-n8n`
    and `auto-pilot-browser` during the archive. Never run a giveaway
    collection across the backup window — a stopped browser fails the run
    loudly (collector unreachable alert), never silently.
  - n8n Data Tables (giveaway pending results) live inside `database.sqlite`,
    so they are covered by the `auto-pilot_n8n_data` backup with no extra step.
- **What NOT to back up:** `auto-pilot_export_staging` (transient CLI output,
  re-exportable in minutes) and `auto-pilot_repo_data` (replaceable clone
  cache, re-cloned automatically; GitHub is its source of truth). Selecting
  only `auto-pilot_n8n_data` also keeps the backup small.
- **How:** Coolify's existing scheduled storage backup (file-level `.tar.gz`
  of the volume, uploaded to the already-configured Cloudflare R2 storage).
  Do NOT build another R2 uploader in this repo.
- **Settings:** enable **"Stop containers while creating the archive"** and
  keep it enabled. Coolify stops only the containers that USE the selected
  storage — i.e. just `auto-pilot-n8n` — archives the volume, and restarts
  it. The `exporter` sidecar does not mount `n8n_data`, so it is untouched
  and scheduled Git syncs are unaffected (a sync landing mid-backup simply
  commits whatever staging holds; export output is not in the stopped path).

## SQLite consistency — read this

Coolify backups are file-level archives of a volume. Its own docs warn that
files changing mid-archive can produce an inconsistent or corrupted backup,
"especially important for databases", and recommend stopping writes or using
an application-aware backup workflow instead.

SQLite specifically can be mid-transaction (journal/WAL frames not yet
checkpointed) when a live tar runs, yielding a `database.sqlite` that looks
fine but fails `PRAGMA integrity_check` on restore. Mitigations, in order:

1. **Stop-the-world archive (implemented):** Coolify stops the n8n container,
   archives the volume, restarts it. Brief downtime during the backup window
   (schedule nightly), but a quiescent SQLite file archives cleanly. This is
   the safest practical option with current Coolify behavior.
2. **Verify after restore:** on any restore, run
   `sqlite3 database.sqlite "PRAGMA integrity_check;"` from a copy before
   starting n8n (procedure in docs/RESTORE.md).
3. **Git exports as backstop:** even a worst-case corrupt volume backup still
   leaves every workflow definition in Git (minus credential secrets, which
   must then be recreated — an accepted, documented trade-off).

There is no SQLite WAL-checkpoint knob in Coolify; do not pretend the live
backup is safe. The stopped-container backup + integrity check is the honest
configuration.

## Execution data / disk management

VPS disk is constrained (~25 GB free, shared). n8n execution history is bounded
by pruning (env defaults in `docker-compose.yml`):

```text
EXECUTIONS_DATA_PRUNE=true
EXECUTIONS_DATA_MAX_AGE=168                # hours ≈ 7 days
EXECUTIONS_DATA_PRUNE_MAX_COUNT=10000      # absolute cap on finished runs
EXECUTIONS_DATA_SAVE_ON_PROGRESS=false
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false
```

**Limitation (verified against current docs):** Community Edition supports only
ONE retention age for all finished executions. There are no separate
success/failure retention variables, so the requested "7 days success / 30 days
failed" policy cannot be expressed natively. The implemented config keeps
**everything ~7 days** (closest safe approximation). If keeping failures longer
matters more than keeping successes at all, the documented alternative is:

```text
EXECUTIONS_DATA_SAVE_ON_SUCCESS=none   # discard successes entirely
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_MAX_AGE=720            # hours ≈ 30 days (failures only)
```

`DB_SQLITE_VACUUM_ON_STARTUP=true` reclaims pruned space on restart (slightly
slower starts; otherwise freed pages are reused but the file never shrinks).

References: n8n "Manage execution data",
`EXECUTIONS_DATA_*` env reference, Coolify storage-mount backup docs.
