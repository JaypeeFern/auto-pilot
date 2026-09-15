# 01. Facebook collection contract

Status: existing collector behavior; specified and partially implemented.

## Purpose

Collect the Facebook Page followers visibly accessible to an operator's
authenticated Facebook session. Collection is human-initiated and must stop
closed when the collector cannot prove bounded completeness.

## Operator behavior

The operator opens the tool, checks session status, completes Facebook login
manually in the headed browser when required, supplies a Facebook followers
URL and optional label, and starts one collection. The tool must not automate
password entry, 2FA, CAPTCHA, checkpoint, device confirmation, or any other
Facebook login step.

There is no schedule and no autonomous Facebook collection.

## Collection request

The collector-compatible request contains:

```json
{
  "followersUrl": "https://www.facebook.com/<page>/followers/",
  "scrollDelayMs": 2500,
  "postScrollWaitMs": 2500,
  "emptyScrollThreshold": 10,
  "maxScrollAttempts": 500,
  "runLabel": "giveaway",
  "runId": "run-example"
}
```

The URL is required to be an `http` or `https` Facebook URL. The current
collector accepts `facebook.com`, its subdomains, `fb.com`, and its
subdomains for profile URLs. The configured followers page is also restricted
to Facebook. Defaults above are the current workflow values; a future
application may expose equivalent configuration but must retain bounded
defaults and validation.

## Required collector behavior

The collector must:

1. Reuse one persistent browser profile across runs and restarts.
2. Resolve the visible follower surface and its row container.
3. Capture visible profile anchors through the bounded direct-row sweep and
   bounded mutation-observer fallback.
4. Ignore blank placeholder children and non-visible/non-profile content.
5. Restrict opened URLs and returned profile URLs to the Facebook boundary.
6. Keep capture queues, mutation records, inspected nodes, direct rows, and
   canonical profiles bounded.
7. Preserve blank-name sightings as upgradeable; a later named sighting may
   upgrade the canonical record, while a later blank sighting never downgrades
   it.
8. Support one active collection at a time. A concurrent start is rejected.
9. Expose progress and cancellation without requiring the collection request
   to stay open for its full duration.
10. Return no credentials, page text, arbitrary DOM, or unbounded PII in
    telemetry or logs.

The extraction preserves the current algorithm. It does not authorize a
future agent to change Facebook selectors, deduplication, capture limits, or
stop behavior during implementation of the application shell.

## Response contract

A successful response has the existing shape:

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

The collector's `profiles` array is canonical: one record per normalized URL.
`totalEncountered` is the compatibility alias for `anchorSightings`.
`anchorRepeats` is the difference between sightings and unique profiles; rows
skipped because the canonical-profile cap was reached are reported separately
as `profileCapSkipped`.

The collector must return `authenticated: false` when authentication cannot
be positively verified. An authentication failure is not a successful empty
collection.

## Completion and failure

The only complete collector stop reason is `empty-threshold-reached`. The
bounded no-new-profile threshold is consecutive and resets when new profiles
or name upgrades appear. The following are incomplete/failure outcomes:

```text
max-attempts-reached
canceled
auth-lost
capture-buffer-overflow
capture-truncated
mutation-record-overflow
canonical-profile-cap-reached
capture-unavailable
```

Any bounded walk, mutation subtree, queue, direct-row sweep, or observer
backlog overflow must fail closed. It must never be relabeled as a complete
empty-threshold result merely because some profiles were captured.

`GET /status` reports authentication/browser reachability. `GET /progress`
reports the active state, current phase, run ID, counters, bounded telemetry,
and count-only log. `POST /cancel` requests cancellation at the next bounded
scroll/capture boundary and reports whether a run was active.

The current collector uses these observable HTTP outcomes: an unauthenticated
collection returns `401` with `authenticated: false`; a concurrent collection
returns `409`; successful collection responses use `200` even when the result
is incomplete and the `stopReason` explains why; other collector failures use
`500`; cancellation responds with a JSON acknowledgement and does not claim
that the current scroll cycle stopped synchronously. A future transport may
change status-code details only if clients retain the same semantic
distinctions.

## Acceptance criteria

- Manual authentication is the only Facebook login path.
- A persistent profile is used without exposing its contents to clients.
- A complete run has the exact stop reason above and at least the collector's
  truthful bounded statistics.
- Incomplete, canceled, unauthenticated, concurrent, or overflowed runs are
  distinguishable from complete runs.
- The collector's existing tests and behavior remain intact.
