# Availability Checker

Answers "is this date free?" questions from the team with a per-unit
month view. Active. Listens for `/avail` (and `/help`) in the team group
on its own bot, `@rentalavailability_bot`.

## Why it exists

Rental inquiries arrive as "is the 20th morning free?" — and with a
24-hour minimum rental, a day that *looks* free on the sheet often isn't
(a 9:00 AM return blocks an 8:00 AM start the same day). This workflow
does the overlap math so the team doesn't have to.

## How it is triggered

In the team group only:

- **`/avail`** — current month at 8:00 AM daily starts.
- **`/avail October`** — that month (time defaults to 8:00 AM).
- **`/avail Sep 20 9am`** — September view computed at 9:00 AM starts.
  Also accepted: `20 Sep 9am`, `9am Sep 20`, `20/9 2pm`,
  `today 9am`, `tomorrow 9am`. Past months roll to next year.
- **`/help`** — usage examples.

Anything else in the group is ignored. Tapping a command's bot
autocomplete comes from the BotFather command list (`avail`, `help`).

## Flow, step by step

```text
Telegram Updates (group chat only)
  → Is Avail Command? (/avail or /help — everything else ignored)
    → Run Settings (debug switch, normally off)
      → Parse Request (month + daily start time)
        → Request Understood?
          → yes: Read Answer State → Read 4 device tabs → Combine
                   → Check Availability → Build → Has Prior?
                     → delete previous answer → delete /avail command
                     → Debug? → group send + save id (or DM send in debug)
          → no:  usage hint path (also deletes the command + prior answer)
    → Read Handbook State → Has Handbook?
      → missing: post + pin the handbook, record its id
```

- **One answer in chat.** Each run deletes the previous answer and the
  `/avail` command first, then sends fresh and records the new message
  id under `lastAvailMessageId` in `_State`. Missing-message deletes are
  tolerated. Debug sends never touch group state.
- **Self-maintaining handbook.** A pinned handbook message documents all
  accepted formats. The workflow posts and pins it once (tracked as
  `lastHandbookMessageId`) and leaves it alone afterwards. The delete
  flow never touches it.

## Overlap rule (24-hour minimum)

For each day from today to month-end, a `Booked`/`Released` booking
blocks every 24-hour window it touches — even partially. A unit back at
9:00 AM still blocks an 8:00 AM start the same day; a 6:00 AM pickup
tomorrow blocks the prior day. Back-to-back at exactly the boundary is
allowed. Rows that can't be parsed mark their device unverified instead
of guessing.

## Message layout

```text
September 2026 Availability
24-hour rentals from 8:00 AM daily

Iphone 13
September 11 to 18
September 27 onwards
...

Not free
Iphone 13
Sep 19 - next pickup Sep 19, 9:00 AM
Sep 20 - back Sep 20, 9:00 AM
...
```

Free days compress into ranges (`Sep 6`, `Sep 11 to 18`, `Sep 27
onwards` for tails reaching month-end). Below, a per-device Not-free
section explains each blocked day (`back X` = unit returns too late;
`next pickup X` = following booking starts too early).

## Debug switch

`Run Settings` holds `isDebug`:

- `false` (normal): answers go to the team group.
- `true`: answers go to a personal DM with a `DEV-TEST` prefix; group
  deletes still run, so test commands vanish from the group.

Set back to `false` and publish when done testing.

## Credentials (names only — values live in n8n)

- `RentalAvailabilityBot` (bot token): trigger, deletes, sends, pin.
  The bot must be group admin with message-delete permission.
- `Google Sheets account` (OAuth2): all four Read nodes.

No tokens, chat IDs, or spreadsheet IDs are documented here on purpose.

## Everyday maintenance

- **Someone reports a wrong free/blocked day:** check the booking's
  Start/End/Time cells and Status (`Booked`/`Released` count; everything
  else is ignored). Times with seconds are fine.
- **New device tab:** duplicate a Read + Tag pair, add the device to the
  device lists in `Check Availability` and the emoji map in the builder.
- **Changing the 24-hour minimum:** it is a constant in the overlap
  check — one place.
