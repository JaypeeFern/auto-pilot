# ARCHITECTURE

AutoPilot is a lightweight, self-hosted **n8n Community Edition** instance that
acts as the automation/workflow layer of the infrastructure. This repo holds
infrastructure/configuration only — we do not build, modify, or fork n8n.

Pinned version: `docker.n8n.io/n8nio/n8n:2.37.10` (stable, released 2026-09-04).
Upgrades are deliberate/manual. Never use `:latest`.

## Runtime topology

```text
Internet
   ↓
Cloudflare Tunnel  (exists on the VPS, managed outside this repo)
   ↓
Coolify Proxy      (routes auto-pilot.jpfernandez.online → container :5678,
                    plus the operator-configured noVNC domain → browser :6080)
   ↓
AutoPilot / n8n    (single container, SQLite, 768 MB ceiling)
   ├── Web UI            https://auto-pilot.jpfernandez.online
   ├── MCP Server        https://auto-pilot.jpfernandez.online/mcp-server/http
   ├── Giveaway GUI      webhook-served control panel (n8n-authenticated)
   ├── Workflows         (live state in SQLite)
   ├── Credentials       (live state in SQLite, encrypted with N8N_ENCRYPTION_KEY)
   ├── Data Tables       (live state in SQLite: giveaway pending results)
   └── SQLite            /home/node/.n8n/database.sqlite

AutoPilot / browser  (collector service, 640 MB ceiling, Chromium profile)
   ├── Collector API     http://browser:5679 (container network only, n8n only)
   ├── noVNC web         container :6080 (Coolify domain + Cloudflare Access
   │                     + VNC password — never public bare)
   └── Chromium profile  /profile (browser_profile volume, persistent session)
```

One hostname serves the Web UI, the built-in MCP HTTP endpoint, and the
giveaway GUI webhook — there is deliberately no separate MCP hostname. The
noVNC browser route uses an operator-configured domain (set in Coolify) and
sits behind Cloudflare Access like the GUI. The current route-level auth and
bypass policy is recorded below and in `docs/MCP.md`.

What is NOT in this stack, on purpose: PostgreSQL, MySQL/MariaDB, Redis, queue
workers, external databases, a custom n8n image, `cloudflared` (already on the
VPS separately). The single documented exception is the `browser` service
below: the official n8n image has no Chromium and Code nodes have no network
access, so the explicitly requested VPS-hosted persistent browser cannot live
in n8n. Do not add further services without a demonstrated need.

## Data topology

```text
Persistent n8n data  (/home/node/.n8n in the n8n_data volume)
   ├── database.sqlite      (workflows, credentials, users, executions)
   ├── config               (instance settings incl. encryption key reference)
   └── binaryData/…         (binary execution payloads)
   ↓  Coolify scheduled volume backup (.tar.gz → Cloudflare R2)
Cloudflare R2  (off-server disaster recovery)
```

SQLite is the live source of truth. Git never sees the database.

## Current deployment facts

These facts describe the current AutoPilot deployment and are separate from the
portable workflow-safety skill. Re-check them when deployment or routing
changes:

- Runtime is n8n Community Edition using the official image, with SQLite and
  persistent data at `/home/node/.n8n`.
- n8n instance-level MCP is enabled. The GUI currently sits behind Cloudflare
  Access; webhook routes intentionally bypass Cloudflare Access. MCP routes
  also intentionally bypass Cloudflare Access and rely on n8n's own MCP OAuth.
- Workflow exports sync separately to Git. Credentials and secrets must never
  enter Git.
- `N8N_ENCRYPTION_KEY` is secret and must remain stable across redeploys and
  restores.
- The current n8n memory baseline is 768 MB.
- The `browser` giveaway service (custom `auto-pilot-browser` image: headed
  Chromium under Xvfb + noVNC + the collector API, 640 MB ceiling, persistent
  `browser_profile` volume) runs the Facebook session on the VPS. Its noVNC
  route is protected by Cloudflare Access plus a VNC password; its collector
  API is reachable only over the internal container network. The noVNC domain,
  Access rule, and `VNC_PASSWORD` are operator-configured (docs/DEPLOYMENT.md).
- Giveaway pending (dry-run) results live in n8n Data Tables inside SQLite —
  covered by the same volume backup as everything else.
- SQLite/full-instance backups are separate from workflow Git exports; the
  former is handled through the deployment backup system.

## Versioning topology

```text
n8n workflows (live in SQLite)
   ↓  Task 1, inside n8n container: sh /exports/export-workflows.sh (script
      baked into the exporter image, copied into /exports at startup)
/exports/current (export_staging volume — transient CLI output, no secrets;
                  `.lock` serializes export/sync and `.ready` identifies the
                  complete published snapshot)
/repo (exporter sidecar clones this repo into the repo_data volume)
   ↓  Task 2, inside exporter container: /usr/local/bin/git-sync (baked into
      the exporter image via Dockerfile.exporter — never loaded from /repo)
workflows/*.json (one file per workflow, deterministic formatting)
   ↓  git commit + push (HTTPS + GIT_TOKEN)
GitHub (portable backups + per-workflow version history)
```

Exported JSON contains workflow definitions plus credential names/IDs — never
credential secret values. Credential secrets are protected only by the R2
volume backup (same `N8N_ENCRYPTION_KEY` required to decrypt after restore).

## Container shape (docker-compose.yml)

| Concern | Choice |
|---|---|
| Image | Official, exact pin `2.37.10` |
| Database | SQLite (`DB_TYPE=sqlite`), volume `n8n_data:/home/node/.n8n` |
| Memory | `mem_limit: 768m`, `mem_reservation: 384m`, no CPU limit. Verified floor for 2.37.x (512 MB OOMs the JS heap at boot); heap explicitly capped at 512 MB via `NODE_OPTIONS` leaving room for native SQLite/task-runner memory |
| Restart | `unless-stopped` |
| Ports | None published; `expose: 5678` for the Coolify proxy (host port mapping would bypass the proxy) |
| Health | n8n: custom `healthcheck` against `GET /healthz` via node (official image ships no `HEALTHCHECK`; `/healthz` = reachable, `/healthz/readiness` = DB-ready; uses `127.0.0.1` + `${N8N_PORT}`). Exporter: checks baked scripts executable, git runnable, and `/exports/export-workflows.sh` delivered |
| Export sidecar | `exporter` service, thin wrapper (`Dockerfile.exporter`) around pinned `alpine/git:2.54.0` (git + sh only, 64 MB cap) with the sync scripts baked into `/usr/local/bin`, idle `sleep infinity` for tasks to exec into; owns checkout + push, never touches `n8n_data` |
| Browser-collector | `browser` service, custom image (`scripts/fb-followers-collector/Dockerfile.browser`, `node:22-bookworm-slim` + Chromium/Xvfb/x11vnc/noVNC, tagged `auto-pilot-browser:1.0.0`); `mem_limit: 640m`, no CPU limit; profile in `browser_profile:/profile`; `expose: 5679/5900/6080`, no published ports; healthcheck against the collector API |
| Staging | `export_staging` volume at `/exports` in both containers (transient, excluded from R2 backups); `repo_data` volume holds the exporter's replaceable clone |
| Proxy config | `N8N_PROTOCOL=https`, `N8N_HOST` + `N8N_EDITOR_BASE_URL` + `N8N_WEBHOOK_URL` = public URL, `N8N_PROXY_HOPS=1` |
| Pruning | `EXECUTIONS_DATA_PRUNE=true`, `MAX_AGE=168` (~7 d), `PRUNE_MAX_COUNT=10000`, manual/progress saves off (see `docs/BACKUP.md` for the success/failure limitation) |
| MCP | `N8N_MCP_MANAGED_BY_ENV=true` + `N8N_MCP_ACCESS_ENABLED=true` (n8n ≥ 2.20) |
| Hardening | `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` |

## Ownership (do not blur these)

| Owner | Owns |
|---|---|
| Coolify | Deployment, runtime env values, domain routing, R2 volume backups |
| GitHub (this repo) | Compose shape, scripts, docs, `.env.example`, workflow export history |
| n8n | Live workflows, credentials, users, executions |
| Cloudflare | Tunnel, DNS, R2 storage |

## Resource thinking

The VPS has ~2 GB RAM / ~25 GB free disk with other apps running. n8n gets 768 MB
max (verified floor for 2.37.x — 512 MB OOMs at boot). The browser service
gets 640 MB max (headed Chromium budget). Combined steady state is ~1.5 GB
with the exporter: if the host OOMs, stop the browser container while no
giveaway is running rather than shrinking n8n below its floor.
Execution pruning + `DB_SQLITE_VACUUM_ON_STARTUP=true` keep disk bounded.
