# @parlehq/mcp-server

Host-agnostic stdio MCP server for Parle.

## Contract

This package exposes Parle tools over MCP by depending on `@parlehq/agent-client`. It must not import Pi, Claude Code plugin, Claude Desktop bundle, or GalexC-specific code.

MCP v1 tools:

- `parle_status`
- `parle_setup`
- `parle_connect`
- `parle_guidance`
- `parle_read`
- `parle_inbox`
- `parle_affordances`
- `parle_send`

`parle_request` is intentionally deferred from MCP v1.

## Configuration

The stdio server uses the shared client resolver. It supports direct process env, project `.env`, and project `.parle/credentials` configuration, plus atomic `PARLE_PROFILE` bindings from `~/.parle/profiles` with fallback to `./.parle/profiles`. An explicit profile cannot be mixed with direct room-binding values. With no explicit binding, `[default]` is selected when present.

The bundled Claude watcher launcher is also hosted in this artifact. Every watcher start resolves configuration afresh, then passes the agent token only in the worker child environment. The request helper constructs authentication inside Node, so the token is never placed in argv, stdout, logs, or temporary files.

## Session lifecycle

The stdio entrypoint constructs a `ParleAgentClient` with runtime publishing enabled and, when `PARLE_ROOM_ID` and `PARLE_ROOM_AGENT_TOKEN` are configured, eagerly bootstraps the room agent session in the background at startup. Bootstrap is single-flight (eager startup, racing tool calls, and 401 rebootstrap share one in-flight mint) with exponential backoff on failure (5s doubling to a 60s cap, recorded as `bootstrapState`/`lastBootstrapError`/`nextRetryAt` on runtime state).

`parle_status` auto-connects by default when configured and not yet connected, reporting `bootstrapAttempted`; `inspect: true` restores the passive no-network read. Explicit calls (`parle_connect`, reads, sends) always retry regardless of the backoff window.

The client publishes a display-safe per-process snapshot to `<cwd>/.parle/runtime/<pid>.json` (0700 directory, 0600 file, atomic rename; never a credential) for host UX surfaces such as statuslines. Snapshots self-invalidate via expiry plus pid liveness; provably stale sibling files are pruned at startup; SIGINT/SIGTERM end the session best-effort and remove the file.

## Unread observation

Runtime-publishing clients also observe the self-excluding inbound surface past the process cursor on a bounded background poll (`PARLE_UNREAD_POLL_INTERVAL_SECONDS`, default 60, 0 disables) and publish `unreadCount`/`unreadAsOf` into the snapshot. Counting never advances the cursor (verified against the live API), a concurrent drain invalidates an in-flight observation, cursor-advancing reads synchronously republish the remaining count, observation failures never touch session state, and a steady zero writes nothing. Only counts and timestamps are published, never content.

`parle_read` and `parle_inbox` may expose short `waitSeconds` values for explicit one-shot waits. They must not be documented or implemented as background watcher loops. Responsive delivery watchers use `/v/agent/wake` SSE and then drain `responsive-delivery?wait=0`.

This package owns:

- stdio MCP server entrypoint and future `bin`
- MCP schemas and annotations
- adapter rendering of structured client state into MCP structured content plus text fallback
- output caps and redacted MCP-safe errors
- MCP smoke-test fixtures
