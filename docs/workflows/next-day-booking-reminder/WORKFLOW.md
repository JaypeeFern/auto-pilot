# Next-Day Booking Reminder

Sends the team one compiled Telegram message about upcoming rental
bookings, twice a day. Active.

## Why it exists

Nobody should have to open the spreadsheet to know what goes out today
and tomorrow. The workflow checks every device tab on schedule and
delivers a single readable message to the team group.

## Schedule

Twice daily: **08:00 + 20:00 Asia/Manila**. The workflow timezone is set
explicitly because the instance default is UTC. Morning run covers the
day's prep; evening run catches bookings entered during the day.

## Flow, step by step

```text
Schedule (08:00 + 20:00 Manila)
  → Run Settings (debug switch, normally off)
    → Calculate Tomorrow (today + tomorrow dates in Manila time)
      → Read 4 device tabs → tag each row with its device
        → Combine → Filter → Check Has Bookings?
          → yes: build message → group send (or DM send in debug)
          → no:  short "no bookings" note → group send (or DM send in debug)
```

- **One message per run.** All matching bookings from all tabs are merged,
  sorted (today first, then pickup time, then device/renter), and sent
  together. Never one message per row.
- **Sheet/API failure fails the run.** A read error never turns into a
  fake "no bookings" message. If the team gets no message at all, check
  Executions — something broke before the send step.
- **On-demand entry.** An `On-Demand Entry` trigger feeds the same chain
  so the companion `Booking Reminder On-Demand` workflow can run it from
  Telegram. See `docs/workflows/booking-reminder-on-demand/WORKFLOW.md`.
- **Future channels fan out from one node.** Discord, Messenger, or email
  later: branch new send nodes off `Build Reminder Message`. The lookup
  and message logic stays untouched.

## Booking source

One Google spreadsheet, four tabs: `Iphone 13`, `Canon EOS R50`,
`Insta360 X5`, `DJI Osmo Pocket 3`. Each tab is read in full every run.

Columns used:

| Column | Meaning in the workflow |
|---|---|
| `Start Date` | Decides whether a row belongs in the message |
| `End Date` | Shown as the return; also feeds duration and the returns section |
| `Time` | Pickup time. Return time reuses it (24-hour minimum booking) |
| `Status` | Only `Booked` rows remind (see repeat rule below) |
| `Renter Name`, `Address`, `Notes` | Shown as-is |
| `Remaining`, `Down Payment` | Shown as peso amounts (`₱0` when empty) |
| `Dive Case` | Insta360 tab only, normalised to Yes/No, shown on Insta360 rows only |

## Repeat rule (status-driven)

A booking keeps appearing until the team marks it handled:

- `Booked` → reminds every run while its dates match.
- `Released`, `Returned`, `Available`, `Pending` (or anything else) → skipped.
- The message footer says this outright: *"Bookings keep showing
  until marked Released."*

Team habit: after handing over a unit, flip its Status to `Released`.
Same-day window covers pickups from up to 30 minutes ago, so schedule
drift can't drop an on-the-hour booking.

## Message sections

```text
Upcoming Bookings
Today, <date> — N bookings
  ...one block per booking, pickup-time order...
Tomorrow, <date> — N bookings
  ...
Returns due today — N units
  ...units whose End Date is today but started earlier...
Next check: <Today/Tomorrow, 8:00 AM/PM>
```

Each booking block shows: device, renter, pickup (date + time), return
(date + time), duration in days, address, status, notes, down payment,
balance. Empty fields show `—` (or `N/A` / `₱0` where a word reads
better). Sheet times with seconds (`8:00:00 AM`) are trimmed to `8:00 AM`.

## Debug switch

`Run Settings` (first node after the trigger) holds one flag, `isDebug`:

- `false` (normal): messages go to the team group.
- `true`: both sends go to a personal DM with a `DEV-TEST` prefix instead.

Use it for safe testing, then set it back to `false` and publish — while
it is on, the team gets nothing, including from the scheduled runs.

## Credentials (names only — values live in n8n)

- `Google Sheets account` (OAuth2): attached to all four Read nodes.
- `Telegram account` (bot token): attached to all four Send nodes
  (group + DM variants on each path).

No tokens, chat IDs, or spreadsheet IDs are documented here on purpose —
they live in the workflow definitions and n8n credentials, never in Git
beyond what the automatic workflow export already contains (names/IDs
only, never secret values).

## Everyday maintenance

- **New device tab:** duplicate a Read + Tag pair, point at the new tab,
  set the matching device name in the Tag node, raise the merge input
  count, wire the new branch in. Message builder needs no changes unless
  the tab has extra columns worth showing.
- **Change reminder times:** edit the rules on the schedule trigger node.
  The "Next check" footer derives from the 08:00/20:00 slots — keep them
  in sync if the schedule changes.
- **Someone reports a missing booking:** check three things in order —
  Status is exactly `Booked`, Start Date matches today/tomorrow in Manila
  time, pickup time hasn't passed (30-minute grace applies).
- **Someone reports a booking that won't go away:** its Status is still
  `Booked`. Flip it to `Released`.
