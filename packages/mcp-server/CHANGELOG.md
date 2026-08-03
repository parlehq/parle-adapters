# Changelog

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
