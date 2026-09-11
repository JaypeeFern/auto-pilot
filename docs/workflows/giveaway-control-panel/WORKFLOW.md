# Giveaway Control Panel

Private web GUI for operating the Facebook giveaway collector from a normal
desktop browser. Served by n8n itself over webhooks; every route carries
HTTP Basic authentication (webhook routes intentionally bypass Cloudflare
Access, so n8n-level auth carries the protection here — the noVNC browser
route, by contrast, sits behind Cloudflare Access plus the VNC password).

Activation order (blocking): create the GUI basic-auth credential and
attach it to all 6 webhook routes FIRST, set the real noVNC URL, then
activate. The workflow is inactive until then and serves nothing.

Inactive by default; the dry-run and commit paths only run when clicked.
No schedule anywhere — every collection is human-initiated.

## Why it exists

The collector and its Facebook session live on the VPS, not on your
desktop. This panel lets you check session status, open the VPS browser for
manual login, run a dry test that never touches Sheets, inspect the exact
rows, and commit the reviewed result without re-scraping.

## Routes (all authenticated)

- `GET /giveaway` — the control panel page (kept in `gui.html` in this
  folder; embedded into the workflow at build time).
- `GET /giveaway/api/state` — `{ authenticated, authMessage,
  facebookReachable, pending, config, novncUrl }`.
- `POST /giveaway/api/dry-run` — starts a dry collection in the background
  (acknowledges receipt immediately via onReceived; the page polls state
  for the pending run — the scrape takes minutes, past webhook timeouts).
  Runs the same extraction, scrolling, dedupe, and validation as a real run,
  stores the result as pending, sends a DRY RUN Telegram report. Writes zero
  Sheet rows.
- `GET /giveaway/api/results?runId=` — summary (all 7 stats) plus a capped
  preview of names and profile identifiers.
- `POST /giveaway/api/commit` — writes the exact reviewed pending rows to
  the two Sheets tabs (clear + append + verify, same as a direct run),
  marks the run committed, sends the success Telegram. Refuses unknown,
  already-committed, or discarded runs. Never re-scrapes Facebook.
- `POST /giveaway/api/clear` — discards a pending result.

## Dry-run vs commit

Dry runs store one `giveaway_runs` Data Table row per run (status
`dry-complete`, summary plus full raw/roulette arrays as JSON). Commit reads
that exact stored payload — the Facebook extraction is not repeated. After
committing, the run is marked `committed` and cannot be committed twice;
run a new dry test for a fresh result.

## Credentials (names only)

- GUI webhook HTTP Basic credential (operator-created, attached to every
  route).
- `Google Sheets account` (shared project credential, commit path only).
- Telegram bot credential on the panel's senders (swap in the UI if another
  bot is preferred).

## Validation behavior

Same gate as direct runs: only `empty-threshold-reached` collections with
at least one roulette row become committable. The commit path re-verifies
the Sheets write (read-back row count) and sends an explicit failure alert
on mismatch instead of reporting success.
