# Changelog

## 0.4.0 (2026-08-02)

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
