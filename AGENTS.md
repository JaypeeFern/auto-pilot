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

1. **Make the downstream Herdr capability available before orchestration or control.** Prefer harness-native skill discovery; use `herdr --skill` only as the installed CLI fallback when the capability is absent. Do not activate it by directly reading installed files or copying the skill into the repository. If Herdr is unavailable, use whatever delegation or sub-agent mechanism the current harness already provides.
2. **Reuse the relevant configured harness, model, and effort by default.** Do not ask the user to choose an agent, model, or effort merely to begin work. The **reviewer** role remains locked to Codex on this repo. Honor explicit user overrides except `max`, which is prohibited, and select effort independently for each assignment based on task scope, risk, uncertainty, and model capabilities.
3. Detect the platform and shell **before** constructing a spawn command. In PowerShell, first confirm `$env:OS -eq 'Windows_NT'`, inspect `$PSVersionTable`, and resolve the native executable with `Get-Command`; do not try Unix/bash syntax or a bare executable first. Confirm the target is an existing interactive shell pane, preserve the requested cwd, and parse the pane ID from the split command’s JSON result. Use only the installed CLI’s supported syntax. For Windows PowerShell, including Windows PowerShell 5.1 and PowerShell 7, the selected full-permission Codex command is:

   ```powershell
   $agentCommand = 'codex.cmd --sandbox danger-full-access --ask-for-approval never --no-alt-screen'
   herdr pane run $paneId $agentCommand
   ```

   This is the Herdr 0.8.2 form: `herdr pane run <PANE_ID> <COMMAND>`. Do not use unsupported top-level `--effort` syntax with Codex; configure effort with `-c model_reasoning_effort="high"`. The initial attempt must contain the full required permission arguments. Use the requested native agent command and flags for other agent kinds, preserving their full permission mode in the initial command. If reusing an existing Codex model/effort configuration, omit only the model/effort selection and retain the full permission flags.
4. If a spawn fails, retain the exact full-permission command and inspect the structured Herdr error plus the target’s current state (`herdr agent list/get` and pane process state) before retrying. If an agent or process appeared after an ambiguous failure, inspect and reuse it; do not split another pane, reuse a name, or duplicate the spawn. Only when the target is confirmed unused may you correct the platform/quoting/target mistake and reconstruct the command with the **same full permission arguments**. Every retry must preserve full permissions. Never retry with a bare executable, Unix syntax, `herdr agent start` when the Windows path requires `pane run`, or omitted/default permissions. Rename only after a successful spawn.
5. Keep sub-agent output and review material internal-only until the orchestrator has triaged and synthesized it. Never paste raw output into the user-facing chat/composer, clipboard, or an unsent draft, and never use a pane read or terminal surface as a result channel. Submit work with `herdr agent prompt <target> <brief> --wait --timeout <ms>`, then retrieve status with `herdr agent get <target>` and the settled result once with `herdr agent read <target> --source recent-unwrapped --lines <n>`. Hold those results internally, inspect and synthesize them, and send only the concise user-facing conclusion. If the wait fails or returns `blocked`, inspect `agent get` and `agent read` before deciding what input is allowed. If prompt submission reports a possible Enter/input problem, inspect agent state/output before sending one corrective key; do not resubmit blindly.
6. If the supported result read remains truncated, do not infer the missing content or keep rereading the same terminal snapshot. Ask the agent, through Herdr, to write its complete report as Markdown in a dedicated temporary directory and reply only with the path; verify the returned path is a regular file inside that directory, then read that file directly. Use this only as a fallback, not in the initial brief.
7. The capability must be available before the task brief is issued; the brief must not direct an agent to read installed Herdr files or copy the skill. The brief must require a concise report. Findings and `VERDICT: PASS` or `VERDICT: FAIL` are reviewer-only; the implementer reports implementation and validation only and must not self-certify. The orchestrator must: wait for the settled state; retrieve through `agent get` and `agent read`; inspect against the working-tree diff and guidelines; synthesize findings internally; own triage; route only genuine findings to the same implementer; and send every revision to the same reviewer until an explicit `VERDICT: PASS`. Idle/done state or raw output alone is not completion.
8. Once the target and command are confirmed, spawn the agent **with full access** so the orchestrator can drive it end-to-end without a human clearing per-action approval prompts. For Claude, use the configured permission mode required by the task; preserve explicit user model and effort selections when supplied. Launch via `herdr pane run <pane-id> '<command>'` — `herdr agent start` for `codex` is unreliable on Windows (it shells out to a bare `codex` which is not a valid executable; use `codex.cmd`). After launch, `herdr agent rename <pane-id> <role-name>` to address it. Herdr’s paste-then-Enter can drop the Enter on long prompts; if `herdr agent prompt` returns `agent_prompt_stalled`, follow with `herdr agent send-keys <name> enter`.
9. The task brief must instruct the agent to send its concise report back to this (the spawning) agent via Herdr rather than just stopping — otherwise the results are lost.
10. Relay the returned result back to the user.

Inspecting or messaging an already-running Herdr agent does not require asking first — only spawning a new one does.

## Blocking questions, triage, and convergence

- Use the blocking-question protocol exactly: `ASK -> END TURN -> WAIT`. When a missing choice or ambiguity requires the user’s decision, send one concise `ASK: ...`, end the turn immediately, and wait. Do not spawn, retry, route work, or assume an answer after the `ASK`.
- The orchestrator owns review triage. For every reviewer finding, classify it as a genuine finding, a false positive, or a user decision. Route genuine findings to the same implementer. Close false positives only with concrete diff/guideline evidence. Convert user decisions into the blocking-question protocol; never silently waive or reinterpret them.
- Preserve continuity across retries and revisions: keep the same implementer and reviewer, pane/agent identities, cwd, task brief, and issue ledger. Inspect live state after interruptions and resume from it; never restart a possibly-created agent or lose unresolved findings.
- Drive convergence one revision at a time. Every implementer revision, including test-only or one-line revisions, returns to the same reviewer. Do not start dependent work or report completion until that reviewer returns `VERDICT: PASS`; user decisions resolve scope questions but do not replace the reviewer gate.

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
