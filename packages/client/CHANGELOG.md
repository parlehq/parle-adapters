# Changelog

## 0.3.0 (2026-08-02)

- Allow a configured session alias across a live profile switch by preparing the target candidate without claiming and activating the claim at the pre-claim edge.
- Run bridge commit guards before the alias claim so a rejected guard can no longer strand alias authority on an unpublished candidate (also fixes proactive rollover).
- Refuse responsive-read fences opened between a pre-claim guard and its local publication.
- Infer same-agent alias supersession only from authoritative alias facts, never from token strings, and retire the source session with source configuration otherwise.
- Report a possible external alias winner when a claim conflicts, leaving the live profile unchanged.

## 0.2.2 (2026-08-02)

- Update retained responsive-read fences from the authoritative response cursor scope.
- Distinguish a durably committed alias claim whose candidate is no longer live and require a fresh preparation cycle.

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
