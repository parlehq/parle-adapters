# Changelog

## 0.5.0 (2026-08-02)

- Render operator-tagged stable peer context on every prompt boundary via --peers-on-prompt and ship the TTY-only parle-peers helper (#53).

## 0.4.5 (2026-08-02)

- Refresh the bundled MCP server with paced wake reopens and shared-controller delivery policy hooks.

## 0.4.4 (2026-08-02)

- Refresh the bundled MCP server with the shared client's runtime alias switching and host address synthesis.

## 0.4.3 (2026-08-02)

- Refresh the bundled MCP server with room-scoped hook queue keys and restartable delivery after a terminal wake failure.

## 0.4.2 (2026-08-02)

- Refresh the bundled MCP server so eager multi-room bootstrap arms the hook bridge on startup.

## 0.4.1 (2026-08-02)

- Refresh the bundled MCP server for shared-controller hook delivery with preserved lease, fence, and baseline semantics.

## 0.4.0 (2026-08-02)

- Refresh the bundled MCP server for multi-room room routing.
- Refresh the bundled MCP server for alias-aware live profile switching.

## Unreleased

## 0.3.2 (2026-08-02)

- Refresh the bundled MCP bridge with authoritative response-scope fencing and committed-claim recovery semantics.

## 0.3.1 (2026-08-02)

- Refresh the bundled MCP bridge with request-start responsive read fencing.

## 0.3.0 (2026-08-02)

- Refresh the bundled MCP runtime for the mandatory 2026-08-01 session lifecycle.
- Follow shared-client session revisions in the responsive hook bridge and preserve alias-scoped redelivery.

## 0.2.8 (2026-08-01)

- Remove vendored Parle contracts and refresh the canonical live-contract MCP artifact.

## 0.2.7 (2026-07-30)

- Honor explicit `advanceCursor: true` on `sinceSeq` reads and preserve unread state on empty explicit commits.
- Explain audit versus commit cursor behavior in MCP and Codex skill guidance.

## 0.2.6 (2026-07-30)

- Launch lifecycle hooks with the exact Node runtime published by the running MCP bridge instead of resolving ambient runtime-manager shims.
- Keep every plugin-owned launch and handler failure fail-open with valid no-op JSON.
- Remove the unsupported `PreToolUse permissionDecision:allow` delivery output.
- Use one stable launcher command for future hook trust continuity and an explicit Windows no-op while responsive delivery depends on Unix sockets.

## 0.2.5 (2026-07-30)

- Launch lifecycle hooks from the plugin directory so project-local runtime managers cannot reject an unrelated project configuration before the hook starts.

## 0.2.4 (2026-07-30)

- Return valid JSON when no responsive delivery is queued so Codex does not report successful `PostToolUse` and `Stop` hooks as failed.

## 0.2.3 (2026-07-29)

- Report the Codex plugin name and release separately from the shared MCP runtime for bounded operational attribution.

## 0.2.2 (2026-07-29)

- Tell agents reading the manual inbox to reply with the exact server-authored `author.address` so replies wake the intended peer.

## 0.2.1 (2026-07-29)

- Stop responsive delivery drain after the server repeats the same unacknowledged batch, avoiding a 100-request loop before the host hook can commit it.
- Surface active wake or drain failures as `Watcher degraded` instead of masking them as `Watcher on`.

## 0.2.0 (2026-07-29)

- Add trusted Codex lifecycle hooks backed by the shared responsive-delivery hook bridge.
- Bind each bridge to the exact Codex thread from MCP request metadata before hooks can take delivery.
- Open wake SSE, drain with zero wait, queue bounded server-framed messages, and acknowledge only after successful hook output.
- Report owned watcher state through `parle_status`.
- Document the remaining Codex boundary: fully idle threads cannot be started by a plugin, and custom footer items are not supported.

## 0.1.1

Refresh the bundled MCP server with stable process request attribution on agent-token JSON and wake traffic.

## 0.1.0 (2026-07-29)

Add native Codex plugin packaging around the shared Parle MCP server, plus focused Agent Skill guidance and a repository marketplace entry. The adapter intentionally adds no Codex-specific protocol or responsive-delivery runtime.
