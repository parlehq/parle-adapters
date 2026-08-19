# Changelog

## 0.7.53 (2026-08-18)

- Refresh the bundled client with stage-accurate responsive-delivery progress and additive acknowledgement evidence (#157).

## 0.7.52 (2026-08-18)

- Refresh the bundled client with the complete #156 room-recovery diagnostic fix.

## 0.7.51 (2026-08-18)

- Bundle timestamped responsive-delivery room diagnostics that clear only after same-domain recovery (#156).

## 0.7.50 (2026-08-18)

- Bundle shared startup cleanup for expired local runtime evidence (#149).

## 0.7.49 (2026-08-18)

- Expose first-time onboarding separately from returning login and route setup guidance by explicit user intent.

## 0.7.48 (2026-08-17)

- Add native preview-first room capacity recovery with fail-closed invoker protection and serial exact-session completion (#144).

## 0.7.47 (2026-08-17)

- Bundle the 2026-08-17 wire version required by the canonical error-contract hard cut (parlehq/parle#810).

## 0.7.46 (2026-08-17)

- Republish the merged #132 and #140 Pi bundle under a unique version after the concurrent releases shared 0.7.45; runtime behavior is unchanged from main.

## 0.7.45 (2026-08-17)

- Release alignment for #132; no Pi runtime behavior changed because Pi does not carry the MCP hook bridge.
- Add native `parle_room_participants` and guarded `parle_end_own_session` account tools for stale-session capacity recovery (#140).

## 0.7.44 (2026-08-17)

- Release alignment for #120; no Pi runtime behavior changed because Pi does not carry the MCP hook bridge.

## 0.7.43 (2026-08-17)

- Present email login starts as privacy-flat accepted requests, preserve the server status as data, and distinguish returning login from first-time onboarding.

## 0.7.42 (2026-08-16)

- Release alignment for #118; no Pi runtime behavior changed because Pi does not carry Claude's MCP hook bridge.

## 0.7.41 (2026-08-15)

- Refresh the native runtime with redacted API error details and deduplicated bootstrap-error status reporting (#126, #127).

## 0.7.40 (2026-08-14)

- Release alignment only; no Pi runtime behavior changed because the shared resolver update was not present in Pi's bundle.

## 0.7.39 (2026-08-14)

- Add native `parle_delete_profile` with degraded-safe local repair, live-client profile refusal, idempotent missing results, and no credential or path disclosure (#125).

## 0.7.38 (2026-08-13)

- Expose native `parle_create_own_agent` and `parle_delete_own_agent` tools backed by the shared account client, with explicit mutation confirmation and terminal-deletion guidance (#122).

## 0.7.37 (2026-08-13)

- Return `seat_required` before returning-login token mint when the selected exact agent lacks a room seat, and describe the separate confirmed admission operation for private and shared rooms (#121, parlehq/parle#800).

## 0.7.36 (2026-08-12)

- Inherit the shared client's in-place durable alias claim for anonymous live sessions (#115, parlehq/parle#797): a first claim now preserves the session, its participants, its wake stream, and outstanding exact-session opaque reply routes.

## 0.7.35 (2026-08-12)

- Enforce complete core durable-alias validation and refresh the native runtime.

## 0.7.34 (2026-08-12)

- Normalize durable session aliases to the core 2 to 32 character contract and refresh the native runtime.

## 0.7.33 (2026-08-11)

- Expose target-proof handle-or-email person invitation minting and privacy-flat email results (#113).

## 0.7.32 (2026-08-11)

- Bundle the 2026-08-10 wire default and capability-claim retirement (ADR-0100).

## 0.7.31 (2026-08-11)

- Move saved starts under the explicit `/parle start` namespace, execute the shared plan, reject loose free-text fallbacks, and abort cleanly when the save dialog is cancelled.

## 0.7.30 (2026-08-11)

- Make bare `/parle` output task-oriented, with clear commands to run, inspect, create, and remove saved starts.

## 0.7.29 (2026-08-11)

- Show missing saved starts one per line and tell users how to create the first one.

## 0.7.28 (2026-08-11)

- Add `/parle` saved starts with ordered optional profile, alias, and opaque next-instruction handling plus local list, show, save, and delete management (#107).

## 0.7.27 (2026-08-10)

- Refresh the native shared-client bundle with bounded responsive delivery drains.

## 0.7.26 (2026-08-10)

- Refresh the bundled runtime for the `2026-08-09` unified exact-seat admission hard cut.

## 0.7.25 (2026-08-09)

- Refresh the native shared-client bundle with session-scoped responsive-delivery resolution and bounded expired runtime evidence cleanup (#103, #104).

## 0.7.24 (2026-08-08)

- Restore bounded known-address context at Pi model boundaries, enroll only after successful direct routing receipts, and remove the legacy `/parle-peers` command, status field, renderer, and store integration (#96, #93).

## 0.7.23 (2026-08-08)

- Refresh the native shared-client bundle with the canonical safe-file foundation (#95).

## 0.7.22 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.7.21 (2026-08-08)

- Refresh the shared client with typed profile-resolution diagnostics used by recoverable MCP boot (#92).

## 0.7.20 (2026-08-08)

- Refresh the shared client and native bundle for the `2026-08-08` invitation locator hard cut.

## 0.7.19 (2026-08-08)

- Carry the shared client HTTP 408 terminal alias release ambiguity correction into the native Pi runtime.

## 0.7.18 (2026-08-07)

- Add native agent and human durable alias delivery tools, guarded two-step terminal release with explicit unknown outcomes for ambiguous completion, and server-authoritative known-alias send guidance (#86).

## 0.7.17 (2026-08-07)

- Publish room-local participant identity in credential-free runtime snapshots for colocated watcher continuity (#87).

## 0.7.16 (2026-08-07)

- Refresh shared inbox guidance so positive held backlog always marks results non-exhaustive (#81).

## 0.7.15 (2026-08-07)

- Refresh shared held-backlog diagnostics and make empty manual-inbox results explicitly non-exhaustive (#81).

## 0.7.14 (2026-08-07)

- Continue hardened email login through protected pending state and explicit TOTP completion (#84, parle#705).

## 0.7.13 (2026-08-06)

- Refresh the native shared controller so Pi recovers responsive work after reconnect or total advisory hint loss without requiring later room activity (#80).

## 0.7.12 (2026-08-06)

- Add native `parle_reply`, prefer opaque routes in responsive prompts, warn at two remaining replies, and stop reconstructing author selectors from handle provenance (#74).

## 0.7.11 (2026-08-05)

- Correct injected stable-peer guidance for current operator-supplied session routes while preserving compaction and provenance safeguards (#78).

## 0.7.10 (2026-08-05)

- Refresh the shared client and native bundle for the terminal `2026-08-05` wire contract.

## 0.7.9 (2026-08-05)

- Refresh the shared room inventory with credential-origin, pagination, mutation-outcome, and ready-room truth safeguards.

## 0.7.8 (2026-08-04)

- Add the read-only `parle_rooms` tool backed by the shared room inventory and label `parle_status.runtime.rooms` as active runtime state rather than exhaustive inventory (#685).

## 0.7.7 (2026-08-04)

- Render canonical send-attention guidance, remove the duplicate body-shape warning, and refresh shared-client receipt handling (#50).

## 0.7.6 (2026-08-03)

- Refresh the shared account client so `parle_login` can create an explicitly targeted missing profile without weakening other account operations.

## 0.7.5 (2026-08-03)

- Delegate login, room creation, own-agent seat admission, API-base validation, ADR-0036 framing, broad direct-looking mention warnings including `ask` and `tell`, and UTF-8-safe truncation to the shared client; complete and mint login actions now require explicit mutation confirmation plus a reason (#71).

## 0.7.4 (2026-08-03)

- Restore watcher and footer health after a retryable wake failure successfully reconnects internally, while preserving terminal and rate-limit containment.

## 0.7.3 (2026-08-03)

- Refresh the bundled shared client with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.7.2 (2026-08-03)

- Refresh the bundled shared client with explicit setup configuration state for adapter parity.

## 0.7.1 (2026-08-02)

- Add the required numeric timestamp to the injected peer-context message per the Pi 0.83 CustomMessage contract, and narrow the command-provenance claim to what the host actually guarantees.

## 0.7.0 (2026-08-02)

- Retain operator-tagged stable peer routes across compaction (#53): a /parle-peers operator command owns mutation, the context event re-injects exactly one authoritative block before every LLM call, session_compact notifies re-anchoring, and parle_status exposes a read-only peerContext section.

## 0.6.1 (2026-08-02)

- Schedule the idle injection flush from the delivery edge with fire-time host context, so a row arriving while Pi is fully settled injects and acknowledges autonomously instead of waiting for the next user-driven turn to settle (#67).

## 0.6.0 (2026-08-02)

- Adopt real multi-room operation (#66): PARLE_PROFILES resolves through Pi's own env and project sources into the shared client room set, preserving five-source single-binding semantics when the selector is absent.
- Make parle_read, parle_inbox, parle_send, parle_affordances, and parle_request room-explicit with sole-room omission compatibility; multi-room omission fails closed and lists the configured rooms.
- Publish rooms[] on status with no primary-room projection, label the footer with the room count, and run one shared delivery controller across the room set with room-scoped dedupe keys and room-tagged injection batches.
- Keep live profile switching fail-closed while multi-room mode is active.

## 0.5.0 (2026-08-02)

- Move Pi responsive delivery onto the shared ResponsiveDeliveryController: the controller owns the wake loop, drain, dedupe, and acknowledgement; Pi's handler queues rows as deferred and the idle flush completes them per row in order after injection, preserving cumulative-ack crash safety for seen rows behind un-injected predecessors.
- Keep watcher failure policy in Pi through the controller's onWakeError hook: rate-limit containment and parking, terminal latches, and footer states are unchanged host policy.
- Slim Pi's local runtime to host-policy and injection fields; session and room state is read only through the composed client view.

## 0.4.0 (2026-08-02)

- Move the Pi session spine onto the shared ParleAgentClient: bootstrap, alias claim and recovery, rollover, session publication, room runtime, request layer, and session end are client-owned, with one session owner.
- Keep Pi-only semantics in Pi: five-source configuration with session_file and the runtime profile override, address synthesis from principal and agent handles, rate-limit parking and failure latches, footer UX, and the pending-injection queue with its pre-ack fences.
- Route parle_read, parle_inbox, parle_send, parle_affordances, parle_switch_profile, and parle_session_alias through the shared client data plane and switch orchestration.
- Replace session keep-alive heartbeats with client-owned proactive rollover, and make the 429/401 watcher tests deterministic through the existing clock and sleep seams.

## 0.3.2 (2026-08-02)

- Refresh the bundled shared client with restartable controller delivery after a terminal wake failure.

## 0.3.1 (2026-08-02)

- Refresh the bundled shared client so eager multi-room bootstrap no longer fails a self-inflicted profile selector conflict.

## 0.3.0 (2026-08-02)

- Adopt the shared alias authority module and delete Pi's duplicated claim, lookup, and session-inventory code.
- Report the alias a session left behind, why peers holding it are stranded, and how to reclaim it (#27).
- Key profile-switch publication off explicit claim authority instead of inferring it from the alias field.
- Publish runtime snapshot schema v2 with rooms[].
- Allow a configured session alias across a live profile switch, with the pre-claim guard, publication barrier, and source retirement rules from the shared client.

## 0.2.2 (2026-08-02)

- Retain one continuous responsive-read fence through queueing and injection, updated from the authoritative response cursor scope, without letting that active read self-block bootstrap recovery.
- Surface committed-but-unavailable alias claims and recover through a fresh preparation cycle.

## 0.2.1 (2026-08-02)

- Retry transient startup bootstrap failures automatically after the server deadline without requiring a tool call.
- Fence responsive reads at request start so exact-session rows cannot cross rollover before entering the pending queue.

## 0.2.0 (2026-08-02)

- Require the 2026-08-01 wire contract and remove alias-at-mint.
- Prepare anonymous candidates, recover alias generations through bounded inventory, claim with an exact fence, and proactively roll sessions before expiry.
- Restart the Pi wake watcher after proactive swaps, drain immediately, and report server-selected cursor scope and exact-session continuity limits.
