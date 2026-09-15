# Giveaway Tool specifications

## Purpose

These specifications preserve the behavior and safety properties of the two
giveaway-specific n8n workflows that formerly lived in AutoPilot. They are an
implementation-neutral contract for a future standalone Giveaway Tool. They
do not select a frontend, backend, database, ORM, queue, authentication
framework, Google client, or Telegram client.

The specifications describe required behavior, observed legacy behavior, and
known legacy limitations separately. The existing collector remains the only
substantial standalone implementation. The workflow-driven run persistence
and operator lifecycle are specified but are not yet implemented here.

## Index and implementation status

| Spec | Responsibility | Status in Giveaway Tool |
|---|---|---|
| [01 Collection](01-collection.md) | Facebook collection contract and fail-closed capture | Existing collector behavior; specified and partially implemented |
| [02 Run lifecycle](02-run-lifecycle.md) | Run identity, persistence, state transitions, and exact-result invariant | Specified from legacy; pending standalone implementation |
| [03 Control panel](03-control-panel.md) | Operator actions, asynchronous control, progress, preview, and export | Existing static source only; standalone service pending |
| [04 Results and validation](04-results-and-validation.md) | Canonicalization, counts, draw readiness, stored result shape | Specified; validation exists in legacy workflow, standalone persistence pending |
| [05 Review, commit, and discard](05-review-commit-discard.md) | Review gate, exact-result commit, discard, and idempotency | Discard is legacy behavior; commit is specified as a future safety requirement but is not present in the current workflow |
| [06 Google Sheets](06-google-sheets.md) | Evidence and status of the Sheets integration | Intentionally obsolete for the current reference workflows; no current behavior to implement |
| [07 Telegram](07-telegram.md) | Evidence and status of Telegram notifications | Intentionally obsolete for the current reference workflows; no current behavior to implement |
| [08 Security](08-security.md) | Operator access, secrets, browser profile, and data exposure | Specified; collector protections exist, application lifecycle protections pending |
| [09 Runtime and browser](09-runtime-browser.md) | Browser, profile, collector API, resource and timeout requirements | Existing runtime; specified and partially implemented |
| [Legacy mapping](LEGACY-N8N-MAPPING.md) | Workflow/node/path traceability and coverage audit | Validated against the exported JSON at removal time |

Status terms:

- **Existing** means behavior is present in the extracted collector/runtime.
- **Partial** means only some behavior is present; do not treat the old n8n
  workflow as standalone implementation.
- **Specified/pending** means a future agent must implement and validate it.
- **Intentionally obsolete** means current workflow evidence says the behavior
  was removed or never existed in the current reference; stale documentation
  must not resurrect it.
- **Validated** applies to this specification set's traceability audit, not to
  production execution or a live Facebook run.

## Reading order

Read collection and runtime first. Then read validation and run lifecycle.
The control-panel specification depends on those contracts. Review/commit/
discard depends on durable run persistence and validation. Security applies to
every feature. The Sheets and Telegram files document explicit non-requirements
so that a future implementation agent does not infer them from stale prose.

## Terminology

- **Collector**: the headed browser service that reads visibly rendered
  Facebook follower entries.
- **Run**: one human-initiated collection attempt identified by a run ID.
- **Raw rows**: the canonical retained profile rows, including valid rows with
  missing names and invalid rows retained for audit information.
- **Roulette rows**: canonical rows with a valid Facebook profile identifier
  and a non-empty display name; only these can be draw-ready.
- **Pending result**: an exact, durably stored complete result awaiting review.
- **Commit**: a future operation that writes the exact reviewed stored result to
  an explicitly configured destination. It must never collect again.
- **Discard**: an irreversible lifecycle transition that makes a result
  ineligible for commit.

## Legacy relationship

The source workflows were `IYAP2evHsmMccCQA` (collection) and
`46RugKER0tM14fnu` (control panel). Their exported JSON was inspected directly
before deletion from AutoPilot. n8n node names and exact legacy paths are kept
only in [LEGACY-N8N-MAPPING.md](LEGACY-N8N-MAPPING.md), not as standalone
architecture requirements.

The old workflows are reference evidence, not a runtime dependency of these
specifications. No n8n-specific node, webhook engine, or Data Table is
required by the future application.
