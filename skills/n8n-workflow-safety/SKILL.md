---
name: n8n-workflow-safety
description: >-
  Load before creating, modifying, activating, deactivating, executing,
  testing, or reviewing n8n workflows; using n8n MCP; handling webhooks,
  credentials or auth, workflow JSON/imports/exports, Code nodes, secrets or
  sensitive data, or external side effects.
---

# n8n workflow safety

This is a portable safety skill for n8n work. It contains principles, not a
deployment topology. Current infrastructure and authentication facts belong in
the repository's architecture, deployment, MCP, and backup documentation.

## 1. Verify the current environment

- Inspect the current repository docs before relying on any deployment fact.
  Determine whether the endpoint is public, which auth layer protects it, and
  whether that protection is at the infrastructure, n8n, workflow, or provider
  layer.
- Check separately how the UI, webhook endpoints, and MCP endpoint are
  protected. A UI login, VPN, tunnel, firewall, reverse proxy, access gateway,
  or identity provider does not prove that another route has the same
  protection.
- Check whether a route intentionally bypasses an external auth layer and
  whether the architecture changed since the workflow was created. Do not
  infer current security from old workflow notes or a familiar topology.
- If the current security model cannot be determined confidently, fail safe and
  ask before proceeding.

## 2. Secrets and credentials

- Never commit passwords, API keys, tokens, headers, private keys, signing
  secrets, OAuth tokens, or other credentials in workflow JSON or the repo.
  Use n8n Credentials. If the required credential does not exist, tell the user
  what credential record to create; do not embed its value.
- Never put secrets in Code nodes, Set/Edit Fields nodes, HTTP Request fields
  when an n8n Credential can be used, workflow names or descriptions, logs,
  debug output, webhook responses, test output, or committed JSON.
- Do not expose sensitive execution data in logs, responses, or debug output.
  Do not print or retrieve credential values merely to inspect them.
- Referencing a credential record ID is acceptable. Extracting or embedding its
  secret value is not.

## 3. Webhook security

- Treat webhooks as potentially public. Do not assume a reverse proxy, provider,
  tunnel, firewall, or access gateway authenticates them unless the current repo
  docs explicitly confirm it for that route.
- For a sensitive webhook, configure n8n authentication or verify the external
  service's documented signature, HMAC, or standard verification mechanism.
  Do not invent a custom cryptographic scheme.
- A public, non-sensitive webhook may intentionally be unauthenticated, but
  still assess abuse, replay, spam, cost, side effects, attacker-controlled
  input, and data exposure.
- Never trust incoming webhook data merely because it reached n8n. Validate it
  before privileged, destructive, or externally visible operations.

## 4. MCP safety

- Treat MCP authentication and network exposure as deployment concerns. Inspect
  the current docs first; do not hardcode a URL, path, proxy, OAuth, or access
  topology into this skill or a workflow.
- Use the MCP authentication configured by the current deployment. Never
  disable or weaken it unless the task explicitly concerns infrastructure or
  security configuration and the user asked for that change.
- Never expose or commit MCP tokens, OAuth tokens, or credentials. Do not
  assume an upstream proxy authenticates MCP requests or that MCP is reachable
  without verifying the current architecture.
- Prefer n8n MCP tooling for workflow operations when it is available and safe.

## 5. Workflow creation and modification

- Prefer connected MCP tools over hand-written raw JSON when they can safely
  perform the requested operation.
- Inspect an existing workflow before modifying it. Do not duplicate a
  workflow when the task is to modify one, and preserve unrelated behavior.
- Validate before and after meaningful changes when tooling supports it. Test
  before activation where practical.
- Use this general sequence as a guide: inspect, understand, modify, validate,
  test, then activate only if requested. Do not perform a step mechanically if
  it would be unsafe.

## 6. Activation and side-effect safety

- Do not activate or execute destructive, irreversible, expensive,
  externally-visible, or spammy workflows unless that action is clearly part
  of the user's request. This includes emails or SMS, deleting data, changing
  production records, publishing, payments, deployments, bulk API operations,
  permission changes, contacting real users, creating tickets or posts, and
  triggering downstream automations.
- For testing, use safe test data, controlled recipients, disabled or mocked
  side-effecting paths, and sandbox environments where practical.
- Do not repeatedly execute a side-effecting workflow merely to confirm it
  works. Creating or modifying a workflow does not imply permission to
  activate it.
- Modifying an active workflow can affect live executions immediately; account
  for that before changing it.

## 7. Untrusted input and Code nodes

- Treat webhook, form, API, email, chat, file, user, and third-party integration
  data as untrusted unless the docs establish otherwise.
- Consider validation, injection into downstream systems, unsafe shell or code
  execution, path and URL manipulation, unexpected types, oversized payloads,
  and sensitive-data propagation.
- Code nodes must not bypass n8n's credential system or other security
  mechanisms. Prefer native nodes when they are safer and easier to maintain.

## 8. Workflow export and Git safety

- Exported JSON must remain secret-free. Do not assume content is safe to commit
  merely because it is inside a workflow export.
- Workflows should reference n8n credential records, never embed credential
  values. Never bypass or weaken repository secret-scanning or export-safety
  mechanisms.
- Do not modify export or sync architecture unless the task explicitly concerns
  it. When reviewing workflow JSON, look for tokens, API keys, authorization
  headers, passwords, private keys, signing secrets, sensitive test payloads,
  and customer data in new fields.

## 9. Infrastructure boundary

- Do not casually modify database architecture, persistent storage, encryption
  key handling, container configuration, resource limits, reverse proxies,
  tunnels, access gateways, DNS, MCP infrastructure, backup architecture,
  export infrastructure, auth gateways, or deployment configuration.
- Change those systems only when the task explicitly concerns them. If workflow
  behavior depends on infrastructure, inspect the current repository docs
  instead of assuming a product, route, or auth layer.

## 10. Anti-patterns (BAD/GOOD)

- BAD: Hardcode an API key in an HTTP Request node. GOOD: Use an n8n
  Credential.
- BAD: Assume a webhook is protected because the n8n GUI requires auth. GOOD:
  Determine how that webhook endpoint itself is authenticated.
- BAD: Create a webhook that deletes records based solely on caller-supplied
  parameters. GOOD: Authenticate or verify the caller and validate input before
  privileged operations.
- BAD: Return an incoming Authorization header in a webhook response for
  debugging. GOOD: Return or log only non-sensitive diagnostic information.
- BAD: Activate an email workflow during testing and accidentally send messages
  to real recipients. GOOD: Use controlled recipients or test without enabling
  the side-effecting path.
- BAD: Manually rewrite workflow JSON when connected MCP tooling can safely
  inspect or modify the workflow. GOOD: Use MCP to inspect, modify, validate,
  and test.
- BAD: Assume the deployment still uses the same reverse proxy or security
  topology documented months ago. GOOD: Inspect the current architecture and
  deployment docs before relying on infrastructure-level security.
