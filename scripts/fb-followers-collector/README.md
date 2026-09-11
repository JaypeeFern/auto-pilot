# fb-followers-collector

Operator-run Puppeteer service with a **persistent Chromium profile** that
collects the Facebook Page followers visibly accessible to your account. It
exists because the n8n container has no Chromium and n8n Code nodes have no
network access — Puppeteer cannot run inside n8n, and the project's locked
single-container image plus the 768 MB ceiling rule out a custom image or a
Compose sidecar. n8n drives this service over HTTP; the browser never leaves
your machine.

## Install

```bash
cd scripts/fb-followers-collector
npm install
```

## Run (production: browser container on the VPS)

The collector runs inside the `browser` Compose service (headed Chromium
under Xvfb, persistent `/profile`, noVNC on 6080, API on 5679 for n8n
only). Deploy via Coolify per docs/DEPLOYMENT.md — no local install needed
for normal operation.

## Run (local development only)

```bash
npm start
# listening on http://127.0.0.1:5679, profile in ./fb-giveaway-profile
```

| Env var | Default | Meaning |
|---|---|---|
| `COLLECTOR_BIND` | `0.0.0.0` | Binds the container network so n8n can reach the API.
Local runs may set `127.0.0.1`. Any non-loopback bind requires
`COLLECTOR_ALLOW_NON_LOOPBACK=true`; the port is still never published or
routed publicly. |
| `COLLECTOR_ALLOW_NON_LOOPBACK` | `false` | Explicit opt-in for a non-loopback bind. Set `true`
in Compose (container network only). |
| `COLLECTOR_PORT` | `5679` | Port. Must match the `collectorStatusUrl`/`collectorCollectUrl` in the workflow's `Giveaway Config` (`http://browser:5679/...` on the VPS). |
| `COLLECTOR_PROFILE_DIR` | `/profile` | Persistent Chromium profile (volume in Compose,
`./fb-giveaway-profile` for local runs). Login state lives here between runs. |
| `CHROME_PATH` | (unset: bundled Chromium) | Set to `/usr/bin/chromium` in the browser image. |
| `COLLECTOR_HEADLESS` | `false` | Keep `false` so you can log in interactively. |
| `COLLECTOR_NAV_TIMEOUT_MS` | `60000` | Page navigation timeout. |

## First login (manual handoff)

1. Start the service (`npm start`). On the first `GET /status` or
   `POST /collect` request it launches a Chromium window using the
   dedicated profile (a fresh, empty profile on first run).
2. In THAT window, go to facebook.com and log in yourself: password, 2FA,
   CAPTCHA, checkpoint, device confirmation — all manual. The workflow and
   this service never automate any of that and never see your credentials.
3. In n8n, open `Facebook Giveaway Followers Collector`, fill `Giveaway
   Config` (followers URL, spreadsheet ID, Telegram chat ID, run label),
   and Execute. `Check Collector Status` verifies the session before any
   collection starts.

## When Facebook expires the session

The workflow stops at `AUTH_REQUIRED` (Telegram alert included). Repeat the
handoff: make sure the service is running, log in again in its browser
window, rerun the workflow. Future runs reuse the profile until Facebook
invalidates it again.

## Endpoints (n8n contract)

- `GET /status` → `{ ok, authenticated, profileDir, facebookReachable,
  message }`. `authenticated: false` whenever login cannot be positively
  verified (fail-safe: the workflow stops instead of scraping a login wall).
  `facebookReachable: false` when the probe navigation itself failed
  (network/DNS down) — treat the run as not attempted.
- `POST /collect` with `{ followersUrl, scrollDelayMs, postScrollWaitMs,
  emptyScrollThreshold, maxScrollAttempts, runLabel }` → `{ ok,
  authenticated, profiles: [{ displayName, profileUrl }], stats: {
  totalEncountered, scrollAttempts, stopReason, runLabel } }`.
  `stopReason` is `empty-threshold-reached` on a complete run,
  `max-attempts-reached` if the safety cap hit, `auth-lost` if the
  session was challenged mid-run, or `canceled` if `POST /cancel` stopped it.
  `401` with `authenticated: false` means `AUTH_REQUIRED`. `409` means a run
  is already in progress (one at a time — no parallel scraping).
- `POST /cancel` (no body) → `{ ok: true, message }` and the in-progress
  `/collect` run stops at the next scroll-cycle boundary (`stopReason:
  'canceled'` in its result and in `/progress`), or `{ ok: false, error }`
  if nothing is running. Always returns `200`.
- `GET /progress` → `{ active, runId, phase, startedAt, updatedAt,
  scrollAttempts, totalEncountered, uniqueFollowers, stopReason, error,
  collectBusy, log: [{ at, phase, message }] }`. Polled by the Control Panel
  GUI during a run so an operator can watch progress without opening noVNC.
  Reflects the most recent run once one has started; `active: false` and
  `phase: 'idle'` before the first run. Log messages are counts only, same
  rule as everywhere else in this service — never follower names or URLs.

## Collection behavior

Slow scroll of the followers surface with conservative waits so lazy-loaded
content renders; accuracy over speed. Extraction is restricted to rendered
(non-zero-size) profile links inside the followers dialog when Facebook
renders one, else the main column — anchors elsewhere on the page and
hidden/unrendered anchors are skipped, relative hrefs are absolutized, and
only facebook.com/fb.com hosts are accepted (strict host allowlist, so
lookalike domains can never pass). This is a DOM heuristic, not a
guarantee: audit every run via the workflow's `Raw Followers` sheet before
drawing. Every encounter is returned, including repeats — n8n dedupes by
profile URL and records duplicate status per row. Stops after
`emptyScrollThreshold` (default 10) consecutive scrolls with zero new unique
profiles, resets the counter whenever new profiles appear. Dedupe key is the
normalized profile URL (tracking params stripped, `id=` matched
case-insensitively, case folded) — never the display name. Only
`facebook.com` follower URLs are ever opened; any other host is refused.
Only normally visible follower entries are read; hidden/private data and
security/privacy controls are never bypassed.

## Reaching the collector (production vs local dev)

Production: the collector runs in the `browser` service on the same Compose
network as n8n, so the workflow uses `http://browser:5679/status` and
`http://browser:5679/collect` directly — no tunnel, no host networking.
Verify from the VPS with
`docker exec auto-pilot-n8n node -e "fetch('http://browser:5679/status').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"`.

Local development only (collector via `npm start` on your machine, n8n
elsewhere): point `Giveaway Config` at a reverse SSH tunnel that lands where
n8n can reach it, e.g.
`ssh -N -R 127.0.0.1:5679:127.0.0.1:5679 <your-vps-user>@<your-vps-host>`
(autossh variant for persistence), then verify with the workflow's own
`Check Collector Status` run before collecting.

## Security notes

- Loopback-only (enforced at startup). If n8n must reach this host remotely,
  use the reverse SSH tunnel above — do not put it on a public port.
- Server logs contain counts only, never follower names, URLs, or page
  content.
- No Facebook username/password anywhere: not in n8n, not in env, not in
  git, not in logs, not in Sheets.
