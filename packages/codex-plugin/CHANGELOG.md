# Changelog

## Unreleased

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
