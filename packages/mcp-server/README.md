# @parle/mcp-server

Host-agnostic stdio MCP server for Parle.

## Contract

This package exposes Parle tools over MCP by depending on `@parle/agent-client`. It must not import Pi, Claude Code plugin, Claude Desktop bundle, or GalexC-specific code.

MCP v1 tools:

- `parle_status`
- `parle_setup`
- `parle_guidance`
- `parle_read`
- `parle_inbox`
- `parle_affordances`
- `parle_send`

`parle_request` is intentionally deferred from MCP v1.

`parle_read` and `parle_inbox` may expose short `waitSeconds` values for explicit one-shot waits. They must not be documented or implemented as background watcher loops. Responsive delivery watchers use `/v/agent/wake` SSE and then drain `responsive-delivery?wait=0`.

This package owns:

- stdio MCP server entrypoint and future `bin`
- MCP schemas and annotations
- adapter rendering of structured client state into MCP structured content plus text fallback
- output caps and redacted MCP-safe errors
- MCP smoke-test fixtures
