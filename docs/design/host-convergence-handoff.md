# Host convergence handoff: S5 and S6

Status: ready to implement, with owner boundaries and seams established by probing

This is the implementation contract for the two remaining host slices of issue
#63. It exists so the next context starts from findings rather than
re-deriving them. The order in `pi-shared-client-migration.md` still holds and
explains why the spine cannot be split.

## Owner boundaries

These are the lines the finished branch must land on.

**The shared client owns** configuration resolution and its warnings, the
request layer and its error envelope, session bootstrap, durable alias
authority, proactive rollover, session publication and runtime snapshots, room
runtimes and cursors, and the terminal latches for session and room scope.

**The shared controller owns** the wake stream, room-hint routing, per-room
drain ordering, deduplication by room and event, acknowledgement including
retry, poison bounds, degraded-room recovery, and delivery diagnostics.

**Each host owns** only what is genuinely host policy: its tool registration and
schemas, its user-facing surfaces, its injection or hook mechanics, its idle and
batching rules, and its own failure policy such as rate-limit parking. A host
never owns a session, a cursor, an alias claim, or an acknowledgement.

## S5: Pi

### Deletion targets

`ownAliasFacts` and `claimAliasWithRecovery` wrappers, `bootstrap`,
`prepareCandidate`-equivalent logic, `completePiCandidateHandoff`,
`performSessionRollover`, `scheduleSessionRollover`, `maybeHeartbeatAgentSession`,
`endAgentSession`, `requestJson`, `parleRequest`, `fetchWakeStream`,
`consumeWakeStream`, `handleWakeHint`, `baselineResponsiveDelivery`,
`ackResponsiveMessage`, `deliveryFence`, `activeResponsiveReads`,
`assertPiCommitAllowed`'s delivery half, `publishRuntimeState`, `runtimeFilePath`
and its siblings, and the eight helpers duplicated by name.

### Pi-only semantics that must survive

These are the reason a wholesale config swap is wrong. Preserve them in Pi and
pass the result into the client:

- five configuration sources, including `session_file` and the runtime profile
  override, which the shared resolver does not model
- `principalHandle`, `agentHandle`, `agentId`, `sessionCookie`, `profilesPath`
- address synthesis from principal and agent handles when the server omits an
  address
- `enabled` as a resolved boolean, not just the raw input

### Test seams

The suite drives Pi through `__testing`. These move rather than disappear:
`runtimeState` and `patchRuntime` become views over the client's runtime and
`rooms[]`; `handleWakeHint`, `queueResponsiveMessages`, and
`flushPendingResponsiveMessages` reduce to the handler and the idle flush;
`requestJson`, `parleRequest`, and `fetchWakeStream` disappear entirely;
`performSessionRollover` delegates. Rewriting them is part of the same commit,
not follow-up work.

### Invariant tests to carry forward

The alias-authority tests, the pre-claim guard tests, the publication-barrier
tests, the profile-switch supersession and conflict tests, and the injection
crash-safety behaviour: a row is acknowledged only after injection, never at
drain time.

## S6: hook bridge

The bridge already drives a real client, so it can adopt the controller without
Pi. `receive()` returns `deferred` for a queued row and `intentionally_skipped`
for session-scoped baseline; `commit()` calls `completeDeferred` per message.
The lease, the socket protocol, `assertMessageCurrent`, and `guardSessionCommit`
stay: they are host policy about pending hook work.

Four seams were found by attempting the swap. They are the whole remaining cost:

1. **Drain termination.** The bridge's old rule was "a repeated all-known batch
   is the boundary". The controller's rule is "no progress in a batch". These
   now agree for deferred rows, because a pending deferred row no longer counts
   as progress, but the bridge's test asserts an exact drain call count that is
   coupled to the old loop and must be restated as a termination property.
2. **Baseline accounting.** `baselineSkipped` was counted by the bridge's own
   loop. It now comes from the handler returning `intentionally_skipped` during
   the baseline window, so the counter moves and the assertions with it.
3. **Startup ordering.** The old bridge published its socket after baseline and
   started the wake loop in the background, so a wake failure did not tear down
   the bridge. Awaiting `controller.start()` inside `startBridge` changes that:
   keep the socket listening before the controller starts, and do not let a wake
   failure remove the runtime artifacts.
4. **Fake clients.** The bridge tests use hand-written clients that predate the
   room-explicit contract. Each needs `runtime.rooms`, `onSessionRevision`, and
   room-aware `drainResponsiveDelivery`.

## Verification bar

Every slice: `pnpm typecheck`, every package suite, `pnpm refresh:mcp-artifacts`
then `pnpm check:mcp-artifacts`, one coherent commit, and a fast-forward push.
Then re-run the seventeen-point production matrix through the changed host path,
including the omitted-`roomId`-then-wake regression that a live two-room session
caught and no unit test did.
