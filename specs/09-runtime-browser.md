# 09. Runtime and browser requirements

Status: existing runtime; specified and partially implemented.

## Verified current runtime

These are current implementation facts preserved from the extracted tool and
the old workflow contract:

- headed Chromium controlled by Puppeteer;
- Xvfb display with a lightweight window manager;
- VNC on container port `5900` and noVNC/websockify on `6080`;
- collector API on `5679`;
- persistent profile mounted at `/profile`;
- default viewport `1366x900`;
- default collector navigation timeout `60000` ms;
- collector HTTP request timeout in the workflow: `3600000` ms;
- progress request timeout: `10000` ms;
- status request timeout: `15000` ms;
- cancel request timeout: `10000` ms;
- bounded defaults: queue `4096`, mutation nodes `512`, initial nodes
  `10000`, mutation records `2048`, direct rows `20000`, canonical profiles
  `20000`;
- default scroll delay and post-scroll wait `2500` ms, empty threshold `10`,
  maximum scroll attempts `500`;
- browser memory ceiling `768 MB` in the extracted Compose runtime.

These values are behavioral safety defaults and compatibility facts. A future
implementation may make appropriate values configurable, but changing a
bound, timeout, viewport, or memory budget requires a new validation decision
and must preserve fail-closed completeness.

## Requirement versus implementation choice

| Item | Classification |
|---|---|
| Manual headed browser and persistent Facebook session | Verified product/runtime requirement |
| Collector API operations `/status`, `/collect`, `/progress`, `/cancel` | Existing external contract |
| Private API and protected manual browser access | Security requirement |
| Puppeteer, Node, Docker Compose, service name `browser` | Current implementation choices |
| Ports `5679/5900/6080` | Current compatibility contract; may change only deliberately |
| Xvfb/openbox/websockify | Current runtime implementation choices |
| 768 MB browser ceiling and `1366x900` viewport | Verified current safety defaults; revalidate before changing |
| SQLite/Data Table | Legacy AutoPilot storage implementation, not a future requirement |
| n8n webhook/API route names | Legacy control-panel compatibility surface, not required architecture |

## Restart and failure behavior

The profile must survive browser container restarts. If the browser is
unreachable, status/progress/cancel actions must report an unavailable
dependency rather than a successful empty state. If the session expires, the
operator must log in again manually and rerun. A browser or collector process
restart must not turn a partial capture into a complete run.

No production redeploy, profile deletion, Facebook session migration, or
runtime redesign is part of this specification migration.

## Acceptance criteria

- The extracted collector implementation remains unchanged by spec creation.
- Runtime limits and endpoints are documented with their classification.
- Browser/profile persistence and private access remain explicit.
- Future stack selection can replace Docker/Puppeteer/n8n without changing
  the behavioral contract.
