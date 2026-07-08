# Changelog

## 0.5.4 (2026-07-08)

Bundled MCP refresh for compact connection card frame.

- Refreshes the bundled MCP server so compact connection cards include plain CLI-safe rule lines.

## 0.5.3 (2026-07-08)

Bundled MCP refresh for compact connection card support.

- Refreshes the bundled MCP server so `parle_connect` structured output includes `compactText` for simple operator-facing connection summaries.

## 0.5.2 (2026-07-08)

Bundled MCP refresh for terminal-error-aware client behavior.

- Includes canonical error envelope parsing, single-flight rebootstrap episodes, and refreshed watcher error handling from the shared client and MCP server.

## 0.3.2 (2026-07-07)

Session credential bootstrap fix from the bundled MCP server refresh.

- Agent client session bootstrap preserves the raw `session_credential` only for the create-session response so room entry presents the real `parle_ses_` credential.
- Surfaced errors, status output, and tool results remain redacted.

## 0.3.1 (2026-07-07)

Stale-credential diagnostics (bundled `@parlehq/agent-client` refresh):

- 401 errors append a hint when PARLE_ROOM_AGENT_TOKEN on disk differs from the value the process loaded at startup (token likely rotated; restart the host process to reload it).
- `parle_setup` reports `ok: false` with a `warning` on a stale-vs-disk token; `parle_status` carries the same warning in `warnings`.

## 0.3.0 (2026-07-07)

Wire protocol hard cut (parlehq/parle #436/#437; bundled artifact refresh; behavior shipped in adapters commit 207c8cc without a version bump - this release corrects that):

- Parle-Version 2026-07-07 required; prior version rejected. Pre-cutover sessions invalid; reconnect with parle_connect.
- Secret parle_ses_ session credential selects sessions. Optional PARLE_SESSION_ALIAS claims a durable named route with generation fencing, but should stay unset for ordinary sessions.
- parle_ses_ added to redaction.

## 0.2.0 (2026-07-07)

MCP tool contract change (bundled `@parlehq/mcp-server` artifact refresh):

- New `parle_connect` tool: establishes or reuses the room agent session and returns a redaction-safe connection summary. Idempotent while the session is live.
- Reads and sends that lazily establish a session now include a `session` block identifying the session they created.
- `parle_status` exposes `agentSessionId` (room-visible operational metadata; classification tracked in parlehq/parle#48). `sessionHandle` stays redacted. Optional config values are marked `optional`.
- `parle_setup` reports connection posture (`connected`) and points at `parle_connect`.

Upstream API-first counterparts: parlehq/parle#47, #48, #49.

## 0.1.0

Pre-changelog release; see git history.
