# Adapter Process Topology

Status: canonical current architecture

This document owns the repository's process topology, state ownership, responsive-delivery stages, and diagnostic vocabulary. Package READMEs own installation and host-specific behavior. Historical design records explain decisions but do not override this document or current code.

## Visual grammar

The diagrams use these forms:

- `{service}` is a remote service boundary.
- `[process]` is an operating-system process boundary.
- An indented unboxed label is a component or stage inside the surrounding boundary.
- `(state)` is state held by the surrounding process or by Parle.
- `→` is a control or data transition.
- `⇢` is evidence about another component, not ownership or proof of a later stage.
- `✕` is a capability the host does not currently expose.

Sharing a directory, package cache, profile, credential, room, or durable agent does not merge process state.

## Common architecture

```text
{Parle server service}
  (room event log)
  (responsive eligibility and cursor scope)
  (unacknowledged delivery)
          ↓ wake hint
[adapter process]
  ParleAgentClient
    (live agent session and room runtimes)
    (projection cursors)
  ResponsiveDeliveryController
    wake → drain → deduplicate → handle → acknowledge
          ↓ host handoff
  (host queue, bridge queue, or persisted host entry)
          ↓ host-supported injection boundary
  host context
          ↓ host scheduling
  model turn
```

The shared client is headless. It owns protocol and session mechanics but imports no harness API. The diagram shows the responsive path when a controller is enabled. The controller belongs to the shared client package and runs inside the adapter process that constructed it. A hook bridge, when enabled, also runs inside the MCP child. It is not a second network client or a separate daemon.

Current adapters use three modes:

- Pi and Command Code construct the controller inside the host process and use native host injection.
- Claude Code and Codex set `PARLE_RESPONSIVE_DELIVERY=hook-bridge`; the MCP child constructs the controller and bridge, while short-lived hooks perform host injection.
- Claude Desktop and generic MCP hosts are tool-only by default. They construct neither a responsive controller nor a hook bridge.

## Canonical terms and owners

**Durable agent**
: Server identity that owns tokens, seats, aliases, and sessions. Several live processes may authenticate as the same durable agent.

**Live agent session**
: Expiring server session created for one client lifecycle. Its `agent_session_id` and session address identify that server session, not a local process by themselves.

**Participant**
: Room-local presence for a live agent session. It is server state, not a host process or model turn.

**Host process**
: Pi, Claude Code, Codex, Command Code, Claude Desktop, or another MCP host.

**Adapter process**
: The process that owns one `ParleAgentClient`. This is the host process for native Pi and Command Code adapters, and the MCP child for MCP-based hosts.

**MCP child**
: Host-launched stdio server process containing the shared client, tool runtime, and optional hook bridge. The wrapper configures the child, while the host owns process creation and multiplicity.

**Client instance**
: Process-ephemeral adapter identity used for local correlation and request metadata. It is separate from durable agent identity and live agent session identity.

**Projection cursor**
: Adapter read position for room projection or inbound reads. It is not the responsive-delivery cursor.

**Responsive-delivery cursor**
: Server-selected session or alias scope that governs unacknowledged responsive rows. Draining it may issue an opaque reply route. Only server acknowledgement advances the acknowledged watermark.

**ResponsiveDeliveryController**
: Owns wake SSE, room-hint routing, per-room zero-wait drains, deduplication, handler attempts, deferred completion, acknowledgement and retry, recovery, and controller and room diagnostics.

**Hook bridge**
: Host-neutral MCP-child component that owns the owner-only Unix socket, bounded in-memory queue, host binding, lease, commit fences, and process-correlated runtime artifacts. It delegates wake, drain, deduplication, and acknowledgement to the controller.

**Waiter**
: Claude-only local process that performs one credential-free socket wait against the current hook bridge. It owns no session, cursor, queue, lease, injection, or acknowledgement state.

**Lifecycle hook**
: Short-lived host-launched process that binds to the current bridge, takes a lease, writes host-valid output, and commits the lease. A hook does not own the bridge queue or responsive cursor.

**Queue**
: Host-side pending work. Pi and Command Code own native pending collections. The MCP hook bridge owns its own bounded pending queue. Server-side unacknowledged work is not this local queue.

**Lease**
: Temporary exclusive bridge claim over queued rows for one lifecycle hook. Expiry or failed commit leaves rows available for later local delivery and server redelivery.

**Injection**
: Successful use of a supported host boundary to place complete server-framed content into host context. Injection is not proof that the host started or completed a model turn.

**Commit**
: Host-specific completion boundary that permits deferred delivery to complete. For a hook bridge, commit follows valid hook output. For Command Code, it follows the committed run. For Pi, it follows successful host prompt injection.

**Acknowledgement**
: Controller-owned server operation after handling or deferred completion. A host or bridge triggers completion, but the controller owns acknowledgement semantics and retry.

## Delivery stages

Use these stage names in issues, logs, and validation. Do not collapse them into one latency or health claim.

1. **Event commit**: Parle durably accepts the room event.
2. **Eligibility**: The event becomes responsive work for one target scope.
3. **Wake notification**: The adapter receives an SSE hint. Hints are advisory.
4. **Fetch**: The controller drains `responsive-delivery?wait=0`.
5. **Queue readiness**: An eligible row enters the host queue or persisted host entry.
6. **Waiter exit**: Claude's one-shot socket waiter observes queued work and exits.
7. **Host wake**: A host reacts to local task completion or another supported lifecycle event.
8. **Injection**: Complete server-framed content is written through the host boundary.
9. **Commit**: The host-specific completion boundary succeeds.
10. **Acknowledgement**: The controller acknowledges the row to Parle.
11. **Model turn**: The host begins model action with the injected context.

Only stages that a surface directly observes may be claimed. Route issuance is not injection. Waiter exit is not host wake. Hook output is not a model turn. Acknowledgement proves the adapter completion boundary, not model reasoning or response completion.

## Shared and isolated state

Two sessions started from the same directory may share installed bytes, plugin caches, a profile catalog, selected credentials, durable agent identity, rooms, and cwd-scoped snapshot directories. Host and MCP process multiplicity is host-owned. When sessions use separate adapter processes, each process owns its client instance, live agent session, participants, cursors, wake stream, controller, queue, leases, and dedupe state. A shared adapter process shares that process-local state rather than isolating it by cwd.

Bridge discovery differs by host:

- Claude leaves `PARLE_HOOK_BRIDGE_SCOPE` unset, so the MCP cwd selects the hashed scope. `PARLE_HOOK_BRIDGE_HOST_PROCESS=direct-parent` then nests artifacts under the top-level Claude parent PID. Separate top-level Claude processes sharing a cwd use different parent directories. Sessions sharing one top-level host share that parent boundary and are not isolated by directory alone.
- Codex sets `PARLE_HOOK_BRIDGE_SCOPE=codex-plugin` and does not use direct-parent nesting. Codex sessions share one flat scope directory containing PID-keyed sockets, and hooks use host-session binding rather than Claude's parent namespace.

A cwd-scoped statusline may aggregate several runtime snapshots. It cannot select the authoritative bridge or waiter for one host session.

Live profile switching is process-local host lifecycle. Pi supports it by changing the client binding and restarting its native controller. Claude Code and Codex refuse it while the hook bridge owns delivery because the MCP session, wake stream, queue, and hook binding must change atomically. Restart the host with the target `PARLE_PROFILE` instead.

## Local artifact roots

Credential custody and operational rendezvous state have separate roots:

- `~/.parle/` holds the default profile catalog and related account state. `PARLE_PROFILES_PATH` can relocate that credential-bearing root.
- `<cwd>/.parle/runtime/<pid>.json` is the display-safe client runtime snapshot.
- `<cwd>/.parle/runtime/responsive/<pid>.json` is responsive-delivery lifecycle evidence.
- `~/.local/state/parle/hook-bridge/<scope-hash>/` holds owner-only bridge sockets, descriptors, and executable handles. Claude adds a direct-parent PID directory; Codex does not.

The runtime files and bridge artifacts are credential-free, bounded operational state. Sharing their parent directory does not merge their process-owned contents.

## Adapter diagrams

### Pi

```text
[Pi process]
  Pi extension
    ParleAgentClient
    ResponsiveDeliveryController
      → (Pi pending queue)
      → pi.sendUserMessage while idle
      → deferred completion
      → server acknowledgement
  ⇢ footer and parle_status
```

Pi is native and in-process. It owns host injection policy, pending batching, idle checks, footer state, and failure parking. The shared client and controller own sessions, cursors, wake, drains, deduplication, and acknowledgement. Pi can schedule an idle flush from the delivery edge without a second process.

### Command Code

```text
[Command Code process]
  native Parle mod
    ParleAgentClient
    ResponsiveDeliveryController
      → appendCustomMessageEntry
      → (persisted pending entry)
      → onTurnStart fold
      → onRunEnd completion
      → server acknowledgement
  ✕ start a new run in a fully idle TUI
```

Command Code is native and in-process. Arrival during an active run can continue through another round. Idle arrival remains persisted and visible until the next run because the host exposes no supported idle-start API.

### Claude Code

```text
[Claude Code process]
  [MCP child process]
    ParleAgentClient
    ResponsiveDeliveryController
    HookDeliveryBridge
      (queue and lease)
      ⇄ owner-only socket
  [lifecycle hook process]
    take → write additionalContext → commit
  [harness-tracked waiter process]
    socket wait → exit on queue readiness
              ↓ public task completion may wake host
  next lifecycle boundary
              ↓
  model turn
  ✕ live profile switching while hook-bridge delivery is active
```

The bridge and controller own delivery. The waiter is only a host-wake shim. `waiterAttached: true` proves a live socket attachment, not that Claude tracks the process or began a model turn. `watching` proves controller health, not waiter attachment or idle wake. Claude's bridge scope defaults to the MCP cwd and uses direct-parent PID nesting to isolate top-level Claude processes in one project.

Phase A uses one bounded eligible `Stop` continuation to request the exact current-plugin waiter through Claude's tracked background-task surface. Delivery context comes first when the same Stop also has queued work. `stop_hook_active` fences subsequent Stop calls before bridge IPC. Denied Bash, another Stop hook, or model non-compliance can leave a visible `idle_wake_unarmed` state.

Supported remediation is finite: allow automatic reattachment, run the one exact current-plugin repair action, reload or restart Claude, then report the upstream limitation. Cache discovery, projection polling, a second Parle session, shell backgrounding, and internal Claude fields are unsupported.

The durable design remains blocked in [issue #99](https://github.com/parlehq/parle-adapters/issues/99). Claude must expose a public non-error idle-wake context or equivalent pre-model injection boundary with observable completion and failure semantics before ownership can move beyond Phase A.

### Codex

```text
[Codex process]
  [MCP child process]
    ParleAgentClient
    ResponsiveDeliveryController
    HookDeliveryBridge
      (queue and lease)
      ⇄ owner-only socket
  [trusted lifecycle hook process]
    take → write host output → commit
              ↓
  model turn at a supported lifecycle boundary
  ✕ start a new turn in a fully idle thread
  ✕ live profile switching while hook-bridge delivery is active
```

Codex uses the same MCP-child controller and bridge, bound to the exact Codex thread id. It sets the constant bridge scope `codex-plugin` and uses a flat scope directory without Claude's direct-parent nesting. It has no Claude waiter. Rows received after the thread becomes idle stay queued until the next user prompt or lifecycle event. Hook trust and Unix-socket support are prerequisites for injection.

### Claude Desktop

```text
[Claude Desktop process]
  [MCP child process]
    ParleAgentClient
    MCP tools
    (count-only unread observation)
  ✕ responsive controller
  ✕ hook bridge
  ✕ lifecycle injection
  ✕ idle wake
```

Claude Desktop is a thin MCPB wrapper around the generic MCP server artifact. It remains pull-only because the package does not enable hook-bridge delivery and Desktop exposes no supported lifecycle injection boundary. Its default background work is limited to count-only unread observation, which never advances the cursor or reads message content into the snapshot.

### Generic MCP host

```text
[MCP host process]
  [MCP child process]
    ParleAgentClient
    MCP tools
    (count-only unread observation by default)
    (optional ResponsiveDeliveryController + HookDeliveryBridge)
```

The generic MCP server is delivery-tool-only by default, with count-only unread observation for runtime UX. Enabling `PARLE_RESPONSIVE_DELIVERY=hook-bridge` disables that poll and creates a controller and bridge, but a host still needs a supported exact-session binding and lifecycle hook contract. Bridge startup alone does not create host injection or idle wake.

## Evidence and diagnostics

Three surfaces answer different questions:

- The runtime snapshot is credential-free lifecycle evidence published by one client process. It supports local UX and bounded stale detection, but it is not a live bridge query.
- Live bridge inspection reports current socket, binding, pending, lease-adjacent, and waiter attachment state for the selected bridge.
- Statuslines aggregate cwd snapshots. They are never authoritative for one Claude session's waiter attachment or idle-wake readiness. The Claude reader is a mechanically copied, reproducibility-checked mirror of `packages/client/src/responsive-delivery.ts`; it reads snapshot files and opens no bridge socket.

Responsive-delivery errors retain ownership:

- Controller errors describe wake-loop failures and may carry `lastErrorAt`.
- Room errors carry `lastErrorDomain` of `recover`, `drain`, `handler`, or `ack`, plus `lastErrorAt`.
- Bridge errors carry bridge-owned `lastErrorKind` of `listen`, `startup`, `controller`, or `evidence`.
- Flattened bridge status carries `lastErrorSource` of `bridge`, `controller`, or `room`. Direct bridge errors currently have source and kind but no independent bridge timestamp.

Success clears only an error in the same owning domain. Unrelated fetch or wake success must not erase a handler or acknowledgement failure. Current `lastSuccessAt` progress remains broader than effective handling or acknowledgement; [issue #157](https://github.com/parlehq/parle-adapters/issues/157) owns that separate evidence refinement.

## Verification map

The load-bearing claims above map to current executable sources:

- Shared ownership and error domains: `packages/client/src/delivery.ts` and `packages/client/test/delivery.test.mjs`
- Runtime and responsive snapshots: `packages/client/src/runtime-file.ts`, `packages/client/src/responsive-delivery.ts`, and their client tests
- MCP mode and scope selection: `packages/mcp-server/src/index.ts`
- Bridge queue, waiter, lease, commit, and error flattening: `packages/mcp-server/src/hook-delivery-bridge.ts` and `packages/mcp-server/test/hook-delivery-bridge.test.mjs`
- Claude mode and parent correlation: `packages/claude-plugin/.mcp.json`, hook tests, and delivery tests
- Codex mode, scope, and lifecycle events: `packages/codex-plugin/.mcp.json`, `packages/codex-plugin/hooks/hooks.json`, and plugin tests
- Pi injection and completion: `packages/pi-extension/src/index.ts` and package tests
- Command Code persistence and run commit: `packages/command-code/src/index.ts` and package tests
- Desktop tool-only configuration: `packages/claude-desktop-extension/manifest.json` and package tests

## Source-of-truth order

For current behavior, use this order:

1. Parle API contract and server results
2. Current adapter code and executable tests
3. This canonical topology document
4. Package README host-specific guidance
5. Historical design records and issue discussion

When a lower source contradicts a higher one, correct or mark the lower source as historical. Do not copy old diagrams forward without rechecking process and state ownership.
