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

## Credential profiles

Keep room-bound credentials in a UTF-8 INI profile catalog. The resolver checks `~/.parle/profiles` first, then falls back to project-local `./.parle/profiles`:

```ini
[default]
room_id = 019f...
agent_token = parle_agt_...

[galexc-intercom]
room_id = 019f...
agent_token = parle_agt_...
agent_token_id = 019f...
api_base = https://api.parle.sh
```

Profile labels are local names only. `room_id` is the stable room target. The
agent token establishes the durable agent identity, so profiles do not store an
agent ID, handle, or live agent-session credential.

Set `PARLE_PROFILE=galexc-intercom` in process environment or a project `.env`.
Use `.env` as selector and non-secret configuration only; keep room-bound tokens
in a profile catalog. Profile mode is atomic: direct room, token, room-handle,
API-base, or wake-base configuration is a setup error rather than an override.
If no explicit profile or direct binding exists, `[default]` is selected only
when that section exists in either catalog; a catalog of named profiles alone
leaves profile selection unset. When the same profile name exists in both
catalogs, the personal catalog wins.

Profiles accept only `room_id`, `agent_token`, `agent_token_id`, `api_base`, and
`wake_base`. The endpoint defaults to production when omitted. The catalog is
validated before connecting and errors never expose credential values. Rotate a
token by replacing it in the profile, then restart processes that loaded it.
