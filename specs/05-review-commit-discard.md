# 05. Review, commit, and discard

Status: discard exists in legacy behavior. Commit is a future required
lifecycle capability but is not present in the current exported workflows.

## Review gate

The operator must be able to inspect the exact persisted summary and roulette
rows before any external destination write. Review is tied to a specific run
ID and stored payload. Editing a preview must not mutate the source result or
silently substitute a new collection.

Only a complete, draw-ready pending result may be offered for commit. Unknown,
invalid, incomplete, failed, discarded, committed, corrupt, or changed results
must be refused.

## Commit requirement

The future standalone application must define a destination commit operation
with this sequence:

```text
authenticate operator
  -> load pending run by runId
  -> verify status, readiness, integrity, and exact payload
  -> write the reviewed stored payload
  -> verify the destination write
  -> atomically mark the run committed
  -> report success
```

It must never call Facebook again. It must prevent duplicate commits under
retries, double-clicks, concurrent requests, and process restarts. If the
destination write or verification fails, the run must not be reported as
committed. The recovery policy for an uncertain external write must be
explicit before implementation; it must not silently retry an operation that
could duplicate rows.

The current workflow has no commit webhook, commit node, Sheets write, or
Telegram success path. The old control-panel markdown claims such a path, but
the exported JSON is authoritative and disproves that claim. This file
specifies the safety invariant requested for the future product, not an
assertion that it is implemented.

## Discard behavior

The future discard operation must accept only a pending run ID, authenticate
the operator, transition it to `discarded`, and make it permanently
ineligible for commit. Repeating discard must not restore eligibility.

The current n8n path reads a row by `runId`, checks only that a row exists,
and updates its status to `discarded`. Therefore it can discard a committed or
already-discarded row. That is a legacy safety gap, recorded here so it is not
copied into the standalone implementation. The old documentation's claim
that only pending results are cleared is not faithful to the JSON.

## Acceptance criteria

- Review always precedes an external write.
- Commit uses the exact stored payload and never re-scrapes.
- Destination write verification precedes success reporting.
- Duplicate commit is impossible or safely idempotent.
- Discarded and invalid runs cannot become committable.
- Legacy limitations remain traceable but are not treated as desired safety.
