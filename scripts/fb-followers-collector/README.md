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
| `COLLECTOR_PORT` | `5679` | Port. Must match the `collectorCollectUrl` in the workflow's `Giveaway Config` (`http://browser:5679/collect` on the VPS). The collection request performs its own authentication check. |
| `COLLECTOR_PROFILE_DIR` | `/profile` | Persistent Chromium profile (volume in Compose,
`./fb-giveaway-profile` for local runs). Login state lives here between runs. |
| `CHROME_PATH` | (unset: bundled Chromium) | Set to `/usr/bin/chromium` in the browser image. |
| `COLLECTOR_HEADLESS` | `false` | Keep `false` so you can log in interactively. |
| `COLLECTOR_NAV_TIMEOUT_MS` | `60000` | Page navigation timeout. |
| `COLLECTOR_CAPTURE_QUEUE_LIMIT` | `4096` | Maximum pending incremental captures per run; overflow fails completeness. |
| `COLLECTOR_CAPTURE_MUTATION_NODE_LIMIT` | `512` | Maximum nodes inspected per mutation/initial bounded walk. |
| `COLLECTOR_CAPTURE_INITIAL_NODE_LIMIT` | `10000` | Maximum nodes inspected while resolving/capturing the initial surface. Truncation fails completeness. |
| `COLLECTOR_CAPTURE_MUTATION_RECORD_LIMIT` | `2048` | Maximum pending MutationObserver records between capture drains. Overflow fails completeness for that batch. |
| `COLLECTOR_MAX_CANONICAL_PROFILES` | `20000` | Maximum canonical profiles retained per run; the cap fails completeness. |

## First login (manual handoff)

1. Start the service (`npm start`). On the first `GET /status` or
   `POST /collect` request it launches a Chromium window using the
   dedicated profile (a fresh, empty profile on first run).
2. In THAT window, go to facebook.com and log in yourself: password, 2FA,
   CAPTCHA, checkpoint, device confirmation — all manual. The workflow and
   this service never automate any of that and never see your credentials.
3. In n8n, open `Facebook Giveaway Followers Collector`, fill `Giveaway
   Config` (followers URL and run label), and Execute. The collection request
   performs its own fail-closed auth check.

## When Facebook expires the session

The workflow stops at `AUTH_REQUIRED`. Repeat the handoff: make sure the
service is running, log in again in its browser window, rerun the workflow.
Future runs reuse the profile until Facebook invalidates it again.

## Endpoints (n8n contract)

- `GET /status` → `{ ok, authenticated, profileDir, facebookReachable,
  message }`. `authenticated: false` whenever login cannot be positively
  verified (fail-safe: the workflow stops instead of scraping a login wall).
  `facebookReachable: false` when the probe navigation itself failed
  (network/DNS down) — treat the run as not attempted.
- `POST /collect` with `{ followersUrl, scrollDelayMs, postScrollWaitMs,
  emptyScrollThreshold, maxScrollAttempts, runLabel, runId }` → `{ ok,
  authenticated, profiles: [{ displayName, profileUrl }], stats: {
  totalEncountered, anchorSightings, anchorRepeats, profileCapSkipped, nameUpgrades,
  uniqueFollowers, scrollAttempts, stopReason, runLabel, telemetry } }`.
  `profiles` is one canonical profile per normalized URL. A blank name can
  be upgraded by a later sighting; it is never frozen or discarded by a
  DOM marker. `totalEncountered` aliases `anchorSightings`, while
  `anchorRepeats` is the truthful difference between sightings and unique
  profiles.
  `stopReason` is `empty-threshold-reached` on a complete run,
  `max-attempts-reached` if the safety cap hit, `auth-lost` if the
  session was challenged mid-run, `canceled` if `POST /cancel` stopped it,
  or `capture-buffer-overflow`/`capture-truncated`/
  `mutation-record-overflow`/`canonical-profile-cap-reached`/
  `capture-unavailable` when bounded capture cannot prove a complete result.
  `401` with `authenticated: false` means `AUTH_REQUIRED`. `409` means a run
  is already in progress (one at a time — no parallel scraping).
- `POST /cancel` (no body) → `{ ok: true, message }` and the in-progress
  `/collect` run stops at the next scroll-cycle boundary (`stopReason:
  'canceled'` in its result and in `/progress`), or `{ ok: false, error }`
  if nothing is running. Always returns `200`.
- `GET /progress` → `{ active, runId, phase, startedAt, updatedAt,
  scrollAttempts, totalEncountered, anchorSightings, anchorRepeats,
  nameUpgrades, uniqueFollowers, stopReason, error, telemetry, collectBusy,
  log: [{ at, phase, message }] }`. Polled by the Control Panel GUI during a
  run so an operator can watch progress without opening noVNC.
  Reflects the most recent run once one has started; `active: false` and
  `phase: 'idle'` before the first run. Log messages are counts only, same
  rule as everywhere else in this service — never follower names or URLs.

## Collection behavior

The collector resolves the actual scroll container in the followers dialog or
main surface, installs one bounded `MutationObserver`, and waits on capture or
scroll events with bounded timeouts. It does not rescan all anchors on every
scroll, use a permanent `data-*` marker, or keep an unbounded page cache.
Extraction is restricted to rendered (non-zero-size) anchors in that surface;
relative hrefs are absolutized, and only facebook.com/fb.com hosts are
accepted. Only normally visible follower entries are read; hidden/private
data and security/privacy controls are never bypassed.

The observer queue is finite and blank-name captures stay retryable. The
collector returns one canonical profile per normalized URL and upgrades its
name when a later named sighting arrives. `telemetry` is bounded and PII-free:
capture timing, mutation/capture counts, queue pressure, bounded surface
descendant count,
scroll geometry, browser heap samples when available, and Node heap/RSS. It
never includes follower names, URLs, page text, or credentials. Stops after
`emptyScrollThreshold` (default 10) consecutive scrolls with zero new unique
profiles, resets the counter whenever new profiles or name upgrades appear. Only
`facebook.com` follower URLs are ever opened; any other host is refused.

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
the collection request's own auth check before collecting.

## Security notes

- Loopback-only (enforced at startup). If n8n must reach this host remotely,
  use the reverse SSH tunnel above — do not put it on a public port.
- Server logs contain counts only, never follower names, URLs, or page
  content.
- No Facebook username/password anywhere: not in n8n, not in env, not in
  git, not in logs, not in Sheets.
