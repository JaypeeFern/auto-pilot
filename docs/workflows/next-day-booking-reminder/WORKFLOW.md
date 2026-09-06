# Next-Day Booking Reminder

Sends the team one compiled Telegram message about upcoming rental
bookings, twice a day. Active.

## Why it exists

Nobody should have to open the spreadsheet to know what goes out today
and tomorrow. The workflow checks every device tab on schedule and
delivers a single readable message to the team group.

## Schedule

Hourly. The workflow timezone is set explicitly because the instance
default is UTC. A stable-hash change gate (`Compute Stable Hash` vs the
`lastReminderHash` key in `_State`) stops unchanged runs silently before
any delete/send — the group only hears when bookings actually changed.
Same-day bookings therefore surface within the hour, and quiet hours
cost zero notifications. The hash covers device, renter, dates, times,
status, section, address, notes, payments, and the next-check label —
deliberately not the live countdown figures, which would resend hourly.

## Flow, step by step

```text
Schedule (hourly)
  → Run Settings (debug switch, normally off)
    → Calculate Tomorrow (today + tomorrow dates in Manila time)
      → Read Bot State (last sent message id)
        → Read Reminder Hash (inline, keeps item pairing for the gate)
        → Fetch Core Bookings (Bookings Core sub-workflow: 4 tabs +
           normalize) → Filter → Compute Stable Hash → Check Has Bookings?
          → yes: build message → Send Reminder? (changed only)
               → debug gate → delete previous group message
               → send new → save new message id + hash
          → no:  short "no bookings" note → Send Note? (changed only)
               → same delete → send → save
```

- **One message, always current.** Each group send first deletes the
  previous group message, then sends fresh and records the new message
  id in the `_State` tab. The group chat holds exactly one reminder;
  every run still notifies normally (unlike silent message edits). A
  missing old message never blocks the new send.
- All matching bookings from all tabs are merged and sorted (today
  first, then pickup time, then device/renter). Never one message
  per row.
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

`Bookings Core` (`docs/workflows/bookings-core/WORKFLOW.md`) reads one
Google spreadsheet, four tabs (`Iphone 13`, `Canon EOS R50`,
`Insta360 X5`, `DJI Osmo Pocket 3`), tags each row with its device, and
returns normalized rows. This workflow maps those rows onto its legacy
field shape in `Filter Tomorrow's Bookings` and keeps all section,
sort, and message logic unchanged.

Columns used:

| Column | Meaning in the workflow |
|---|---|
| `Start Date` | Decides whether a row belongs in the message |
| `End Date` | Shown as the return; also feeds duration and the returns section |
| `Time` | Pickup time. Return time reuses it (24-hour minimum booking) |
| `Status` | `Booked` (secured, upcoming) and `Released` (unit out, return tracked) remind — see status model below |
| `Renter Name`, `Address`, `Notes` | Shown as-is |
| `Balance`, `Down Payment` | Shown as peso amounts (`₱0` when empty).
  `Balance` falls back to a `Remaining` column — tabs vary, see
  `docs/workflows/bookings-core/WORKFLOW.md` |
| `Dive Case` | Insta360 tab only, normalised to Yes/No, shown on Insta360 rows only |

Plus a `_State` tab (`Key` | `Value`) holding `lastMessageId` —
the bot's own bookkeeping for replacing the previous group message — and
`lastReminderHash`, the stable hash of the last sent content. Hide
it if you like, but don't delete it; hidden tabs stay API-accessible.

**Draft convention: Status is the commit signal — fill it in last.**
A row with blank `Status` is invisible to every output, so half-typed
rows never alert or unverify a device. (A row with `Status` set but
dates/times still being typed will briefly flag its device unverified
in the checker — honest, and it clears on the next hourly run.)

## Status model and repeat rule

- `Booked` = requirements complete, schedule secured. Shows in the
  pickup sections while its dates match.
- `Released` = unit handed to the customer, rental clock running. Shows
  in the return sections while its End Date is today or tomorrow.
- `Returned`, `Available`, `Pending`, anything else → skipped.

A booking keeps appearing until the team moves it forward: flip a
handed-over unit to `Released`, and a returned unit to `Returned`.
Same-day window covers pickups from up to 30 minutes ago, so schedule
drift can't drop an on-the-hour booking.

## Message sections

```text
Upcoming Bookings
[Today ...] [Tomorrow ... full blocks, or an explicit none-line]
Due for Return - N units
  ...one compact countdown line each, soonest first...
Next check: <Today/Tomorrow, 8:00 AM/PM>
```

Two sections. Upcoming pickups render as full blocks (or a "No upcoming
bookings today or tomorrow (dates)" line when empty). Due-for-return
renders one compact line per unit with a live countdown, limited to
rentals due back within 24 hours (past-due included); the header always
shows with its true count, even 0.

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

- `Google Sheets account` (OAuth2): attached to the Core read nodes and
  the `_State` reads/writes in this workflow.
- `Telegram account` (bot token): attached to all Telegram nodes
  (group + DM sends, deletes).

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
  Status is `Booked` (upcoming) or `Released` (returns), dates match
  today/tomorrow in Manila time, pickup time hasn't passed (30-minute
  grace applies).
- **Someone reports a booking that won't go away:** its Status never
  moved forward. `Booked` → flip to `Released` after handover;
  `Released` → flip to `Returned` when the unit is back.
