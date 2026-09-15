# 04. Results, canonicalization, and draw readiness

Status: validation logic exists in the legacy workflow; standalone persistence
and presentation are pending.

## Purpose

Turn a collector response into a truthful, reviewable result without losing
audit-relevant rows or admitting an incomplete collection to the draw.

## URL and identifier rules

For each returned profile:

1. Trim the URL.
2. Remove the fragment.
3. If a query exists, retain only a numeric `id` query as `?id=<digits>`;
   other query parameters are discarded.
4. Remove trailing slashes and lowercase the normalized URL.
5. Derive `profileId` as `id:<digits>` for a numeric query ID; otherwise use
   the final non-empty path segment, lowercased.
6. Accept only `facebook.com`/subdomains and `fb.com`/subdomains with a
   non-empty profile ID.

The configured followers URL is subject to the same Facebook host boundary.
Display names are never identifiers and must not be used for deduplication.

## Canonical deduplication

The collector normally already returns canonical profiles, but validation must
remain defensive. Group by normalized URL. For each key, prefer the first
non-empty name observed anywhere in the input. The canonical row is the first
row matching that preferred name, or the first row if no name exists. Later
blank sightings cannot replace a named row. Empty normalized keys are not
forced into a shared duplicate bucket.

Count:

- `missingNames`: every input profile whose trimmed name is empty;
- `invalidIds`: every input profile failing the URL/ID boundary;
- `duplicatesRemoved`: every non-canonical duplicate, compatible with the
  collector's `anchorRepeats` terminology;
- `uniqueFollowers`: canonical non-empty normalized keys;
- `finalRouletteCount`: canonical rows with valid ID and non-empty name.

Retain one canonical row per profile in `rawRows`, including invalid or
missing-name rows, with `displayName`, `profileUrl`, `profileId`, extraction
time, duplicate marker, validation status, and run label. Retain only valid,
named canonical rows in `rouletteRows`.

## Completeness gate

The result is complete only when:

```text
collector ok == true
AND stopReason == "empty-threshold-reached"
```

It is draw-ready only when complete and `finalRouletteCount > 0`. A canceled,
auth-lost, max-attempt, overflow, truncation, cap, unavailable, or unknown
stop reason is never draw-ready, even when rows exist.

The validation summary must include at least run ID, label, encountered,
unique, duplicates, missing names, invalid IDs, roulette count, scroll
attempts, stop reason, and readiness. Preserve bounded collector statistics
and telemetry when the record contract retains them; do not claim completeness
from a fallback array length alone.

## Results retrieval

An unknown run ID returns a controlled not-found result and never a successful
empty result. A known run returns its status and summary. A bounded preview is
the default. Full raw and roulette arrays require an explicit authorized
request. Malformed stored JSON must be treated as corrupt data and refused for
commit; the legacy panel fell back to empty arrays for display, which is not a
safe future commit behavior.

## Acceptance criteria

- URL normalization, host validation, ID derivation, name upgrade, and counts
  match the rules above.
- Draw readiness is impossible for incomplete or empty named results.
- The exact validated arrays are preserved for review and later commit.
- Unknown/corrupt results never look successfully ready.
- Preview and telemetry exposure remain bounded and credential-free.
