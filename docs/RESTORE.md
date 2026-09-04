# RESTORE

Three scenarios, ordered by frequency. In all of them: never commit real
secrets, and never change `N8N_ENCRYPTION_KEY` unless you intend to destroy
all stored credentials.

## Scenario 1 — One lost/corrupted workflow (from Git)

Needs only the running stack. Restore is two steps because only the n8n
container can import (it owns the DB) and only the exporter has git.

```bash
# Step 1 — in the EXPORTER container (Scheduled Task command, or Execute Now):
sh /repo/scripts/restore-workflows.sh --file <name>.json
# (add --commit <ref> to restore from an older commit instead of the tip)

# Step 2 — in the N8N container (Scheduled Task command, or Execute Now):
n8n import:workflow --separate --input /exports/restore
```

Then in the n8n UI: the imported workflow arrives **INACTIVE** — verify its
nodes, re-link credentials if needed, test-execute, then activate.

## Scenario 2 — Total VPS loss (from the R2 instance backup)

Needs: this repo + the Coolify/R2 `auto-pilot_n8n_data` archive + the
original `N8N_ENCRYPTION_KEY`.

1. Provision a replacement VPS: Docker, Coolify, Cloudflare Tunnel
   (same hostname `auto-pilot.jpfernandez.online`).
2. In Coolify, recreate the AutoPilot Compose service from this repo and set
   **all** environment variables — critically the ORIGINAL
   `N8N_ENCRYPTION_KEY` (a different key = credentials permanently
   undecryptable).
3. Download the latest R2 `.tar.gz` volume archive to the new host.
4. **Verify before starting n8n** (from a COPY, never the original):
   ```bash
   mkdir /tmp/r2check && tar -xzf <archive>.tar.gz -C /tmp/r2check
   sqlite3 /tmp/r2check/home/node/.n8n/database.sqlite "PRAGMA integrity_check;"
   # expect a single line: ok
   ```
   If the check fails, try the previous archive generation, then fall back to
   Scenario 3 + manual credential recreation.
5. Restore the archive contents into the `auto-pilot_n8n_data` volume
   (container stopped):
   ```bash
   docker stop auto-pilot-n8n
   # extract archive over the volume, e.g. via a temporary helper container:
   docker run --rm -v auto-pilot_n8n_data:/target -v "$(pwd)":/src \
     alpine sh -c 'rm -rf /target/* && tar -xzf /src/<archive>.tar.gz -C /target'
   docker start auto-pilot-n8n
   ```
   (Exact device paths vary with Coolify's storage driver — adapt the
   extraction step to wherever Coolify mounts the volume on the new host.)
6. Confirm: `GET https://auto-pilot.jpfernandez.online/healthz` → 200, log in
   with the original owner account, spot-check workflows, credentials, and
   one execution. Re-enable the Coolify Scheduled Tasks (exports + backups).

## Scenario 3 — Fresh n8n, re-import workflow JSONs from Git

Use when there is no usable volume backup (or the SQLite check in Scenario 2
fails). You get workflows back; credential **secrets** must be recreated.

1. Deploy the stack fresh via docs/DEPLOYMENT.md (new `N8N_ENCRYPTION_KEY` is
   fine here — there are no old secrets to decrypt).
2. Stage everything from Git (exporter container), then import (n8n container):
   ```text
   sh /repo/scripts/restore-workflows.sh --all
   n8n import:workflow --separate --input /exports/restore
   ```
3. In the n8n UI, for EACH workflow:
   1. Recreate the credential secrets in Credentials (values from your
      password manager — prefer n8n Credentials over env vars for services).
   2. Re-link every node to the new credential.
   3. Test-execute, then activate.
4. Run the export task + sync task once ("Execute Now") to confirm Git and
   live state agree.

## Quick reference

| Lost… | Restore from | Credentials survive? |
|---|---|---|
| One workflow | Git (`--file`) | Yes (untouched) |
| Whole VPS, R2 archive OK | R2 volume + same encryption key | Yes |
| Whole VPS, no usable archive | Git (Scenario 3) | No — recreate |
