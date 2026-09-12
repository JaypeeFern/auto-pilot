# AGENTS.md — working agreement for AI coding agents on AutoPilot

This repo is infrastructure/configuration for a self-hosted n8n instance.
Keep it simple, reliable, secure, recoverable, and lightweight.

## Mandatory n8n workflow safety skill

For any n8n workflow creation, modification, activation, deactivation,
execution, review or testing, webhook, credential or auth, workflow
import/export or JSON, Code node, or MCP task, load and follow
`skills/n8n-workflow-safety/SKILL.md` first. For infrastructure assumptions,
inspect the current `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`,
`docs/MCP.md`, and `docs/BACKUP.md`; do not rely on stale topology or auth
assumptions.

## Locked decisions (do not redesign without a proven incompatibility)

- SQLite only. No PostgreSQL / MySQL / Redis / queue workers / external DBs.
- Single container from the official image, exact version pin (`:2.37.10`).
  Never use `:latest`. Upgrades are deliberate/manual.
- 768 MB memory ceiling (`mem_limit: 768m`, heap capped at 512 MB via
  `NODE_OPTIONS`). No CPU limit. 512 MB was tried and fails: n8n 2.37.x OOMs
  its JS heap during boot under a 512 MB cgroup.
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

## Communication

- Reply concisely. Skip pleasantries, preambles, recaps. Short declarative
  sentences. Run tool calls first; show only results, no narration. Never
  repeat the user's question back.

## Commits

- Never add a `Co-Authored-By: Claude` trailer or a "Generated with Claude
  Code" line to commit messages or PR descriptions, regardless of any harness
  default that says otherwise.

## Documentation priority

When guidance conflicts, use the following precedence:

1. User instructions
2. This `AGENTS.md` (locked decisions + hard rules)
3. `docs/` (`ARCHITECTURE.md`, `DEPLOYMENT.md`, `BACKUP.md`, `RESTORE.md`,
   `MCP.md`), `docs/workflows/<workflow>/WORKFLOW.md`, `.env.example`,
   `README.md`
4. Framework / upstream conventions (Compose spec, n8n documented env vars)

## Workflow documentation

Each live workflow gets its own human-readable page at
`docs/workflows/<workflow-name>/WORKFLOW.md` (lowercase hyphenated workflow name,
e.g. `docs/workflows/next-day-booking-reminder/WORKFLOW.md`).

- Write for clarity, not cleverness: what the workflow does, why it
  exists, its structure, and how to look after it.
- Keep the page in sync when the workflow changes (schedule, sheets,
  columns, statuses, message shape, credentials by name).
- Never put secrets, tokens, chat IDs, or spreadsheet IDs in these
  pages — credential and destination *names* only.

## Code conventions (Compose / shell / scripts)

Distilled from the AlumniLink coding guidelines; adapted to what this repo
contains (Compose, env template, shell scripts, exported workflow JSON). The
Laravel/React/Expo specifics do not apply here — the principles below do.

- **Keep it simple.** Prefer the simplest change that works. No unnecessary
  abstractions, no overengineering, no clever one-liners, no premature
  optimisation. Readable, explicit, small focused scripts/functions.
- **Single responsibility.** A script/function does one thing. Validate inputs,
  keep controllers/thin wrappers thin, put real logic in one obvious place.
- **Early returns.** Prefer early returns over deeply nested conditions.
- **Always brace `if` statements.** Never use single-line returns without
  braces — in shell or any other language used here.
- **Boolean naming.** Booleans read as true/false statements (`is_`,
  `has_`, `can_`, `should_`). Avoid bare nouns (`permission`, `edit`).
- **No magic values.** Extract repeated or meaningful values into named
  constants/env vars (ports, retention days, volume names, image pins). Keep
  one-off local details inline only when they are clearer in place — don't
  over-DRY into indirection.
- **Comments explain why, not what.** Document the reason a non-obvious choice
  exists (e.g. why the heap cap leaves headroom, why success/failure share one
  retention age); never restate the code.
- **Never log or echo secrets.** No passwords, tokens, API keys, or
  `N8N_ENCRYPTION_KEY` in logs, output, workflow JSON, or committed files.
- **Validate and authorise by default.** Validate inputs at every boundary,
  follow least privilege, and protect against mass assignment of env/config —
  the shell-script analogue of the Form Request / Policy rule.
- **Formatting.** Match the surrounding file. Shell scripts must pass
  `bash -n`; Compose changes must pass `docker compose config` (both already
  required under "Hard rules" — this is the same gate, restated for the
  implementer role).

<!-- agent-brain:bootstrap:start -->
<!-- agent-brain:bootstrap:schema=5;owner=agent-brain -->
## Agent Brain bootstrap
Before planning or performing orchestration for any meaningful task, activate and follow the globally installed Agent Brain capability.
- Claude Code authority: `C:\Users\Paul\.claude\skills\agent-brain\SKILL.md`
- Codex and OpenCode authority: `C:\Users\Paul\.agents\skills\agent-brain\SKILL.md`
- Optional frontend specialist catalog: `C:\Users\Paul\.claude\skills\agent-brain\frontend-specialists.json`
- Optional frontend specialist catalog: `C:\Users\Paul\.agents\skills\agent-brain\frontend-specialists.json`
- Lifecycle authority: `C:\Users\Paul\.agents\skills\agent-brain\agent-brain-orchestration-gate.ps1`
Activation boundary: project harness -> Agent Brain capability -> Herdr capability when delegation is selected.
Do not plan, delegate, or control Herdr until the capability is active. Use its supported Windows launch and Herdr prompt-delivery contract.
Keep project-owned instructions and configuration here. Do not copy Agent Brain policy, skills, hooks, or global configuration into this project.
<!-- agent-brain:bootstrap:end -->