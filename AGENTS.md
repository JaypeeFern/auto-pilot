# AGENTS.md — working agreement for AI coding agents on AutoPilot

This repo is infrastructure/configuration for a self-hosted n8n instance.
Keep it simple, reliable, secure, recoverable, and lightweight.

## Locked decisions (do not redesign without a proven incompatibility)

- SQLite only. No PostgreSQL / MySQL / Redis / queue workers / external DBs.
- Single container from the official image, exact version pin (`:2.37.10`).
  Never use `:latest`. Upgrades are deliberate/manual.
- 512 MB memory ceiling (`mem_limit: 512m`). No CPU limit.
- One hostname (`auto-pilot.jpfernandez.online`) for UI + MCP. No `cloudflared`
  service in Compose. No host ports published (Coolify proxy routes to :5678).
- Do not modify or fork n8n. No custom Docker image without a proven,
  documented requirement.

## Ownership boundaries

- **Coolify** owns deployment, runtime env values, domain routing, R2 backups.
- **Git** (this repo) owns infra shape + workflow export history.
- **n8n** owns live workflows, credentials, users, executions.
- **R2 via Coolify** owns full-instance disaster recovery.

## Hard rules

- Never commit real secrets: passwords, API keys, OAuth secrets, MCP/API
  tokens, `N8N_ENCRYPTION_KEY`, GitHub tokens. Placeholders only in examples.
- Never change or delete `N8N_ENCRYPTION_KEY` semantics — it must stay stable
  across redeploys/restores or all credentials are lost.
- Preserve SQLite persistence (`n8n_data:/home/node/.n8n`) unless explicitly
  instructed otherwise. Never add a migration that wipes the volume.
- Keep execution pruning enabled and bounded (see docs/BACKUP.md for the
  single-retention-age limitation — do not invent `*_SUCCESS_MAX_AGE` vars).
- Only use documented n8n env vars (see `.env.example` "INTENTIONALLY NOT
  SET" block for known community-invented names to avoid).
- No GitHub Actions for workflow export; the triggers are two Coolify
  Scheduled Tasks (export CLI in the n8n container, then `scripts/git-sync.sh`
  in the exporter sidecar). Tasks run INSIDE containers — never assume a host
  with docker/git/a repo checkout, and never install packages at runtime to
  work around it.
- Validate before finishing: `docker compose config`, `bash -n` on scripts,
  and a secrets review (`git status`, `git diff`, grep for token patterns).

## Review process

- Reviews of AutoPilot changes run through **Herdr with Codex as the review
  agent** — always use Codex for the reviewer role, never another model.
