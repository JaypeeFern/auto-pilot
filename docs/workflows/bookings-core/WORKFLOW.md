# Bookings Core

Shared sheet read + booking normalization for the rental workflows.
Draft, callable-only — no caller uses it yet.

## Contract

- **Trigger:** `Core Input` (Execute Workflow Trigger, passthrough).
  Call via an Execute Sub-workflow node, mode `once`.
- **Reads:** all four device tabs, each tagged with its `device` name,
  combined with append.
- **Returns:** one item per recognized booking row with:
  `device`, `statusRaw`, `status` (lowercased/trimmed), `isActive`
  (`booked`/`released` only), `startDate`/`endDate` (ISO or empty),
  `timeRaw`, `timeMins` (-1 when unparseable), `startStamp`/`endStamp`
  (Manila-anchored ms, null when invalid), `valid`, `invalidReason`,
  plus `renterName`, `address`, `notes`, `balance`, `downPayment`,
  `diveCase`.
- Rows from unknown tabs are dropped. Unparseable dates/times mark the
  row invalid instead of guessing.
- **Header variance:** the balance column is `Balance` in some tabs and
  `Remaining` in others — `balance` prefers `Balance`, falls back to
  `Remaining` (a real `0` is kept, never treated as missing).

## Shared configuration (lives in code, per decision)

- Spreadsheet + tab names: the four Read nodes.
- Timezone `Asia/Manila`, device list, active-status allowlist:
  `Normalize Bookings`.
- 24-hour minimum and message layouts stay in the calling workflows.

## Activation note

Publish (activate) this workflow before migrating any caller — called
workflows must be active to run in production.
