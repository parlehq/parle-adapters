# Changelog

## 0.8.27 (2026-08-11)

- Move principal invitation minting to the target-proof person endpoint with leading-at handle or email targets, idempotency keys, strict handle results, and honest privacy-flat email outcomes (#113).

## 0.8.26 (2026-08-11)

- ADR-0100 hard cut: default Parle-Version advances to 2026-08-10; parle_claim_principal_invite fails fast as terminally retired (capability claims answer 410 invite_capability_retired server-side) and directs callers to parle_accept_room_invitation / parle_connect_own_agent.

## 0.8.25 (2026-08-11)

- Own saved-start execution ordering through typed shared plans, reserve management names, and keep not-found errors harness-neutral.

## 0.8.24 (2026-08-11)

- Render missing saved starts as a readable list and give empty catalogs a direct creation prompt.

## 0.8.23 (2026-08-11)

- Add a credential-free saved-start catalog with safe list, load, save, and delete primitives for optional profile, alias, and opaque next instructions (#107).

## 0.8.22 (2026-08-10)

- Bound zero-wait responsive delivery drains so optional hook bridge startup cannot wait forever on a stalled request.

## 0.8.21 (2026-08-10)

<!-- public-wire-lint: allow wire-version -- historical release note -->

- Pin `Parle-Version: 2026-08-09` for the unified exact-seat admission hard cut.

## 0.8.20 (2026-08-09)

- Scope responsive-delivery resolution strictly to the calling agent session, report missing caller evidence honestly, and opportunistically reap a bounded number of expired records whose owners are definitively gone (#103, #104).

## 0.8.19 (2026-08-08)

- Add the automatic bounded known-address registry using shared safe-file mechanics, enroll only from successful direct routing receipts, apply deterministic expiry and eviction, and remove every legacy peer-context export (#96, #93).

## 0.8.18 (2026-08-08)

- Add canonical typed safe-file primitives with bounded owner-only reads, symlink refusal, atomic durable replacement, token-owned stale-recovering locks, and matching profile, login, hardening, and runtime adoption (#95).

## 0.8.17 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.8.16 (2026-08-08)

- Add typed `profile_not_found` configuration diagnostics with the offending selector and redaction-safe available-profile list, and classify startup profile and multi-room selector conflicts as recoverable configuration errors (#92).

## 0.8.15 (2026-08-08)

- Pin the then-current Parle wire version and accept only bare invitation UUIDs or canonical `/room-invitations/<uuid>` URLs while keeping API transport configured locally.

## 0.8.14 (2026-08-08)

- Treat HTTP 408 from terminal alias release completion as an ambiguous outcome that requires byte-identical idempotent replay.

## 0.8.13 (2026-08-07)

- Add default-on durable alias offline-delivery controls for agent and human owners, guarded terminal release with explicit unknown outcomes for ambiguous completion, and server-authoritative known-alias sending without peer-context gating (#86).

## 0.8.12 (2026-08-07)

- Publish room-local participant identity in credential-free runtime snapshots so colocated watcher filters can follow privacy-flat self identity across rollover (#87).

## 0.8.11 (2026-08-07)

- Warn on any positive held backlog, including partial read results, and explain that in-order watermark parking can withhold more later rows than held_count reports (#81).

## 0.8.10 (2026-08-07)

- Refresh held-backlog diagnostics on every successful read and add bounded empty-read guidance that cannot be mistaken for exhaustive inbox absence (#81).

## 0.8.9 (2026-08-07)

- Continue hardened email-code login through protected pending state and explicit TOTP completion without exposing cookies or proofs (#84, parle#705).

## 0.8.8 (2026-08-06)

- Reconcile durable responsive delivery after wake-stream establishment, recover total hint loss through the ADR-0059 fallback fetch, honor server timing and jitter, and route unexpected stream completion through bounded reconnect recovery (#80).

## 0.8.7 (2026-08-06)

- Add strict universal reply-route normalization, route-first presentation with server-reported hop warnings, and a distinct idempotent opaque-route submission primitive without selector or broadcast fallback (#74).

## 0.8.6 (2026-08-05)

- Allow a current operator-supplied full session route for its bounded workflow while preventing the injected peer-context block or peer-authored text from re-establishing routing identity (#78).

## 0.8.5 (2026-08-05)

<!-- public-wire-lint: allow wire-version -- historical release -->
- Require the terminal `Parle-Version: 2026-08-05` wire contract with no negotiation or fallback.

## 0.8.4 (2026-08-05)

- Bind account inventory to the selected deployment, reject unsafe human-session files and malformed cookies before fetch, report pagination ceilings truthfully, and fail closed on truncated login selection.
- Make email completion persist only the human session; keep token minting in a separate confirmed `mint-from-session` action, report uncertain or unpublished credentials without exposing secrets, and never attempt an automatic noncanonical cleanup mutation.
- Keep only ready runtime rooms in active inventory and retain direct local room configuration as a separate unverified source before bootstrap.

## 0.8.3 (2026-08-04)

- Add one typed room-inventory path that composes active runtime rooms, redacted configured profiles, and paginated principal account rooms without conflating their authority; share deterministic formatting, bounded continuation, stable partial-failure states, and path-free diagnostics across hosts (#685).
- Reuse the account-room paginator during login selection so inventories beyond the first page are not silently ignored.

## 0.8.2 (2026-08-04)

- Surface server-authored routing and attention without local inference, warn conservatively from reported responsive scope, and give moderation.delivery_state precedence over legacy posture details (#50).

## 0.8.1 (2026-08-03)

- Allow login to bootstrap an explicitly targeted missing profile in an otherwise populated catalog while retaining strict selected-profile resolution for other account operations.

## 0.8.0 (2026-08-03)

- Move email login, room creation, and own-agent seat admission into `ParleAccountClient`, including shared session-cookie and profile-catalog persistence that requires explicit mutation confirmation, rejects user-owned symlinked path components, revalidates sinks before atomic replacement, and reports actionable catalog-lock contention.
- Fix losing profile writers so they never remove the active writer's lock.
- Converge API-base validation, ADR-0036 frame compaction, broad direct-looking mention detection, and explicit UTF-8-safe truncation in client-owned helpers (#71). Guidance document policy remains coordinated with #30.

## 0.7.0 (2026-08-03)

- Add an optional wake-open lifecycle callback so hosts can observe successful internal stream reconnects instead of remaining latched to the preceding failure.

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

<!-- public-wire-lint: allow wire-version -- historical release note -->
- Require `Parle-Version: 2026-08-01` with no negotiation or fallback.
- Create sessions anonymously, prepare rooms and wake readiness, then generation-fence alias claims from bounded self-session inventory.
- Add deterministic proactive rollover scheduling, single-flight preparation, bounded failure latching, session revision events, and honest anonymous handoff state.
- Expose server-selected responsive cursor scope without coupling it to projection cursor state.
