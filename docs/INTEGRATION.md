# n8n integration contract

AutoPilot owns the n8n automation and exported workflow definitions. This
tool owns the Facebook browser runtime. The separation is operational: n8n
must be able to reach the collector privately, but the collector API and
Facebook profile must not be publicly exposed.

## Preserved endpoints

- `GET /status` — reports collector/browser authentication state.
- `POST /collect` — starts one operator-triggered collection.

The collection request accepts the existing JSON fields:

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

The response remains the collector's existing `{ ok, authenticated,
profiles, stats, error }` shape. Profiles and bounded completeness/error
metadata are intentionally not transformed here.

The current AutoPilot workflow contains `http://browser:5679` as its
deployment-network URL. That value is preserved in the n8n export and is not
silently rewritten during extraction. When the two applications are deployed
separately, provide an equivalent private DNS/network route or update the
workflow deliberately as part of that later migration.

Facebook login, 2FA, captcha, and checkpoint handling remain manual through
the headed Chromium window over protected noVNC. No Facebook credentials enter
n8n or this repository.
