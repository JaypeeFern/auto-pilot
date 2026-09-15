# 07. Telegram integration status

Status: intentionally obsolete for the current reference workflows.

## Evidence

The current giveaway workflow exports contain no Telegram node, Telegram
trigger, bot credential, message builder, notification branch, or send path.
The collector workflow's sticky note explicitly says there is no Telegram
report. The collection workflow retains an unused `telegramChatId` Data Table
column, but it is never populated or read.

The current control-panel documentation claimed dry-run, commit-success, and
failure Telegram messages. That claim is contradicted by the exported JSON.
The workflow metadata records that Telegram reporting was removed because its
placeholder chat ID caused failures; the remaining column is unused.

## Specification decision

Do not implement Telegram notifications from the stale documentation. There
is no current event-to-message contract to preserve. If notifications are
reintroduced later, define event triggers, recipient selection, message
content, secret handling, delivery verification, retry/idempotency behavior,
and failure semantics as a new product specification. A notification failure
must not falsely report a collection or destination commit as successful.

## Classification

```text
current giveaway JSON:       INTENTIONALLY OBSOLETE / NO BEHAVIOR
telegramChatId column:       IMPLEMENTATION DEBT / UNUSED LEGACY FIELD
stale control-panel prose:   DOCUMENTATION DISCREPANCY
future notifications:        UNDECIDED, not implemented
```
