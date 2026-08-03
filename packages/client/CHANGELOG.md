# Changelog

## 0.6.3 (2026-08-03)

- Preserve absent server retryability as unknown, fall back to retryable HTTP 429 and 5xx only at status-aware transport boundaries, and always return send idempotency keys on failure.
- Make the exported `ParsedErrorEnvelope.retryable` field optional so callers can distinguish server-authored `false` from an absent value.

## 0.6.2 (2026-08-03)

- Report configuration completeness explicitly from setup diagnostics while preserving warnings that still need attention.

## 0.6.1 (2026-08-02)

- Harden the peer-context store per adversarial review: full-route address grammar, bounded reads, exclusive temporary creation with parent-directory ownership checks, and symlink-target replacement.

## 0.6.0 (2026-08-02)

- Add the operator-owned stable peer-context store (#53): explicit-tag-only retention beside the profile catalog with cookie-file safety discipline, a bounded deterministic retention block, and no address-shape inference or peer-content parsing.

## 0.5.0 (2026-08-02)

- Give the responsive delivery controller a per-batch preamble passthrough and an onWakeError host-policy hook so hosts keep rate-limit parking and failure latching while the controller owns the loop.
- Pace event-less wake stream reopens so an instantly closing server response cannot spin the loop on microtasks and starve timers.
- Record the acknowledged responsive watermark on the room runtime after every successful ack.

## 0.4.0 (2026-08-02)

- Add switchSessionAlias: a runtime durable-alias switch on the shared candidate machinery, with the pre-claim guard, publication barrier, supersession semantics, and prior-route warning; proactive rollover re-claims the switched alias.
- Add an alias_switch session commit reason and a synthesizeSessionAddress option so hosts that know their principal and agent handles can derive an address when the server omits one.

## 0.3.2 (2026-08-02)

- Clear the responsive delivery controller loop when it settles so a terminal wake failure reports running=false and a later start() resumes delivery instead of no-opping forever.

## 0.3.1 (2026-08-02)

- Keep multi-room re-resolution on the PARLE_PROFILES selector alone. Reinjecting the bearer room profile as PARLE_PROFILE made every automatic bootstrap (eager startup, status auto-connect) fail a self-inflicted selector conflict while explicit connect still worked, so hook-bridge hosts never armed on startup.

## 0.3.0 (2026-08-02)

- Pass the server-selected cursor scope to delivery handlers so hosts can apply startup policy to session-scoped backlog.
- Stop counting a pending deferred row as drain progress, which would run a room to its batch cap on every wake.
- Never latch the session's automatic work on a request-scoped error, so a caller mistake such as an omitted roomId cannot stop the wake stream.
- Extract durable alias authority into a shared, transport-agnostic module so its claim, conflict, and lost-response rules cannot drift between adapters.
- Warn when PARLE_SESSION_ALIAS comes from persistent configuration rather than the process environment (#44).
- Add a deferred delivery outcome so hosts whose effective handling is asynchronous to the drain acknowledge only after they have acted.
- Split delivery handling from acknowledgement: a failed ack retries only the ack, never the host handler, so a handled row cannot be injected twice.
- Acknowledge a row once its bounded handler budget is exhausted, classified as an intentional skip, so one permanently failing message cannot wedge a room.
- Queue one drain rerun per room instead of joining an in-flight drain, so a session replacement never loses its immediate post-replacement pass.
- Recover a room whose entry succeeded but whose projection initialization failed, instead of stranding a real participant binding.
- Reject a separator-only PARLE_PROFILES before any network activity; an empty value stays equivalent to unset.
- Add the shared responsive delivery controller: one session wake stream, per-room drain, dedupe by room and event, ack only after handling, bounded poison guard, and diagnostics (issue #63 S4).
- Serialize data-plane calls against binding changes, resolving rooms inside that gate (#28).
- Warn when a rebootstrapped session does not reclaim its configured durable alias (#49).
- Hard cut: the session runtime owns no room state. Cursors, participants, handles, unread counts, and health live only in rooms[], with no primary-room projection.
- Report rooms[] from connect summaries, profile-switch results, and the session-established block.
- Add PARLE_PROFILES multi-room configuration with fail-closed preflight validation (issue #63 S1).
- Own one roomless session plus a room runtime per configured room, with per-room bearers, cursors, unread counts, and health.
- Isolate ordinary room-entry failures to one room; abort the set only on a session-scope rejection.
- Accept an optional roomId on read, inbox, send, and affordances; fail closed when several rooms are configured.
- Publish runtime snapshot schema v2 with rooms[]; readers accept v1 and v2.
- Fail profile switching closed while PARLE_PROFILES is active.
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
