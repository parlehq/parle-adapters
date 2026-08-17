# Changelog

## 0.7.39 (2026-08-17)

- Expose honest conditional returning-account login start results and stop presenting accepted requests as proof that a code was sent.

## 0.7.38 (2026-08-16)

- Add opt-in direct-parent hook-bridge correlation for Claude, descriptor challenges, safe rebinding, and per-bridge endpoints while preserving legacy Codex discovery (#118).

## 0.7.37 (2026-08-15)

- Preserve redacted typed API error details in MCP tool results and bundle truthful bootstrap-error status projection (#126, #127).

## 0.7.36 (2026-08-15)

- Replace the standalone Claude network watcher with one owner-only local hook-bridge wait. The shared responsive controller remains the sole owner of wake SSE, durable drains, eligibility, and acknowledgement.

## 0.7.35 (2026-08-14)

- Resolve hook-bridge delivery as healthy when the same session also has the expected wake-only standalone watcher.

## 0.7.34 (2026-08-14)

- Expose degraded-safe `parle_delete_profile` through the shared local profile lifecycle and preserve adapter response-contract provenance separately from server error codes (#124, #125).

## 0.7.33 (2026-08-13)

- Expose shared `parle_create_own_agent` and `parle_delete_own_agent` account tools for MCP hosts while keeping the human session confined to fixed shared-client methods (#122).

## 0.7.32 (2026-08-13)

- Bundle exact-seat preflight for returning-login profile bootstrap and describe own-agent seat admission consistently for private and shared rooms (#121, parlehq/parle#800).

## 0.7.31 (2026-08-12)

- Inherit the shared client's in-place durable alias claim for anonymous live sessions (#115, parlehq/parle#797): a first claim now preserves the session, its participants, its wake stream, and outstanding exact-session opaque reply routes.

## 0.7.30 (2026-08-12)

- Bundle complete durable-alias validation from the shared client, including reserved words and anonymous session-shape exclusion.

## 0.7.29 (2026-08-12)

- Bundle the shared client durable session-alias normalization to 2 to 32 characters.

## 0.7.28 (2026-08-11)

- Expose the target-proof person mint contract with one handle-or-email target and privacy-flat email guidance (#113).

## 0.7.27 (2026-08-11)

- Bundle @parlehq/agent-client 0.8.26: 2026-08-10 wire default and terminal retirement of the bearer capability claim surface (ADR-0100).

## 0.7.26 (2026-08-11)

- Return the shared-client saved-start plan and remove harness-specific missing-start guidance from the bundled runtime.

## 0.7.25 (2026-08-11)

- Surface clearer saved-start not-found guidance from the shared client.

## 0.7.24 (2026-08-11)

- Add `parle_saved_start` local catalog management and `parle_session_alias` so MCP hosts can execute optional profile, alias, and opaque host-instruction steps without shared role parsing (#107).

## 0.7.23 (2026-08-10)

- Export the shared native tool runtime for host adapters and keep `parle_setup` guidance byte-stable across configured and degraded states. Detailed profile diagnostics remain in the `parle_setup` and `parle_status` results.

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
