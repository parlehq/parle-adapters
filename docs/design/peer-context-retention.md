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
- **Mutation lives outside model-callable surfaces.** Peer-authored content
  and ordinary tool calls cannot rewrite retained identity, structurally: the
  store has no parser and the writing surfaces prove operator provenance.
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
  Commands run with `ExtensionCommandContext`, which only exists for
  operator-typed input, so provenance is the host's own guarantee.
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
- Refresh/rendering owner: the adapter's already-managed `SessionStart`
  hook invocation of the bundled hook script, which now appends the peers
  block to its `additionalContext` output alongside queued delivery.
- Stale clearing: the TTY helper.

### Codex (codex-plugin)

- Store: the shared peers file.
- Tagging: the TTY-only helper.
- Refresh/rendering owner: Codex exposes no session-start or compaction
  hook, so its deterministic boundary is per-turn: the bundled hook script
  invoked from the existing `UserPromptSubmit` hook renders the block when
  passed `--peers-on-prompt`. The block is idempotent and bounded, so
  per-turn repetition is safe within the configured context budget.
- Stale clearing: the TTY helper.

### The TTY-only helper

MCP-wrapper hosts have no operator-typed command surface with provable
provenance, so mutation ships as a small CLI beside the bundled server
artifact (`parle-peers add|remove|clear|list`). It refuses to run without a
TTY on stdin, which keeps hook processes, piped automation, and
model-initiated shells out of the mutation path. Reads remain available to
models through the status surface only.

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
