# Changelog

## 0.6.20 (2026-08-09)

- Refresh the bundled runtime with session-scoped responsive-delivery resolution and bounded expired runtime record cleanup (#103, #104).

## 0.6.19 (2026-08-08)

- Restore bounded known-address context at the verified Codex `SessionStart` boundary, refresh automatic direct-send enrollment, and remove the legacy peer helper, renderer, status field, and generated copies (#96, #93).

## 0.6.18 (2026-08-08)

- Refresh the bundled MCP runtime with the canonical safe-file foundation (#95).

## 0.6.17 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.6.16 (2026-08-08)

- Refresh the bundled MCP runtime with diagnostics-only degraded boot and in-process recovery after profile repair (#92).

## 0.6.15 (2026-08-08)

- Refresh the bundled MCP runtime for the `2026-08-08` invitation locator hard cut.

## 0.6.14 (2026-08-08)

- Refresh the bundled MCP runtime with HTTP 408 terminal alias release ambiguity handling.

## 0.6.13 (2026-08-07)

- Refresh the bundled MCP runtime with durable alias delivery controls and guarded terminal release that reports ambiguous completion as unknown (#86).

## 0.6.12 (2026-08-07)

- Refresh the shared MCP runtime with credential-free participant snapshot metadata and watcher launch support (#87).

## 0.6.11 (2026-08-07)

- Refresh the embedded MCP runtime with non-exhaustive guidance for every positive held backlog (#81).

## 0.6.10 (2026-08-07)

- Refresh the embedded MCP runtime for current held-backlog status and bounded manual-inbox guidance (#81).

## 0.6.9 (2026-08-07)

- Refresh account bootstrap so hardened email login can continue through TOTP without exposing pending credentials (#84, parle#705).

## 0.6.8 (2026-08-06)

- Refresh responsive delivery for post-open reconciliation, ADR-0059 fallback fetch, and bounded reconnect recovery (#80).

## 0.6.7 (2026-08-06)

- Refresh the bundled MCP runtime and responsive hook for opaque route replies and bounded-interaction warnings (#74).

## 0.6.6 (2026-08-05)

- Refresh the stable-peer hook guidance for current operator-supplied session routes (#78).

## 0.6.5 (2026-08-05)

- Refresh the bundled MCP runtime for the terminal `2026-08-05` wire contract.

## 0.6.4 (2026-08-05)

- Refresh the bundled MCP runtime with hardened, truthful room inventory and login outcome handling.

## 0.6.3 (2026-08-04)

- Refresh the bundled MCP runtime with `parle_rooms` and teach the Codex skill to keep room inventory sources distinct and principal-private (#685).

## 0.6.2 (2026-08-04)

- Refresh the bundled MCP runtime with canonical routing and attention passthrough plus direct-only responsive guidance (#50).

## 0.6.1 (2026-08-03)

- Refresh the bundled shared client so account login can create an explicitly targeted missing profile without weakening other account operations.

## 0.6.0 (2026-08-03)

- Refresh the bundled MCP server with shared account bootstrap, room creation, and own-agent seat tools (#71).

## 0.5.6 (2026-08-03)

- Refresh the bundled MCP server with the shared wake-open lifecycle callback. Existing Codex behavior is unchanged.

## 0.5.5 (2026-08-03)

- Refresh the bundled MCP server with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.5.4 (2026-08-03)

- Refresh the bundled MCP server so routine `parle_setup` diagnostics no longer render as tool failures.

## 0.5.3 (2026-08-02)

- Enforce the Windows launcher's absolute-only PARLE_HOOK_RUNTIME override (relative and drive-relative values fall through to the fixed install paths) and prove the wiring behaviorally on a Windows CI job: the exact commandWindows string runs through cmd /d /s /c with a spaced plugin root, hostile cwd/PATH, and no bridge state.

## 0.5.2 (2026-08-02)

- Replace the Windows hook no-op with a real launcher (run-parle-hook.cmd): absolute PARLE_HOOK_RUNTIME override, fixed absolute Node install paths, fail-open {}. SessionStart peer context (including the compact source) now renders on Windows without a live bridge.

## 0.5.1 (2026-08-02)

- Move peer-context rendering to the SessionStart boundary (Codex 0.146 exposes a compact source) and drop per-prompt repetition; the launcher gains an absolute PARLE_HOOK_RUNTIME override and fixed absolute Node fallbacks so peer context renders without a live delivery bridge. Windows hooks remain a documented no-op.

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
