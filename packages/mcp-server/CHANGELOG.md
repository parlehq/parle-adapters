# Changelog

## 0.7.22 (2026-08-10)

- Keep `parle_connect`, active `parle_status`, and eager bootstrap responsive while optional hook bridge startup continues in the background, and separate the opaque hook queue scope from the runtime evidence directory.

## 0.7.21 (2026-08-10)

- Refresh the bundled runtime for the `2026-08-09` unified exact-seat admission hard cut.

## 0.7.20 (2026-08-09)

- Refresh shared responsive-delivery resolution and bounded runtime evidence cleanup so status never borrows another session's watcher evidence (#103, #104).

## 0.7.19 (2026-08-08)

- Refresh the shared transport with automatic known-address enrollment, add the supported-host context renderer, remove `parle_status.peerContext`, and delete the legacy peer helper and injection path (#96, #93).

## 0.7.18 (2026-08-08)

- Adopt the shared safe-file primitive for hook bridge runtime descriptor publication and refresh the shared client foundation (#95).

## 0.7.17 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.7.16 (2026-08-08)

- Keep MCP alive in a diagnostics-only degraded state after profile resolution fails, then re-resolve on `parle_setup`, promote the full tool surface, and emit `notifications/tools/list_changed` without a host restart (#92).

## 0.7.15 (2026-08-08)

- Refresh the shared client for the `2026-08-08` invitation locator hard cut.

## 0.7.14 (2026-08-08)

- Carry the shared client HTTP 408 terminal alias release ambiguity correction into the MCP runtime.

## 0.7.13 (2026-08-07)

- Add equivalent agent and human durable alias delivery tools, including guarded two-step terminal release with explicit unknown outcomes for ambiguous completion, and refresh known-alias send guidance (#86).

## 0.7.12 (2026-08-07)

- Extend Claude watcher launch arguments and profile-switch restart guidance with room-local participant identity (#87).

## 0.7.11 (2026-08-07)

- Refresh shared inbox guidance so positive held backlog always marks results non-exhaustive (#81).

## 0.7.10 (2026-08-07)

- Refresh shared held-backlog diagnostics and expose bounded manual-inbox completeness guidance (#81).

## 0.7.9 (2026-08-07)

- Add the shared `complete-factor` login action so hardened accounts can finish credential bootstrap with TOTP (#84, parle#705).

## 0.7.8 (2026-08-06)

- Refresh the embedded shared controller for post-open responsive reconciliation, ADR-0059 fallback fetch, and bounded reconnect recovery (#80).

## 0.7.7 (2026-08-06)

- Add `parle_reply`, preserve opaque reply metadata through hook delivery, and render route-first instructions plus the server-reported two-replies-remaining warning (#74).

## 0.7.6 (2026-08-05)

- Correct stable-peer hook guidance for current operator-supplied session routes while preserving compaction and provenance safeguards (#78).

## 0.7.5 (2026-08-05)

- Refresh the shared client for the terminal `2026-08-05` wire contract.

## 0.7.4 (2026-08-05)

- Refresh the shared room inventory with credential-origin, pagination, mutation-outcome, and ready-room truth safeguards.

## 0.7.3 (2026-08-04)

- Add the read-only `parle_rooms` tool backed by the shared room inventory and label `parle_status.runtime.rooms` as active runtime state rather than exhaustive inventory (#685).

## 0.7.2 (2026-08-04)

- Expose canonical send-attention guidance and refresh shared-client receipt handling (#50).

## 0.7.1 (2026-08-03)

- Refresh the shared account client so login can create an explicitly targeted missing profile without weakening other account operations.

## 0.7.0 (2026-08-03)

- Expose shared `parle_login`, `parle_create_room`, and `parle_add_own_agent_seat` account-plane tools to MCP hosts, with explicit mutation confirmation for credential-persisting login actions (#71).

## 0.6.4 (2026-08-03)

- Expose the shared client wake-open lifecycle callback in the bundled runtime. Existing MCP host behavior is unchanged.

## 0.6.3 (2026-08-03)

- Refresh the bundled shared client with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.6.2 (2026-08-03)

- Return routine missing-configuration diagnostics from `parle_setup` as successful tool results while preserving unexpected failures as MCP errors.

## 0.6.1 (2026-08-02)

- Peer-context fix-forward per adversarial review: canonical PARLE_PROFILES_PATH resolution (process env, project .env, relative-to-cwd) in the status surface, hook, and helper; a per-tool rendering boundary for hosts without a compact session start; controlling-terminal confirmation and honestly narrowed provenance claims in the mutation helper; bounded reads and full-route address grammar in the hook.

## 0.6.0 (2026-08-02)

- Render the operator-tagged stable peer block from the bundled hook at SessionStart (and per-prompt behind --peers-on-prompt for hosts without a session boundary), ship the TTY-only parle-peers mutation helper, and expose a read-only peerContext section on parle_status (#53).

## 0.5.4 (2026-08-02)

- Refresh the bundled shared client with paced wake reopens, the delivery handler preamble, and host wake-error policy hooks.

## 0.5.3 (2026-08-02)

- Refresh the bundled shared client with runtime alias switching and host address synthesis.

## 0.5.2 (2026-08-02)

- Key hook bridge pending work by room so identical seq/event ids in two rooms can never collapse, and treat only the first successful delivery start as the baseline window so recovery drains queue live rows.
- Refresh the bundled shared client with restartable controller delivery after a terminal wake failure.

## 0.5.1 (2026-08-02)

- Refresh the bundled shared client so eager multi-room bootstrap arms the hook bridge on startup instead of failing a self-inflicted profile selector conflict.

## 0.5.0 (2026-08-02)

- Move the hook delivery bridge onto the shared responsive delivery controller: the controller owns wake, room routing, per-room drain, deduplication, and acknowledgement, while the bridge keeps the socket protocol, lease, commit fences, and session-commit guard.
- Report session-scoped baseline skips from the delivery handler and acknowledge queued rows only through hook commit via deferred completion.
- Publish the bridge socket before delivery starts and keep the socket and runtime artifacts through bootstrap or wake-stream failures so hooks diagnose through status instead of losing the bridge.

## 0.4.0 (2026-08-02)

- Resolve the hook bridge room explicitly instead of reading a primary binding off the session.
- Add optional roomId to parle_read, parle_inbox, parle_send, and parle_affordances, and regenerate the tool contract lock.
- Route responsive wake hints by room_id and ignore hints naming unconfigured rooms, with a diagnostic counter.
- Adopt the shared client alias-aware profile switch and pre-claim guard ordering.

## 0.3.2 (2026-08-02)

- Carry authoritative response cursor scope through retained delivery fences.
- Surface committed-but-unavailable alias claims without misclassifying their outcome as unknown.

## 0.3.1 (2026-08-02)

- Fence responsive reads at request start so exact-session work cannot cross rollover before entering the pending queue.
- Retry eager startup bootstrap automatically at the server deadline without waiting for a later tool call.

## 0.3.0 (2026-08-02)

- Consume the 2026-08-01 shared session lifecycle.
- Restart owned wake streams when the shared client publishes a session revision.
- Preserve alias-scoped unacknowledged responsive delivery during bridge startup and rollover.
- Restart the standalone Claude watcher worker with a fresh private environment when its dedicated session rolls, without returning to the host.
