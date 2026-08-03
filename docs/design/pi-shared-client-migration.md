# Pi and hook-bridge convergence on the shared client

Status: implemented. S5 slice 1 and 2 and S6 are landed; kept as the record of why the spine could not be split.

## Why the obvious slicing does not work

The approved plan was to move Pi's responsive delivery onto
`ResponsiveDeliveryController` first and its configuration and lifecycle second.
That order is not implementable, and two smaller entry points fail as well.
Each was attempted against the code before this note was written.

**Delivery cannot go first.** The controller drives a `ParleAgentClient`: it
calls `drainResponsiveDelivery`, `ackResponsiveDelivery`, `openWakeStream`,
`ensureBootstrapped`, `recoverRoom`, `onSessionRevision`, and reads
`runtime.rooms`. Pi has none of these. It has its own `requestJson(cfg, ...)`,
its own delivery fences, and its own rebootstrap. Pi must own a client before it
can adopt the controller.

**The shared helpers are not interchangeable.** Eight functions exist in both
packages under the same name, and only the names match: Pi's `truncateText`
returns an extra `returnedBytes`, `updateCursorFromMessages` accepts
`number | undefined`, `compactServerWrappedContent` takes a message object
rather than `(content, preamble, fence)`, and `assertSafeBase` omits the
environment argument. Sharing them requires per-call shims that add indirection
without deleting duplication. They converge for free once Pi uses the client's
request and delivery layer, and not before.

**Configuration is not a drop-in either.** Pi resolves configuration from five
sources, including a `session_file` and a runtime profile override that the
shared resolver does not model, and its `ParleConfig` carries `principalHandle`,
`agentHandle`, `sessionCookie`, `agentId`, and `profilesPath`. Delegating
wholesale would silently drop source support that Pi hosts rely on.

The conclusion is that Pi's session spine is one unit. Every partial state
leaves Pi with two session owners, which is exactly the duplicated authority the
milestone exists to remove.

## What already landed

- Durable alias authority is shared and transport-agnostic. Pi's copies of the
  claim, lookup, and inventory paging are deleted.
- `ResponsiveDeliveryController` owns wake, routing, per-room drain,
  deduplication, acknowledgement, poison bounds, recovery, and diagnostics.
- The controller supports a `deferred` outcome, which is the contract both
  remaining hosts need: each accepts a row, acts on it later, and reports
  completion so acknowledgement still follows effective handling.

## Order

### S5 slice 1: Pi owns a ParleAgentClient

One commit, because the runtime object is the spine every other part reads.

1. Construct the client from Pi's resolved configuration, keeping Pi's extra
   config fields and source precedence in Pi.
2. Replace Pi's bootstrap, alias claim, rollover, session publication, and room
   runtime with the client's, and delete the replaced code.
3. Map the client's runtime and `rooms[]` onto Pi's footer and status surfaces.
   Pi keeps watcher policy: rate-limit parking, failure latches, backoff states.
4. Route Pi's tool handlers through the client's data plane.
5. Rewrite the `__testing` seams the suite drives. The suite asserts Pi
   internals (`runtimeState`, `patchRuntime`, `handleWakeHint`, `requestJson`,
   `performSessionRollover`), so this is part of the same unit, not follow-up.

### S5 slice 2: Pi delivery onto the controller

Small once slice 1 lands. Pi's handler queues a row and returns `deferred`; its
idle flush calls `completeDeferred` after injection. Delete Pi's wake loop,
baseline, drain, dedupe, and acknowledgement.

### S6: hook bridge and one Claude injection owner

The MCP hook bridge already drives a real client, so it can adopt the controller
without waiting for Pi. Its lease and commit flow maps onto `deferred` plus
`completeDeferred`. Its session-commit guard stays: that is host policy about
pending hook work, not delivery mechanics.

## Verification bar

Every slice: `pnpm typecheck`, every package suite, `pnpm refresh:mcp-artifacts`
then `pnpm check:mcp-artifacts`, and a coherent commit. Then re-run the
seventeen-point production matrix in `docs/design/multi-room-agent-sessions.md`
through the changed host path, including the omitted-`roomId`-then-wake
regression that a live session caught and no unit test did.
