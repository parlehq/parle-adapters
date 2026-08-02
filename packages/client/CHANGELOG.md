# Changelog

## 0.2.1 (2026-08-02)

- Require the core durable alias lookup to be deployed before this adapter release.
- Recover durable alias generations through the core alias lookup even after the prior owner expires.
- Confirm ambiguous claims against the durable alias fence before reading live candidate facts.
- Fence each responsive read at request start so exact-session work cannot cross a concurrent rollover.

## 0.2.0 (2026-08-02)

- Require `Parle-Version: 2026-08-01` with no negotiation or fallback.
- Create sessions anonymously, prepare rooms and wake readiness, then generation-fence alias claims from bounded self-session inventory.
- Add deterministic proactive rollover scheduling, single-flight preparation, bounded failure latching, session revision events, and honest anonymous handoff state.
- Expose server-selected responsive cursor scope without coupling it to projection cursor state.
