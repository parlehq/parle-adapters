# Live profile switching

Status: implemented foundation with Pi bridge

## Decision

Live profile switching is local adapter lifecycle, not Parle API meaning. The HTTP API remains the canonical source for sessions, room entry, projection watermarks, and session retirement.

The shared client owns a credential-free `performProfileSwitch` orchestrator. It guarantees this ordering:

1. Resolve and validate the target without changing live state.
2. Prepare a target session on scratch state, without claiming any alias.
3. Run the pre-claim guard, then activate the alias claim if one is configured.
4. Commit the prepared state synchronously, including stopping use of the old room binding and resetting room-scoped cursor and deduplication state.
5. Retire the old agent session best-effort.
6. Restart host delivery best-effort.

Failures during resolution or preparation leave the active profile unchanged. Cleanup failures after commit are warnings because the new profile is already active and the old session will expire server-side.

## Pre-claim guard and publication barrier

The alias claim is the only authority-transferring call in a switch, so it is also the only ordering constraint that matters. The pre-claim guard is the last synchronous, local, fail-closed check: it runs after every non-mutating candidate call has succeeded and immediately before `POST /v/agent/sessions/{id}/claim-alias`. Nothing fallible may sit between the guard and the claim, and nothing after a committed claim may throw.

A guard that ran after the claim would be worse than no guard: alias authority would already sit on a candidate the adapter then refuses to publish, and an aliased candidate is deliberately never retired, so the address would route to an orphan session. The same ordering therefore applies to proactive rollover, not only to profile switching.

Responsive read fences are registered outside the lifecycle exclusion. Without further protection a read could open after the guard passed and before publication, which would make the guard advisory. A publication barrier is held for the duration of a switch, and a read that starts while it is held is refused with a retryable error rather than racing the transition.

## Alias domains and durable agents

Alias authority is scoped by durable agent id. `@principal.agent1.main` and `@principal.agent2.main` coexist, and a profile switch is not required to stay within one durable agent.

- Same-agent supersession may be assumed only when the authoritative pre-claim lookup reports `current_agent_session_id` equal to the source runtime session id. Token strings are never compared, because a rotated token still belongs to the same durable agent.
- When supersession is not proven (a different owner, no owner, or another durable agent), the source route stays live until it is ended explicitly with the source profile credential after local commit. That retirement is best-effort and a failure is surfaced as a warning.
- Moving one alias identity across durable agent ids is unsupported: the address embeds the agent handle, so a cross-agent switch yields a different address and never claims responsive continuity.
- A claim conflict leaves local publication untouched and reports that an external winner may already hold alias authority.

`PARLE_SESSION_ALIAS` resolves from process environment or `.env`, not from the profile catalog, so a switch changes which durable agent owns the alias rather than the alias string itself.

## Persistence

Switches are ephemeral and process-local. They do not rewrite `.env`, the profile catalog, or credentials. A cold restart returns to the configured `PARLE_PROFILE` or implicit default profile.

Persistent profile selection is a separate host policy and is not part of this primitive.

## Bridge ownership

The shared orchestrator contains no credentials and no watcher implementation. Each bridge supplies its existing credential-bearing preparation and lifecycle callbacks.

Pi owns its in-process watcher, responsive-delivery buffer, injection state, footer, and runtime snapshot. Its bridge therefore:

- prepares the target using its existing bootstrap against scratch runtime state
- synchronously stops the old watcher and adopts the target
- resets cross-room baseline, pending, seen, and injected state
- publishes one coherent runtime snapshot
- restarts the watcher with the target configuration

The MCP bridge exposes `parle_switch_profile`, but it does not own its watcher. That watcher is a separate sibling process launched with frozen room and token environment, and the stdio tool process has no handle or IPC mechanism to stop and restart it. The gap is closed by host attestation rather than by adapter mechanics: the tool requires `watcherStopped: true`, and the host is responsible for stopping the sibling task first and re-arming it afterwards with the returned profile, cursor, and agent session id. Switching stays refused outright while the hook bridge owns responsive delivery, because the MCP session, wake stream, queue, and hook binding must change atomically.

Nothing here changes with alias-aware switching. The alias claim, pre-claim guard, and publication barrier all live in the shared client, so the MCP bridge inherits them without owning its watcher.

## Safety invariants

- Never preserve a cursor across rooms, including when the alias string is unchanged.
- Never carry pending responsive rows or deduplication state across rooms.
- Never mutate `.env` to perform a live switch.
- Never commit target state before target session creation, room entry, and projection watermark retrieval succeed.
- Never claim an alias during candidate preparation; claim only at the pre-claim edge.
- Never let local publication throw once a claim has committed.
- Stop the old watcher as part of the synchronous commit.
- A failed target preparation must not end or alter the old live session, including its alias route.
- Status and runtime snapshots must show one coherent profile and room binding.
