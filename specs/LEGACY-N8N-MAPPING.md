# Legacy n8n traceability and coverage audit

This mapping was produced by inspecting the exported JSON on AutoPilot main
before removal. The authoritative source revisions were `c57b24d` (the
workflow export immediately before the prior extraction cleanup) and the
working tree state at `abc9b6b`. The two giveaway workflow IDs are:

- `IYAP2evHsmMccCQA` — Facebook Giveaway Followers Collector.
- `46RugKER0tM14fnu` — Giveaway Control Panel.

Node names and n8n types below are provenance only. They are not requirements
to use n8n, webhooks, Code nodes, Data Tables, or a particular persistence
technology.

## Collection workflow mapping

| Legacy node/path | Observed behavior | Spec | Classification |
|---|---|---|---|
| `Run Giveaway Collection` / manual trigger | Human starts a run; no schedule | 01, 02 | SPECIFIED |
| `GUI Input` / execute-workflow trigger | Accepts passthrough panel input | 02, 03 | SPECIFIED |
| `Giveaway Config` | Applies followers URL, collector URL, label, timing, thresholds, and run ID defaults | 01, 02, 09 | SPECIFIED; URL is implementation detail |
| `Collect Followers via Browser` | POSTs the full bounded request; 1-hour timeout | 01, 09 | SPECIFIED |
| `Is Authenticated?` | Continues only when returned `authenticated` is true; false branch ends | 01, 04 | SPECIFIED |
| `Validate Dedupe and Build Rows` | Normalizes IDs/URLs, prefers named sightings, counts invalid/missing/duplicates, builds raw and roulette rows | 04 | SPECIFIED |
| `Has Valid Data?` | Requires complete stop reason and at least one roulette row | 04 | SPECIFIED |
| `Build Pending Payload` | Serializes summary and exact raw/roulette arrays with status `complete` | 02, 04 | SPECIFIED |
| `Store Pending Result` | Persists one result in `giveaway_runs`; includes unused `telegramChatId` field | 02, 07 | SPECIFIED; Data Table/JSON storage is implementation detail |
| Architecture/auth sticky note | Manual auth, private collector, no Sheets/Telegram, no schedule | 01, 06, 07, 08, 09 | SPECIFIED |
| Config/auth sticky note | Operator edits settings; URL-based dedupe; stored result | 01, 04 | SPECIFIED |

### Collection workflow paths

```text
manual trigger OR GUI input
  -> config
  -> POST collector /collect
  -> authenticated true?
       no  -> terminate without storing a draw-ready result
       yes -> normalize/dedupe/validate
             -> complete and roulette count > 0?
                  no  -> terminate without storing
                  yes -> serialize exact result
                        -> persist status=complete
```

Collector failure/non-2xx behavior is an n8n execution failure rather than a
custom stored failure record. That limitation is preserved as historical
behavior; the standalone lifecycle spec adds explicit non-committable failure
state as a future requirement.

## Control-panel workflow mapping

| Legacy node/path | Observed behavior | Spec | Classification |
|---|---|---|---|
| `GET Page` `/giveaway` | Basic-authenticated HTML page | 03, 08 | SPECIFIED; exact path is legacy compatibility |
| `GUI Config` / `State Config` | Sets panel API base, noVNC URL, collector status URL, defaults | 03, 09 | SPECIFIED; concrete URLs are deployment details |
| `Build Page` | Embeds panel, explicit auth headers, local storage, polling, preview/export, stop retry | 03, 08 | SPECIFIED; HTML/JS is implementation detail |
| `Respond HTML` | Returns HTML content type | 03 | IMPLEMENTATION DETAIL |
| `GET State` `/giveaway/api/state` | Basic auth; checks `/status?fresh=1`; reads one status=`complete` row; returns auth, reachability, pending summary, config, noVNC URL | 03, 09 | SPECIFIED |
| `Check Browser Status` | 15-second request to collector status; errors abort normal response | 01, 03 | SPECIFIED |
| `Latest Pending` | Reads one complete row with limit 1 and ordering enabled | 02, 03 | SPECIFIED; exact persistence ordering was not named |
| `Build State` / `Respond State` | Maps status to panel state; no pending row becomes `null` | 03 | SPECIFIED |
| `POST Dry Run` `/giveaway/api/dry-run` | Basic auth; accepts body; default webhook acknowledgement; starts subworkflow asynchronously from panel perspective | 02, 03 | SPECIFIED; route name is legacy |
| `Dry Config` / `Build Dry Input` | Defaults fields; generates `gui-<epoch ms>` run ID; ignores caller run ID | 02, 03 | SPECIFIED; ID format is implementation detail |
| `Execute Collector` | Invokes collection workflow by ID | 02 | SPECIFIED; n8n execution is implementation detail |
| `GET Progress` `/giveaway/api/progress` | Basic auth; proxies `/progress` with 10-second timeout | 01, 03 | SPECIFIED |
| `Check Progress` / `Respond Progress` | Fetches and returns collector progress JSON | 01, 03 | SPECIFIED; proxy nodes are implementation detail |
| `POST Stop` `/giveaway/api/stop` | Basic auth; proxies POST `/cancel` with 10-second timeout | 01, 03 | SPECIFIED |
| `Stop Collector` / `Respond Stop` | Requests cancellation and returns collector acknowledgement | 01, 03 | SPECIFIED; proxy nodes are implementation detail |
| `GET Results` `/giveaway/api/results` | Reads by run ID; default first 200 preview; `full=1` returns full raw/roulette arrays | 03, 04, 08 | SPECIFIED |
| `Read Pending By RunId` | Selects rows matching the requested run ID before result shaping | 02, 03, 04 | SPECIFIED; persistence query is implementation detail |
| `Build Results` | Unknown ID returns controlled error; parses summary/arrays; legacy malformed JSON falls back to empty arrays | 04 | SPECIFIED; safe corruption handling supersedes unsafe fallback |
| `Respond Results` | Returns the shaped result JSON | 03, 04 | IMPLEMENTATION DETAIL |
| `POST Clear` `/giveaway/api/clear` | Reads by run ID then updates status to `discarded` | 05 | SPECIFIED with legacy safety gap recorded |
| `Read Clear Pending` | Selects rows matching the requested run ID for discard validation | 05 | IMPLEMENTATION DETAIL |
| `Require Existing` / `Clearable?` | Requires existence only; does not require pending status | 05 | INTENTIONALLY NOT PRESERVED as desired behavior; discrepancy recorded |
| `Mark Discarded` / `Respond Cleared` | Writes discarded status and responds | 05 | SPECIFIED |
| `Respond Clear Refused` | Unknown run receives refusal branch | 05 | SPECIFIED |
| Activation sticky note | All 7 webhooks require GUI credential before service; collector workflow stays inactive | 03, 08 | SPECIFIED as security property; n8n activation is implementation detail |

## Integration audit

| Area | Current JSON evidence | Classification |
|---|---|---|
| Google Sheets | No nodes, credentials, destinations, or writes in either current giveaway export | INTENTIONALLY OBSOLETE; see 06 |
| Telegram | No nodes or sends; unused `telegramChatId` column remains; metadata says reporting was removed | INTENTIONALLY OBSOLETE; see 07 |
| Facebook collector | HTTP calls to `/status`, `/collect`, `/progress`, `/cancel`; private browser dependency | SPECIFIED in 01 and 09 |
| Persistence | Data Table named `giveaway_runs` with complete/discarded states | SPECIFIED in 02 and 05; storage technology not preserved |
| Authentication | One Basic credential on all seven panel webhooks; collector auth is separate and manual | SPECIFIED security property in 08 |

## Documentation discrepancies resolved

1. The control-panel markdown claimed `POST /commit`, Google Sheets writes,
   clear/append/read-back verification, and Telegram notifications. None are
   present in the current JSON. Specs 05–07 record the discrepancy and do not
   claim those features were implemented.
2. The control-panel markdown said clear applied to a pending result. The JSON
   checks only row existence and can change any matching row to discarded.
   Spec 05 records the observed behavior and requires stricter future guards.
3. The collector workflow documentation describes some collector fields more
   fully than the payload summary actually persisted. Spec 02 requires the
   standalone record to retain safety-relevant bounded fields rather than
   silently repeating that loss.

## Coverage result

Every meaningful node, connected branch, panel path, collector operation,
validation rule, persistence field, security assumption, and documented
integration claim was classified as one of:

- **SPECIFIED** — represented in the implementation-neutral specs;
- **INTENTIONALLY OBSOLETE** — explicitly absent/removed and documented as
  such;
- **IMPLEMENTATION DETAIL ONLY** — not carried into the future architecture;
- **DOCUMENTATION DISCREPANCY** — stale prose recorded and resolved against
  JSON evidence.

There is no unexplained current workflow behavior blocking deletion. The
legacy gaps (non-persisted failure state, permissive discard, unspecified
latest-row ordering, and absent commit/integrations) are explicit. No final
technology stack was selected and no migrated application feature was
implemented by this specification migration.
