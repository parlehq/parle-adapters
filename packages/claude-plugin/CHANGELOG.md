# Changelog

## 0.2.0 (2026-07-07)

MCP tool contract change (bundled `@parlehq/mcp-server` artifact refresh):

- New `parle_connect` tool: establishes or reuses the room agent session and returns a redaction-safe connection summary (session address, agent session id, participant id, expiry, cursor, held backlog). Idempotent while the session is live.
- Reads and sends that lazily establish a session now include a `session` block identifying the session they created.
- `parle_status` exposes `agentSessionId` (room-visible operational metadata; classification tracked in parlehq/parle#48). `sessionHandle` stays redacted. Optional config values are marked `optional`.
- `parle_setup` reports connection posture (`connected`) and points at `parle_connect`.
- Skill: new Connect flow section; arming the responsive watcher is now the default part of connecting.
- Tool contract lock file added (`@parlehq/mcp-server` `tool-contract.lock.json`); contract changes now require a lock diff, version decision, and changelog note.

Upstream API-first counterparts: parlehq/parle#47 (document session bootstrap in discovery surfaces), #48 (classify agent_session_id), #49 (session lifecycle and delivery baseline contract).

## 0.1.2 and earlier

Pre-changelog releases; see git history.
