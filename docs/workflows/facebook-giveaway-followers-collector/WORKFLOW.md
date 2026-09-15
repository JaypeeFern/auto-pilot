# Facebook Giveaway Followers Collector

Manual-trigger-only workflow that collects Facebook Page followers visibly
accessible to the logged-in account and stores a reviewed result for the
giveaway control panel. It does not schedule, activate, or automate Facebook
login.

## Flow

```text
Run Giveaway Collection / GUI Input
  → Giveaway Config
    → Collect Followers via Browser (POST /collect)
      → Is Authenticated?
        → no: stop with AUTH_REQUIRED
        → yes: Validate Dedupe and Build Rows
          → Normalize Canonical Contract
            → Has Valid Data?
              → no: stop without storing a draw-ready result
              → yes: Build Pending Payload → Store Pending Result
```

`GUI Input` accepts `{ dryRun, runId, followersUrl?, runLabel? }` from the
Giveaway Control Panel. The current workflow stores the result in the
`giveaway_runs` Data Table for the panel's live log, preview, and JSON
download. There is no schedule, external Sheets write, Telegram report, or
separate status request in this workflow.

## Collector contract

`POST /collect` accepts `followersUrl`, `scrollDelayMs`, `postScrollWaitMs`,
`emptyScrollThreshold`, `maxScrollAttempts`, `runLabel`, and `runId`.

Successful responses contain:

```json
{
  "ok": true,
  "authenticated": true,
  "profiles": [
    { "displayName": "", "profileUrl": "https://www.facebook.com/..." }
  ],
  "stats": {
    "totalEncountered": 0,
    "anchorSightings": 0,
    "anchorRepeats": 0,
    "profileCapSkipped": 0,
    "nameUpgrades": 0,
    "uniqueFollowers": 0,
    "scrollAttempts": 0,
    "stopReason": "empty-threshold-reached",
    "runLabel": "giveaway",
    "telemetry": {}
  }
}
```

`profiles` is already canonical: exactly one profile per normalized URL.
`totalEncountered` is the compatibility alias for `anchorSightings`.
`anchorRepeats` is `anchorSightings - uniqueFollowers`, never a guess based on
the returned array; `profileCapSkipped` is excluded from that repeat count when
the bounded canonical-profile cap stops a run. A blank display name remains eligible for a later sighting
to upgrade; a named profile is never downgraded by a later blank sighting.
`nameUpgrades` counts blank-to-named upgrades.

The collector resolves the follower-row container and, after each scroll
boundary, sweeps its direct children. For each child it takes the first
Facebook link with non-empty text and ignores blank placeholder children. The
bounded `MutationObserver` queue remains attached to the resolved followers
surface as a fallback for transient rows and name changes. The direct-row cap
and queue both fail the run closed on truncation or overflow rather than
silently dropping data. No permanent `data-*` markers or unbounded page-level
URL cache is used.

`telemetry` is bounded and PII-free. It contains capture wait/read time,
mutation and capture counts, direct-row sweep counts, queue high-water/drops,
bounded descendant count for the resolved surface, scroll geometry, browser
heap samples when available, Node heap/RSS, and elapsed time. It never contains
names, URLs, page text, or credentials.
`GET /progress` exposes the same counters and telemetry for the panel; its log
messages are counts and stop states only.

## Completeness and draw readiness

The validation node accepts a draw only when `ok === true` and
`stopReason === 'empty-threshold-reached'`. It also requires at least one
named, valid roulette entry. `readyForDraw` is therefore
`isComplete && finalRouletteCount > 0`.

The stored summary includes `anchorSightings`, `anchorRepeats`,
`profileCapSkipped`, `nameUpgrades`, `uniqueFollowers`, `totalEncountered`, `scrollAttempts`,
`stopReason`, `missingNames`, `invalidIds`, `finalRouletteCount`,
`readyForDraw`, and the bounded telemetry object. `rawRowsJson` contains one
canonical row per profile; `rouletteRowsJson` contains the named valid rows.
`duplicatesRemoved` remains as a display-compatible alias for
`anchorRepeats`.

Incomplete stop reasons include `max-attempts-reached`, `canceled`,
`auth-lost`, `capture-buffer-overflow`, `capture-truncated`,
`mutation-record-overflow`, `canonical-profile-cap-reached`, and
`capture-unavailable`. Any bounded-walk, mutation-subtree, queue, or observer
backlog overflow fails closed and cannot become `empty-threshold-reached`.
An auth challenge returns `401` with `authenticated:false`; cancellation is
checked at the bounded scroll/capture boundaries. None of these paths is
draw-ready.

## Browser and security boundary

The browser service runs the pinned Chromium/Puppeteer collector with a
persistent profile. Login, password, 2FA, CAPTCHA, checkpoints, and device
confirmation remain manual in noVNC. The service never accepts, stores, logs,
or forwards Facebook credentials.

Production uses `http://browser:5679` on the private Compose network. The
collector API is not publicly routed. The browser keeps the known-safe
`1366x900` viewport default and the Compose browser service retains its
`768 MB` memory ceiling, raised from `640 MB` after observed Chromium renderer
crashes during long collections. Do not raise either limit further without a
separately verified memory result.

Only Facebook/fb.com profile URLs that pass the collector's strict boundary
checks are accepted. The configured followers URL is also restricted to
Facebook. The workflow stores credential-free result data only; never place
tokens, passwords, chat IDs, or other secrets in this page or the export.

## Configuration

Edit `Giveaway Config` between manual runs when needed:

- `followersUrl`: Facebook followers page.
- `runLabel`: operator-facing label.
- `scrollDelayMs` and `postScrollWaitMs`: bounded event-wait limits.
- `emptyScrollThreshold`: consecutive no-new-profile scrolls before a
  complete stop (default `10`).
- `maxScrollAttempts`: hard scroll safety cap (default `500`).
- `dryRun`: retained for the panel input contract; the current flow always
  stores a pending result and does not write external systems.

Before a run, log in manually through noVNC. If the session expires, resolve
the Facebook challenge in that same browser profile and rerun. Do not claim a
successful live Facebook/provider extraction from static validation alone.
