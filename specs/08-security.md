# 08. Security and privacy requirements

Status: specified; collector/runtime protections exist, application lifecycle
protections are pending.

## Operator access

All control-panel actions and result data require authenticated operator
access. Authorization must be checked server-side for every action, including
status, progress, result retrieval, download, start, stop, discard, and future
commit. A UI login or proxy gate alone is not evidence that an API action is
protected.

The future mechanism is deliberately unspecified. The current n8n routes used
one HTTP Basic credential and webhook routes bypassed the external Cloudflare
Access layer; that is historical topology, not a requirement to retain Basic
Auth.

## Facebook and browser boundary

- Facebook login is always manual in the headed browser.
- Facebook passwords, 2FA material, CAPTCHA responses, and cookies never enter
  the application request, n8n, client JavaScript, logs, or source control.
- The browser profile is private persistent state. It must not be downloadable,
  rendered into the panel, or included in normal result exports.
- The collector API is reachable only through a private authenticated/trusted
  application path. Do not publish it as an unauthenticated public endpoint.
- noVNC/VNC access is separately protected by deployment access control and a
  VNC password; the exact proxy product is not fixed here.

## Provider secrets

Any future destination credentials, including Google or Telegram credentials,
must be server-side secrets managed outside source control. They must not be
placed in client code, run rows, preview data, workflow exports, URLs, logs,
or error messages. The current workflows referenced credential records by
name/ID only and contained no provider secret values.

## Data minimization and logging

Store only the result fields and bounded telemetry required by the specs.
Telemetry and progress logs must not contain follower names, profile URLs,
page text, cookies, credentials, tokens, or authorization headers. Result
access and downloads must be authorized and auditable. Raw rows may contain
profile names and URLs and therefore are protected operator data, not public
content.

## Input and transition safety

Treat URLs, labels, run IDs, query parameters, and request bodies as untrusted.
Validate Facebook host boundaries, size limits, status transitions, run
ownership/authorization, and stored payload integrity before any privileged
action. Never let a client-supplied status, rows, or destination identifier
perform a commit or discard without server-side checks.

## Acceptance criteria

- No secret crosses the client or repository boundary.
- The collector, noVNC, profile, stored results, and provider credentials have
  distinct protection requirements.
- Unauthorized, malformed, unknown, and replayed requests fail closed.
- Logs and telemetry remain credential-free and PII-minimized.
