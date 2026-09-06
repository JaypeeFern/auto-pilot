# Booking Reminder On-Demand

Lets the team re-run the booking reminder from Telegram at any time.
Active. Does no sheet reading or message building itself — it calls the
main workflow, which does the work and sends the message. That way the
message format exists in exactly one place (see
`docs/workflows/next-day-booking-reminder/WORKFLOW.md`).

## Why it exists

Scheduled runs happen twice a day, but the team sometimes needs a fresh
check right now — after entering a batch of bookings, or to settle a
"did it go through?" question. Tapping a button beats opening n8n.

## How it is triggered

Two ways, both inside the team group only:

- The **🔄 Check Bookings Now** button under any reminder message.
- Typing **`/check`** in the group.

Tapping the button shows a *"Checking all 4 device sheets…"* confirmation
while the fresh reminder is generated.

## Flow, step by step

```text
Telegram Updates (group chat only)
  → Refresh Requested? (button tap OR /check — everything else ignored)
    → Is Button Tap?
      → yes: answer the tap (dismisses the spinner) → run main workflow
      → no:  run main workflow directly
```

- The trigger is restricted to the team group chat, so stray DMs to the
  bot can't set it off.
- The main workflow sends the fresh reminder itself; this workflow sends
  nothing except the tap confirmation.

## Relationship to the main workflow

Connected through an `On-Demand Entry` trigger inside
`Next-Day Booking Reminder`. Scheduled runs enter through the schedule
trigger instead — both paths share everything downstream. Calling a
workflow requires that entry trigger to exist; scheduled-only workflows
can't be called this way.

## Everyday maintenance

- **Button text or confirmation text:** the button lives on both Send
  nodes of the main workflow (`callback_data: refresh` must stay as-is);
  the confirmation text lives on `Answer Button Tap` here. Both
  workflows need publishing after a text change.
- **Someone taps but nothing arrives:** check this workflow's Executions
  first (gate misroute or tap answer failure), then the main workflow's
  Executions (the actual reminder run).
