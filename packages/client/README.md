# @parlehq/agent-client

Headless Parle protocol client primitives shared by harness adapters.

## Contract

This package owns protocol behavior that is not specific to Pi, Claude Code, Claude Desktop, MCP transport, or GalexC.

It owns:

- configuration parsing and source provenance
- redaction and truncation
- safe Parle host validation
- request helpers with injectable fetch and low-cardinality client identity headers
- setup diagnostics and guidance fetches
- session bootstrap, terminal-error-aware rebootstrap episodes, heartbeat, and best-effort session end primitives
- projection read, inbound read, affordances fetch, send, direct addressing, shared cursor helpers, and idempotency helpers
- wake SSE stream handling, responsive-delivery drain with `wait=0`, ack helpers, and delivery dedupe state
- structured delivery and moderation state
- typed errors with canonical `code`, `action`, `scope`, `retryable`, and `retryAfterMs` fields for adapters to render safely

It must not import Pi, Claude, MCP SDK, Claude Desktop bundle code, or GalexC-specific code.

Adapters own host-specific registration, schemas, lifecycle hooks, UI text, and guidance strings.
