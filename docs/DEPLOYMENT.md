# DEPLOYMENT

Deployment is owned by **Coolify** (Docker Compose service). There are no
standalone `docker compose up` production instructions here on purpose — the
VPS deployment goes through Coolify so routing, env, and R2 backups stay in
one place. Local `docker compose` is only for validating config shape.

## One-time setup in Coolify

1. **Create the service.** New resource → Docker Compose → connect this GitHub
   repo/branch. The compose file is `docker-compose.yml` at the repo root.
2. **Set the domain.** Add domain `auto-pilot.jpfernandez.online` to the `n8n`
   service, targeting container port `5678`. Publish **no** host ports.
   (Cloudflare Tunnel already points at the Coolify proxy; nothing in this
   repo configures the tunnel.)
3. **Set environment variables** (from `.env.example`; values live ONLY in
   Coolify, never in Git):
   - Required: `N8N_HOST`, `N8N_PROTOCOL=https`, `N8N_PORT=5678`,
     `N8N_EDITOR_BASE_URL`, `N8N_WEBHOOK_URL`, `N8N_PROXY_HOPS=1`.
   - Secret (generate once, then never change): `N8N_ENCRYPTION_KEY`
     (`openssl rand -hex 32`). Losing/changing it permanently destroys all
     stored credentials.
   - Export sync: `GIT_REPO_URL`, `GIT_TOKEN` (PAT, Contents: Read and write
     on this repo), optionally `GIT_BRANCH`.
   - Optional: leave everything else at the compose defaults unless you have
     a reason (see `.env.example` for the full classified list).
4. **Resources.** Confirm the 768 MB memory limit is reflected
   (`mem_limit: 768m` in compose, and the same value in Coolify's own
   resource settings if it has a memory field). Set no CPU limit.
5. **Deploy.** Start the service, then open
   `https://auto-pilot.jpfernandez.online` and create the owner account
   (n8n native auth — first user becomes owner).
6. **Enable the MCP server** (docs/MCP.md): Settings → Instance-level MCP →
   Enable MCP access. The compose file already sets the env-managed default;
   verify it shows as enabled. Create a dedicated low-privilege n8n user for
   external agents and issue its API key from the Connect dialog.
7. **Schedule workflow exports** (docs/BACKUP.md): two Coolify Scheduled
   Tasks — remember tasks run a shell command INSIDE the selected container,
   never `docker exec`, never on the host:
    - Task `autopilot-export`, target container `auto-pilot-n8n`, daily 02:00:
      ```text
      sh /exports/export-workflows.sh
      ```
      (The script is baked into the exporter image and copied into `/exports`
      at startup, so the exporter service must be running — which it always is
      after a deploy — before the export task runs.)
    - Task `autopilot-git-sync`, target container `auto-pilot-exporter`,
      daily 02:15:
      ```text
      /usr/local/bin/git-sync
      ```
      (The script is baked into the exporter image, so an empty `repo_data`
      volume bootstraps cleanly — no checkout needs to pre-exist. On the very
      first run the clone does not exist yet — use "Execute Now"
      on the sync task once: it clones, prepares `/exports` permissions, and
      refuses on the missing `.ready` flag. Then "Execute Now" the export
      task, then the sync task again to verify the first commit lands.)
   Create a fine-grained PAT on the AutoPilot repo (minimum permission
   **Contents: Read and write**) and store it as `GIT_TOKEN` in the Coolify
   environment — never in this repo.
8. **Schedule volume backups** (docs/BACKUP.md): enable Coolify's scheduled
   backup for the `auto-pilot_n8n_data` volume ONLY (not the staging/repo
   volumes) to the existing Cloudflare R2 storage, with **"Stop containers
   while creating the archive" turned ON**. This stops only `auto-pilot-n8n`
   (the sole user of that volume) during the archive — SQLite consistency
   (see docs/BACKUP.md for why) — and leaves the exporter running.

## Redeploys / upgrades

- Normal redeploys (config change, Coolify restart): nothing special. The
  `n8n_data` volume persists SQLite + key; `N8N_ENCRYPTION_KEY` MUST be
  unchanged in Coolify env.
- n8n upgrades: deliberate/manual only.
  1. Take a Coolify volume backup AND run the export task ("Execute Now" on
     `autopilot-export`) first.
  2. Bump the exact pin in `docker-compose.yml` (never `:latest`).
  3. Redeploy, watch `/healthz`, smoke-test UI + one workflow execution.
  4. Roll back by re-pinning + restoring the volume backup if needed.

## Local validation (config shape only)

```bash
cp .env.example .env        # fill N8N_ENCRYPTION_KEY with a THROWAWAY value
docker compose config       # validates interpolation; do not `up` for prod
sh -n scripts/git-sync.sh
sh -n scripts/restore-workflows.sh
```

Never commit the local `.env`. Never point a local stack at the production
`N8N_ENCRYPTION_KEY`.
