# AutoPilot

Lightweight, self-hosted **n8n Community Edition** instance — the
automation/workflow layer of the infrastructure. This repository holds
infrastructure and configuration only: Compose shape, environment template,
scripts, exported workflows, and docs. We do not build, modify, or fork n8n.

- Image: official `docker.n8n.io/n8nio/n8n:2.37.10` (exact pin, never `latest`)
- Hostname: `auto-pilot.jpfernandez.online` (Web UI + MCP on one hostname)
- Database: SQLite, persisted in the `n8n_data` Docker volume
- Memory ceiling: 768 MB, no CPU limit
- Deployment/backups: Coolify (+ Cloudflare R2); workflow history: GitHub

## Architecture at a glance

```text
Internet → Cloudflare Tunnel → Coolify Proxy → AutoPilot / n8n (SQLite)
```

- Full topology + container shape: `docs/ARCHITECTURE.md`
- Deploying through Coolify: `docs/DEPLOYMENT.md`
- Backups (Git workflow exports + Coolify/R2 volume): `docs/BACKUP.md`
- Recovery procedures: `docs/RESTORE.md`
- Built-in MCP server for AI agents: `docs/MCP.md`

## Prerequisites

- Ubuntu VPS with Docker, Coolify, and the existing Cloudflare Tunnel
- Coolify → Cloudflare R2 storage already configured (for volume backups)
- This repo connected as a Coolify Docker Compose service
- `auto-pilot.jpfernandez.online` routed through the tunnel to Coolify

## Deployment overview

1. Connect this repo to Coolify as a Compose service (domain → container
   port `5678`, no host ports).
2. Set runtime env in Coolify from `.env.example` (generate
   `N8N_ENCRYPTION_KEY` once via `openssl rand -hex 32` — it must never
   change afterwards).
3. Deploy, create the n8n owner account, enable Instance-level MCP.
4. Add two Coolify Scheduled Tasks: workflow exports (Git) and volume
   backups (R2, with container-stop enabled for SQLite consistency).
5. Details + upgrade procedure: `docs/DEPLOYMENT.md`.

## Where configuration lives

| Place | Holds |
|---|---|
| This repo | Compose shape, `.env.example` (safe defaults), scripts, docs |
| Coolify env | ALL real values/secrets at runtime (never in Git) |
| n8n UI | Users, workflows (live), credentials (live, encrypted) |
| GitHub `workflows/` | Exported workflow JSON history (no secret values) |
| Cloudflare R2 (via Coolify) | Full volume backup incl. SQLite + encrypted credentials |

## Backup strategy

Two layers: **Git** (daily workflow JSON exports via the n8n `export:workflow`
CLI + `/usr/local/bin/git-sync` in the exporter sidecar — portable history,
no secrets) and
**Coolify → R2** (scheduled `auto-pilot_n8n_data` volume archive —
full disaster recovery incl. credentials). SQLite needs a stopped-container
archive; the procedure and the success/failure-retention limitation are
documented in `docs/BACKUP.md`.

## Workflow export / versioning

Two daily Coolify Scheduled Tasks: the n8n container exports all workflows
with the supported `n8n export:workflow` CLI into a shared staging volume,
and the tiny `exporter` sidecar (`/usr/local/bin/git-sync`, baked into the
image via `Dockerfile.exporter`) normalises formatting
for stable diffs, scans for secret-looking patterns, and commits + pushes
only on change. Restores go the other way via `/usr/local/bin/restore-workflows`
(stage from git) + `n8n import:workflow` (workflows arrive INACTIVE).
No GitHub Actions, no paid n8n Source Control. Details: `docs/BACKUP.md`.

## MCP purpose

The built-in instance-level MCP server
(`https://auto-pilot.jpfernandez.online/mcp-server/http`, OAuth or API-key
auth) lets authorised external coding agents — Codex, Claude Code, OpenCode —
securely list, read, execute, and edit exposed n8n workflows. Setup, access
model, security, and example client configs: `docs/MCP.md`.

## For AI agents

Read `AGENTS.md` before changing anything in this repo.
