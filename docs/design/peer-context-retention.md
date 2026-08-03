# Deterministic stable peer-alias retention across harness compaction

Status: design gate for issue #53, host boundaries verified against shipped
host APIs before implementation

## Problem recap

An operator can hand an agent a stable peer route ("reach me at
@gilman.galexc.lead") and a collaborator role. Harness compaction can drop
that from model context, after which the agent may silently reuse an expired
random session address. The shared client does not own harness memory, so a
prose reminder is not deterministic acceptance. This design answers the #53
design gate per host and stays at L2/L3: no wire semantics, no ADR-0036
change, no discovery, no roster.

## Principles

- **Stability is an operator fact, not an address property.** Random session
  handles and durable aliases can overlap syntactically, so nothing is ever
  inferred from address shape. A route is stable because an operator
  explicitly tagged it through a host-verified input surface, and only the
  tagged set is retained.
- **Mutation lives outside model-callable surfaces.** The structural
  guarantees are exactly two: no model-callable tool mutates the store, and
  peer content is never parsed for identities. The writing surfaces add
  interactivity friction (a TTY gate plus a confirmation typed on the
  controlling terminal; Pi's extension command), which excludes hooks, pipes,
  and casual automation but is not proof of human origin: a host that grants
  an agent unrestricted shell or command-dispatch access can cross it, and
  for such hosts the enforceable boundary is the host's own permissioning.
- **Rehydration is bounded and deterministic.** Each host re-renders one
  authoritative block at a boundary its runtime actually fires, never a
  best-effort prompt convention.

## The durable store

One operator-owned file beside the resolved profile catalog:
`dirname(profilesPath)/peers` (relocated with `PARLE_PROFILES_PATH`), written
with the same discipline as the session cookie file: owner-only 0600, symlink
resolved, atomic replace. JSON with bounded size:

```json
{ "version": 1, "peers": [
  { "label": "lead", "address": "@gilman.galexc.lead",
    "role": "implementation lead", "taggedAt": "2026-08-02T…" }
] }
```

An entry exists only because an operator created it. There is no inferred
entry, no stability field to compute, and no expiry probe: absence from this
file is what "not retained" means.

## Design gate answers per host

For each host: durable store; how a stable alias is tagged; how an ephemeral
address is distinguished and rejected after expiry without a roster oracle;
which hook owns refresh and rendering; how stale context is cleared.

### Pi (`@earendil-works/pi-coding-agent` >= 0.83, verified)

- Store: the shared peers file, read through the shared client module.
- Tagging: a `/parle-peers add <label> <address> [role…]` extension command.
  This keeps mutation out of every model-callable tool; command dispatch
  provenance is only as strong as the host makes it (Pi can dispatch
  commands from RPC), per the mutation principle above.
- Rejection of ephemeral routes: the rendered block lists only tagged
  routes and states that session-qualified routes not listed are not
  retained and must not be reused; the agent is told to request an
  operator-supplied stable route or use the server-authenticated
  `author.address` of a fresh message. No validity probing.
- Refresh/rendering owner: the extension's `context` event, which fires
  before every LLM call and permits non-destructive message modification.
  The handler removes any previous copy of the block and appends the current
  render, so exactly one authoritative copy exists in every request,
  including the first call after compaction. `session_compact` additionally
  notifies the operator that peer context was re-anchored.
- Stale clearing: `/parle-peers remove <label>` and `/parle-peers clear`.

### Claude Code (claude-plugin)

- Store: the shared peers file.
- Tagging: the TTY-only `parle-peers` helper (below); the model-callable
  surface stays read-only.
- Refresh/rendering owner: plugin hooks. `SessionStart` (all sources,
  including `compact` and `resume`) emits the block as `additionalContext`,
  so every fresh or compacted context window re-receives it exactly once.
- Stale clearing: the same TTY helper.

### Command Code (command-code adapter)

- Store: the shared peers file.
- Tagging: the TTY-only helper.
- Refresh/rendering owner: shipped Command Code 1.5.0 fires `SessionStart`
  only for startup, resume, and clear - not for compaction - so SessionStart
  alone is not a compact boundary. The managed hook therefore renders the
  block on `SessionStart` and on every `PreToolUse` (via `--peers-on-prompt`
  on the managed command), which re-anchors the first time a post-compaction
  turn touches any tool. Residual, documented gap: a post-compaction turn
  that uses no tools is not re-anchored until the next tool call or session
  start; closing it fully needs a compact-source SessionStart upstream.
- Stale clearing: the TTY helper.

### Codex (codex-plugin)

- Store: the shared peers file.
- Tagging: the TTY-only helper.
- Refresh/rendering owner: Codex 0.146 exposes `SessionStart` including a
  `compact` source, so the plugin registers a `SessionStart` hook and the
  bundled script renders the block there - no per-turn repetition. The
  launcher's trusted-runtime discovery accepts, in order, an absolute
  `PARLE_HOOK_RUNTIME` override, the live hook-bridge runtime handles, and
  fixed absolute system Node paths, so peer context renders even when no
  responsive-delivery bridge is armed while a hostile `PATH` still cannot
  substitute the runtime. Windows hooks remain the existing `echo {}`
  no-op: peer re-anchoring is currently not available on Windows Codex and
  is documented rather than simulated.
- Stale clearing: the TTY helper.

### The TTY-only helper

MCP-wrapper hosts have no operator-typed command surface, so mutation ships
as a small CLI beside the bundled server artifact
(`node <bundle-dir>/parle-peers.mjs add|remove|clear|list`). It refuses to
run without a TTY on stdin and requires the confirmation to be typed on the
controlling terminal, which keeps hook processes, pipes, and casual
automation out of the mutation path; see the principle above for what this
does and does not prove. It resolves `PARLE_PROFILES_PATH` canonically
(process environment, then the project `.env`, relative against the cwd) so
it always edits the same store every renderer reads. Reads remain available
to models through the status surface only.

## What models can and cannot do

- Read: `parle_status` (Pi and MCP) includes a `peerContext` section listing
  labels, addresses, roles, and tag ages.
- Write: nothing. There is no model-callable set/remove; peer-authored text
  is never parsed for identity; delivered message content cannot reach the
  store by construction.

## Acceptance mapping

- Retention: host tests drive the verified boundary (Pi `context` event,
  hook script `SessionStart`, `--peers-on-prompt`) and assert the tagged
  alias and role render together after a simulated compaction restart.
- Expired-address non-reuse: the block's retention language plus the absence
  of untagged routes; a random session address delivered by a peer never
  appears in the block.
- Actionable missing context: with an empty store the block renders the
  operator-request guidance instead of nothing.
- Privacy-flat addressing: no roster, no enumeration, no address probing,
  no differentiated errors; everything renders from the local operator file.
- Non-mutation: a delivered message claiming a new identity leaves the store
  byte-identical; there is no code path from message content to the file.

## Out of scope

Own-session alias recovery (#49, shipped), core address validity and alias
ownership, milestone-70 surfaces, roster or discovery of any kind.
