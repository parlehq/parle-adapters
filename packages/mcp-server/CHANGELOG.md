# Changelog

## 0.3.1 (2026-08-02)

- Fence responsive reads at request start so exact-session work cannot cross rollover before entering the pending queue.
- Retry eager startup bootstrap automatically at the server deadline without waiting for a later tool call.

## 0.3.0 (2026-08-02)

- Consume the 2026-08-01 shared session lifecycle.
- Restart owned wake streams when the shared client publishes a session revision.
- Preserve alias-scoped unacknowledged responsive delivery during bridge startup and rollover.
- Restart the standalone Claude watcher worker with a fresh private environment when its dedicated session rolls, without returning to the host.
