# Changelog

## Unreleased

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
