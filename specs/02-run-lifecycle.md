# 02. Run lifecycle and persistence

Status: specified from legacy behavior; standalone implementation pending.

## Purpose

Make collection results durable before review and preserve the exact-result
boundary between collection and any future destination commit.

## Required states

The application must represent at least these states:

```text
created/collecting -> complete_pending -> committed
                   \-> failed
                   \-> discarded
complete_pending -> discarded
```

`created/collecting` may be represented as ephemeral job state if the
application can still report an in-progress run after a client disconnects.
The durable result must not be marked pending until validation accepts it.
The current n8n workflow persists only `complete` rows and later changes a
row to `discarded`; it does not persist failed or in-progress rows. A future
standalone implementation should retain failure state when it can do so,
without making a failed result committable.

Only `complete_pending` may be committed or discarded. `committed` and
`discarded` are terminal. Repeating either transition must be rejected or be a
safe idempotent response that does not perform the side effect again.

## Run identity and stored record

Every run has a unique, non-empty `runId` and an operator-facing `runLabel`.
The persisted record must contain:

- run ID and label;
- lifecycle status;
- creation/start and completion timestamps, plus transition timestamps;
- the collection summary and stop reason;
- canonical raw rows;
- canonical roulette-ready rows;
- readiness state;
- bounded, non-sensitive telemetry where retained by policy;
- commit/discard metadata when those transitions exist;
- enough integrity information to prove that a commit uses the stored payload
  unchanged.

The legacy `giveaway_runs` record used string fields named `runId`, `runLabel`,
`status`, `summaryJson`, `rawRowsJson`, `rouletteRowsJson`, and an unused
`telegramChatId` column. That shape is evidence, not a storage prescription.
The legacy summary omitted some collector fields such as telemetry and
`profileCapSkipped`; the standalone record must not silently lose fields the
collection contract says are needed for safety.

## Exact-result invariant

The lifecycle is:

```text
invoke collector
  -> validate and canonicalize response
  -> durably persist the exact accepted result
  -> expose it for review
  -> commit that persisted result, if approved
```

Commit must not invoke Facebook or re-run collection. A client-supplied run ID
selects a stored record; it does not supply replacement rows. If the stored
payload is missing, malformed, changed, invalid, discarded, or already
committed, the operation must fail safely without a destination write.

The record must be written atomically enough that a visible pending result is
complete and self-consistent. A process restart must not produce a silently
committable half-record.

## Collection initiation

Collection is initiated by a human action or an explicitly equivalent
operator-triggered internal call. The request is acknowledged quickly, while
the collection continues independently. The run ID used by the panel must be
the ID used in progress, result, and transition operations.

The current panel generates `gui-<epoch milliseconds>` for panel runs; direct
workflow runs generate `run-<epoch milliseconds>`. A future implementation
may use a stronger ID format, but it must preserve uniqueness and opaque
client handling.

## Acceptance criteria

- A result cannot become pending before complete validation.
- The exact stored rows and summary are the only commit input.
- Duplicate commits cannot repeat an external write.
- Discarded, failed, incomplete, unknown, or tampered records cannot commit.
- State transitions survive client disconnects and application restart.
- No schedule or autonomous collection is introduced.
