# 06. Google Sheets integration status

Status: intentionally obsolete for the current reference workflows.

## Evidence

The current exported giveaway workflows contain no Google Sheets node,
credential reference, read, clear, append, update, or verification path.
`IYAP2evHsmMccCQA` explicitly states in its configuration comments and sticky
notes that there is no external Sheets write. The current control-panel JSON
also contains no commit path.

The old `docs/workflows/giveaway-control-panel/WORKFLOW.md` claimed that a
future/previous commit action wrote two Sheets tabs, cleared and appended
rows, verified by read-back, and reported failure. That prose is stale and is
not a behavior of the exported workflows used for this migration. No Sheet
names, spreadsheet IDs, column schema, ordering, retry policy, or success
criteria can be truthfully extracted from the current JSON.

## Specification decision

Do not implement Google Sheets based on this file. It is preserved as an
explicit non-requirement and discrepancy record. If a later product decision
reintroduces a destination, create a new destination specification that
defines payload, ordering, clear/replace semantics, verification, retry and
idempotency behavior before coding. It must satisfy the exact-result and
write-then-verify invariants in [05](05-review-commit-discard.md).

## Classification

```text
current giveaway JSON:       INTENTIONALLY OBSOLETE / NO BEHAVIOR
stale control-panel prose:   DOCUMENTATION DISCREPANCY
future destination contract: UNDECIDED, not implemented
```
