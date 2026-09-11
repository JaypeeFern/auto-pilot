# Facebook Giveaway Followers Collector

Manual-trigger-only workflow that collects every Facebook Page follower
visibly accessible to our account and prepares them as giveaway roulette
entries. Inactive by default; runs only when someone presses Execute.

## Why it exists

Giveaway draws need one entry per real follower, auditable afterwards. The
workflow scrolls the Page's visible followers list through a persistent
browser session, dedupes by profile URL (never by name — two people sharing
a name are two entries), writes an audit sheet plus a clean entries sheet,
verifies the write, and reports the result on Telegram.

## Flow, step by step

```text
Run Giveaway Collection (manual trigger only, no schedule)
  → Giveaway Config (per-run settings; dryRun DEFAULTS TRUE — see below)
    → Check Collector Status (GET /status on the browser-collector service)
      → Is Authenticated?
        → no:  Build AUTH_REQUIRED Message → Send AUTH_REQUIRED Alert (stop, explicit)
        → yes: Collect Followers via Browser (POST /collect: slow scroll, lazy-render waits)
          → Validate Dedupe and Build Rows (dedupe by URL, validation stats, never silent success)
            → Has Valid Data? (complete AND at least one roulette row)
              → no:  Build Failure Report → Send Failure Alert (Sheets untouched)
              → yes → Dry Run? (dryRun flag)
                → yes: Build Pending Payload → Store Pending Result (giveaway_runs
                       Data Table, status dry-complete) → Build Dry Report
                       → Send Dry Report (DRY RUN Telegram, Sheets untouched)
                → no:  Clear Raw Followers → Emit Raw Rows → Write Raw Followers
                     → Clear Roulette Entries → Emit Roulette Rows → Write Roulette Entries
                     → Read Roulette Entries → Verify Write Count → Write Verified?
                       → no:  Build Failure Report → Send Failure Alert (partial data flagged)
                       → yes: Build Success Report → Send Success Report
```

GUI entry: a `GUI Input` sub-workflow trigger accepts `{dryRun, runId,
followersUrl?, runLabel?}` from the Giveaway Control Panel and feeds the
same chain. "Manual-trigger-only" means no schedule or polling — every run
is human-initiated (manual Execute or panel click).

- **Auth first.** An unauthenticated or unreachable collector never reaches
  collection. HTTP nodes retry once and continue their error output into the
  alert branches, so transport failures also end in an explicit Telegram
  message, never a fake success.
- **Validation gate.** `isComplete` requires the collector's
  `stopReason: empty-threshold-reached`. Anything else (cap hit, auth lost,
  transport error, zero rows) routes to the failure branch and no Sheet is
  touched. Clears run only after validation passed.
- **Write verification.** After both tabs are written, the workflow reads
  `Roulette Entries` back and compares the row count against the expected
  entry count. A mismatch routes to the failure branch with an explicit
  "verify the tabs, then rerun" Telegram alert (clear-plus-append is
  idempotent, so a rerun restores full state). A Sheets API failure that
  stops the run mid-write fails the execution visibly instead — check
  Executions, fix, rerun; never draw from a failed run.
- **One row per unique valid profile** in `Roulette Entries`; every
  encounter (including duplicates and invalid rows, labeled) in
  `Raw Followers`.

## Browser architecture (VPS browser service)

Puppeteer cannot run inside n8n (no Chromium in the official image, no
network in Code nodes), so the explicitly requested VPS-hosted browser lives
in the `browser` Compose service (`scripts/fb-followers-collector`:
Dockerfile.browser + server.js + entrypoint.sh) — the single documented
exception to the single-container rule, with the locked n8n image, SQLite,
and 768 MB floor all intact (see docs/ARCHITECTURE.md). One persistent
Chromium profile serves both Puppeteer and manual noVNC login; n8n reaches
the collector API at `http://browser:5679` over the internal network only.
The service also runs standalone via `npm start` for local development (see
the collector README).

## Config (Giveaway Config node)

`followersUrl`, `collectorStatusUrl`/`collectorCollectUrl`
(`http://browser:5679/...` on the VPS), `spreadsheetId`, `telegramChatId`,
`runLabel`, `scrollDelayMs`, `postScrollWaitMs`, `emptyScrollThreshold`
(default 10), `maxScrollAttempts` (safety cap), `dryRun` (default TRUE),
`runId` (auto-generated unless passed in). Edit between giveaways; nothing
else in the workflow needs touching. Because dry runs are the default,
manual Executes never modify Sheets unless you explicitly set
`dryRun:false` — and the panel's Write action commits only reviewed,
verified rows without re-scraping.

## Auth handoff (VPS browser)

First run: open the noVNC browser route (Cloudflare Access + VNC password),
log into Facebook manually in the VPS Chromium window (password, 2FA,
CAPTCHA, checkpoint — all manual), fill `Giveaway Config`, Execute. The
same persistent profile serves Puppeteer and your manual session. On expiry
the run stops at `AUTH_REQUIRED`: log in again in the same browser window,
rerun. No Facebook credentials exist anywhere in n8n, env, git, logs, or
Sheets. The Giveaway Control Panel (`docs/workflows/giveaway-control-panel/WORKFLOW.md`)
shows live session status and links the noVNC window.

## Sheets

One spreadsheet (ID in config), two tabs, headers preserved across runs:

- `Raw Followers`: `displayName | profileUrl | profileId | extractedAt |
  isDuplicate (yes/no) | validationStatus (valid/duplicate/missing-name/
  invalid-id) | runLabel` — full audit trail.
- `Roulette Entries`: `displayName | profileUrl | profileId | runLabel` —
  one row per unique valid profile; `displayName` feeds the roulette,
  `profileUrl`/`profileId` verify winners.

Credential: `Google Sheets account` (shared project credential).

## Telegram

Success report carries unique follower count, duplicates removed, invalid
entries, final roulette count, scroll attempts, stop reason, and draw
readiness. Failure/`AUTH_REQUIRED`/collector-down paths send explicit
warning reports instead. Credential: `BookingScheduleBot` (swap in the UI
if another bot is preferred).

## Validation behavior

Every success report includes total encountered, unique followers,
duplicates, missing names, missing/invalid identifiers, final entry count,
scroll attempts, and stop reason. Incomplete or failed extractions never
report success.
