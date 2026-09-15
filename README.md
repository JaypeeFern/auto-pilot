# Facebook Giveaway Tool

Standalone runtime for the operator-run Facebook follower collector and its
control-panel source. This repository contains the headed Chromium/Puppeteer
service, persistent Facebook browser profile, VNC/noVNC access, tests, and
focused deployment documentation. It does not contain n8n.

## Runtime

`docker compose up -d --build` starts the `browser` service. The service
exposes the collector API internally on `5679`, VNC on `5900`, and noVNC on
`6080`; no host ports are published by this Compose file. Route noVNC through a
protected deployment proxy and require both its access policy and the VNC
password. Keep the `browser_profile` volume persistent: it contains the
operator's Facebook session.

The collector uses the existing implementation in `collector/server.js`.
Behavior, bounded capture limits, authentication handoff, and response shape
are unchanged by this extraction.

## n8n integration

The AutoPilot n8n workflows remain in their original repository. They call
`POST /collect` and `GET /status`; see [docs/INTEGRATION.md](docs/INTEGRATION.md)
for the preserved request/response contract and deployment boundary.

The source control-panel page is [web/control-panel.html](web/control-panel.html).
It is served/connected by the existing n8n control-panel workflow; this tool
branch does not recreate or alter that workflow.

## Local development

```text
cd collector
npm install
npm test
npm start
```

For local headed operation, provide a writable profile directory and the
required environment variables described in `collector/README.md`.
