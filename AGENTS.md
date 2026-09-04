# AGENTS.md — working agreement for AI coding agents on AutoPilot

This repo is infrastructure/configuration for a self-hosted n8n instance.
Keep it simple, reliable, secure, recoverable, and lightweight.

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
   `MCP.md`), `.env.example`, `README.md`
4. Framework / upstream conventions (Compose spec, n8n documented env vars)

## Prefer sub-agent driven development

Default to sub-agent driven development for anything beyond small, localised,
sequential changes. Break meaningful units of work — a Compose reshape, a
script change, an audit, a review, a long-running build — and hand each to its
own coding sub-agent rather than doing everything inline in the coordinating
session.

- Favor sub-agents for work that is **independent**, **parallelisable**, or
  **context-heavy** (large diffs, verbose test/log output, investigations that
  would pollute the main context).
- Favor keeping work inline only for small, localised, sequential, or tightly
  coupled changes where coordination cost exceeds benefit.
- Every delegated task must specify: objective and expected deliverable,
  relevant docs/locked decisions, decisions already made, scope and file
  ownership, whether edits are allowed, required validation, and conditions
  requiring escalation. Avoid overlapping write access between agents.
- The coordinating agent owns the final result: verify delegated work (inspect
  the diff, compare against `docs/` and the locked decisions, run
  `docker compose config` / `bash -n` / secrets review), relay results to the
  user, and address real findings before reporting completion.

When the surrounding environment supports it, run sub-agents through Herdr (see
"Delegating to another agent (Herdr)" below) so each agent runs in its own
pane. If Herdr is unavailable, use whatever sub-agent mechanism the current
harness provides; the preference for delegation still applies.

### The three-terminal setup

For any non-trivial unit of work (plan → implement → review), stand up **three
terminals**, each its own agent in its own pane:

1. **Orchestrator** — the coordinating session. Owns the plan, splits the work
   into groups, routes each group to the implementer, relays reviewer findings,
   and reports to the user. Does not write feature code itself.
2. **Implementer** — receives one group at a time from the orchestrator,
   writes the code, runs the validation (`docker compose config`, `bash -n`,
   secrets review), and reports back. Never self-certifies as done.
3. **Reviewer** — the independent gate (see "Review pass" below). Reviews the
   implementer's working-tree diff for every group and every revision, ending
   each pass with `VERDICT: PASS` or `VERDICT: FAIL`. A distinct agent from the
   implementer — never the same pane, never the same session. On this repo the
   reviewer is always **Codex** (see "Review process" above).

Keep all three alive for the duration of the work; don't collapse the reviewer
into the orchestrator or the implementer to save a pane.

## Delegating to another agent (Herdr)

Self-contained tasks — code review, an audit, an independent implementation pass, a long-running build — can be handed to a separate coding agent running in its own Herdr pane.

1. **Check whether Herdr is available first** (the `herdr` skill / `HERDR_ENV=1`, or a reachable `herdr` CLI). If it is not, skip all of this and use whatever delegation or sub-agent mechanism the current harness already provides.
2. **If Herdr is available, before spawning any new Herdr agent, stop and ask the user which agent to spawn** (e.g. `codex`, `opencode`, another `claude`), **which model to run it with, and what effort level to use**. Do not choose these yourself and do not spawn without an explicit answer covering all three. Exception on this repo: the **reviewer** role is locked to Codex — no need to ask for that role, only for orchestrator/implementer or other spawns. This exception still only concerns which agent to use — model and effort level must still be asked even for the reviewer role.
3. Once told, spawn that agent **with full access** so the orchestrator can drive it end-to-end without a human clearing per-action approval prompts:
   - `codex` → `codex.cmd --sandbox danger-full-access --ask-for-approval never --no-alt-screen`
   - `claude` → `claude --permission-mode bypassPermissions` (or `acceptEdits` if the task is edit-only)
   - Launch via `herdr pane run <pane-id> '<command>'` — `herdr agent start` for `codex` is unreliable on Windows (it shells out to a bare `codex` which is not a valid executable; use `codex.cmd`). After launch, `herdr agent rename <pane-id> <role-name>` to address it.
   - Herdr's paste-then-Enter can drop the Enter on long prompts; if `herdr agent prompt` returns `agent_prompt_stalled`, follow with `herdr agent send-keys <name> enter`.
4. The task brief **must instruct the agent to load the `herdr` skill itself** and, when finished, to send its results back to this (the spawning) agent via Herdr rather than just stopping — otherwise the results are lost.
5. Relay the returned result back to the user.

Inspecting or messaging an already-running Herdr agent does not require asking first — only spawning a new one does.

## Review pass for substantial changes

Before reporting completion on any change that is **complex** (cross-cutting
Compose reshape, auth/security-adjacent, backup/restore semantics, or hard to
reason about) or **large** (many files touched, new shared script, volume or
migration implications), run an independent code-review pass over the
working-tree diff against this `AGENTS.md`, the relevant `docs/`, and the
conventions below — do not rely only on your own diff read plus validation
commands.

On this repo that review runs through Herdr with Codex (see "Review process").

Small, localised, low-risk changes do not need this.

### The review pass is a gate, not a formality

When a change is being run through review (delegated or otherwise), that review
is the **final gate**. It is not cleared until the reviewer returns an explicit
**PASS**.

- **Every revision re-enters review.** If the reviewer raises anything and the
  implementer changes code in response — even a one-line tweak — the updated
  working tree goes **back to the same reviewer** for a fresh verdict. The
  coordinator must not accept a revision on its own read.
- The reviewer must end with a machine-checkable verdict: `VERDICT: PASS` or
  `VERDICT: FAIL`. Non-blocking nits may be waived by the coordinator (say so
  explicitly when relaying); blocking issues must be fixed and re-reviewed.
- **No downstream work depends on an ungated change.** When work is batched into
  groups/tasks, a group is "done" only after its review PASSes. Starting the next
  group before the current one has PASSed is allowed only when the two touch
  disjoint files and the coordinator says so — the earlier group's PASS is still
  required before completion is reported.
- The coordinator reports a group/task complete to the user only once its review
  verdict is PASS.

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
