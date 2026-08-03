# Changelog

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
