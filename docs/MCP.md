# MCP — built-in instance-level MCP server

AutoPilot exposes n8n's **built-in instance-level MCP server** on the same
hostname as the Web UI so external AI coding agents (Codex, Claude Code,
OpenCode, any Streamable-HTTP MCP client) can interact with workflows
remotely. Verified against official n8n docs (September 2026, n8n ≥ 2.33
flows; pinned `2.37.10` supports everything below).

## Endpoint

```text
https://auto-pilot.jpfernandez.online/mcp-server/http   (Streamable HTTP)
```

No separate MCP hostname. The reverse proxy must forward (not strip) the
`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` headers; Cloudflare
Tunnel + Coolify proxy pass headers through by default — only add stripping
WAF rules with care.

(There is also a separate per-workflow `MCP Server Trigger` node exposing
`https://<host>/mcp/<path>` for single-workflow tool servers. It is optional
and NOT the primary integration — this document covers the instance server.)

## Enabling it

1. Compose already sets `N8N_MCP_MANAGED_BY_ENV=true` +
   `N8N_MCP_ACCESS_ENABLED=true`, so the server defaults ON and survives
   redeploys (env-managed since n8n 2.20).
2. Verify in the UI: Settings → Instance-level MCP → Enable MCP access.
3. To disable entirely (unsupported here, documented for completeness):
   redeploy with `N8N_MCP_ACCESS_ENABLED=false`, or
   `N8N_DISABLED_MODULES=mcp` to remove endpoints + UI.

## Authentication

Two supported mechanisms (official). No Cloudflare Access in front of the
hostname — clients authenticate directly against n8n:

- **OAuth (recommended):** client opens `Connect → OAuth`, approves access in
  n8n. Per-client grants, reviewable/revocable under
  Settings → Instance-level MCP → Connected clients.
- **API key:** personal access token from the `Connect a client → API key`
  tab, sent as `Authorization: Bearer <TOKEN>`. Rotatable (rotation revokes
  the old token). Key-based clients do not appear in Connected clients.

There are NO official `N8N_MCP_ACCESS_TOKEN` / `N8N_MCP_BASE_URL` env vars
(community-invented — do not use). Tokens are created in the UI, stored in
the agent's local MCP config, and never committed here.

## How workflow access works

Enabling the server exposes **zero** workflows by itself. Each workflow must
additionally be exposed (workflow `⋯ → Settings → Available in MCP`, the
workflows-list toggle, bulk project/folder `Manage MCP access`, or
`Auto-expose new workflows` — off by default, keep it off).

- Eligible: only **published** workflows with a webhook, form, schedule, or
  chat trigger.
- `search_workflows` previews workflows the connected user can view; full
  read/execute/modify requires explicit exposure.
- **All connected clients see all exposed workflows** — there is no per-client
  scoping beyond the n8n user's own permissions. Use a dedicated
  least-privilege n8n user for agents (see Security).

## Security implications

- A Bearer API token carries the **full permissions of its n8n user**. Scope
  risk by creating a dedicated agent user with access to only the projects it
  needs, and expose only the workflows it needs.
- Same-hostname sharing means UI, API, webhooks, and MCP share TLS/domain
  fate; a leaked token = remote workflow read/execute/modify within that
  user's rights. Mitigations: OAuth where possible, token rotation on
  suspicion, `Allowed callback URLs: Only trusted URLs`, revoke idle clients.
- Agents (and humans) must never paste credential secrets into workflow
  definitions — use the n8n Credentials system. Note the export scanner
  (`scripts/export-workflows.sh`) flags `Authorization`-looking strings.

## Example client configurations (placeholders only)

```bash
# Claude Code — OAuth
claude mcp add --transport http n8n https://auto-pilot.jpfernandez.online/mcp-server/http

# Claude Code — API key (~/.claude.json)
# {"mcpServers":{"n8n":{"type":"http","url":"https://auto-pilot.jpfernandez.online/mcp-server/http","headers":{"Authorization":"Bearer <N8N_API_KEY>"}}}}
claude mcp add --transport http n8n-mcp https://auto-pilot.jpfernandez.online/mcp-server/http --header "Authorization: Bearer <N8N_API_KEY>"
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.n8n]
url = "https://auto-pilot.jpfernandez.online/mcp-server/http"
http_headers = { Authorization = "Bearer <N8N_API_KEY>" }
# CLI: codex mcp add n8n --url "https://auto-pilot.jpfernandez.online/mcp-server/http"
```

```json
// Generic Streamable-HTTP client (Cursor ~/.cursor/mcp.json style)
{ "mcpServers": { "n8n": {
  "url": "https://auto-pilot.jpfernandez.online/mcp-server/http",
  "headers": { "Authorization": "Bearer <N8N_API_KEY>" } } } }
```

Replace `<N8N_API_KEY>` locally per machine. Never commit filled-in configs.
