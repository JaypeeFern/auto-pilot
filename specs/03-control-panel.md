# 03. Operator control panel

Status: existing static source and legacy behavior; standalone service pending.

## Purpose

Give an authenticated operator a small control surface for session checks,
manual login handoff, collection, progress, review, export, and discard.

## Capabilities

The future application must provide equivalent capabilities without requiring
the legacy webhook or n8n runtime:

- load a control-panel view;
- report collector/browser authentication and Facebook reachability;
- link to the protected manual browser/noVNC surface;
- accept a followers URL and run label;
- start a human-triggered collection and acknowledge quickly;
- observe background progress and count-only activity messages;
- request cancellation;
- retrieve the latest pending result or a specific run;
- show a bounded preview of roulette rows;
- download or view the full stored JSON result where authorized;
- discard the selected pending result;
- surface unavailable collector, authentication, validation, and persistence
  failures without claiming success.

No control-panel action may expose a Facebook password, browser profile, API
credential, or raw secret-bearing provider response.

## Legacy compatibility surface

The current n8n panel used these authenticated routes. They are historical
compatibility evidence, not required future route names:

| Legacy action | Method/path | Behavior |
|---|---|---|
| Page | GET `/giveaway` | Returns the embedded HTML panel |
| State | GET `/giveaway/api/state` | Checks collector status and returns latest complete pending row |
| Start | POST `/giveaway/api/dry-run` | Accepts fields, acknowledges immediately, starts a background workflow run |
| Progress | GET `/giveaway/api/progress` | Proxies collector progress with a 10-second request timeout |
| Stop | POST `/giveaway/api/stop` | Proxies collector cancellation with a 10-second timeout |
| Results | GET `/giveaway/api/results?runId=...` | Returns summary and first 200 roulette rows; `full=1` returns full arrays |
| Discard | POST `/giveaway/api/clear` | Looks up a run and changes its status to `discarded` |

All seven legacy webhook routes used the same n8n HTTP Basic credential. The
future property is authenticated operator access; it need not use Basic Auth.

## Asynchronous behavior

Start must return an acknowledgement before a multi-minute collection ends.
The client then observes state/progress independently. A disconnected or
refreshed browser must not cancel the run by accident. A second start while a
collection is active must be rejected or clearly reported.

The legacy page polls progress every 1.5 seconds. It appends only new log
entries, displays scroll/encountered/unique counts, stops polling when the
collector becomes inactive, and then refreshes state/results.

The legacy stop control accounts for the start race: for up to 20 seconds it
retries a `{ ok: false }` "nothing running" response up to eight times at
1.5-second intervals. An undefined `ok` is treated as unreachable and is not
treated as a successful stop.

## Review and display behavior

The panel displays summary counts for encountered, unique, duplicates,
invalid/missing, roulette entries, and stop reason. It displays at most 200
roulette rows in the preview. Full results may be downloaded as JSON or shown
as escaped raw JSON. Log messages are count/state-only. User-entered URL and
label fields are retained in browser local storage when available; that is a
convenience, not the durable run record.

## Acceptance criteria

- Every privileged action requires an authenticated operator session.
- Start is fast and collection is independently observable.
- Refreshing the panel discovers an active run and latest pending result.
- Progress errors are distinguishable from collection errors.
- Preview is bounded; full export is explicitly requested and authorized.
- Discard updates the lifecycle safely and refreshes the displayed state.
