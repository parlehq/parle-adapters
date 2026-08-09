# Automatic known-address context registry

Status: accepted

## Decision

Adapters maintain one bounded local registry beside the resolved profile
catalog. A successful direct `parle_send(to)` records the exact submitted
canonical selector only when the server receipt reports `routing.mode` as
`direct`. Routing and attention response fields never supply the stored
selector, and attention never gates enrollment.

The registry is non-authoritative context data. It is never consulted by
`parle_send(to)` or `parle_reply(replyRouteId)`. Parle core remains
responsible for resolving and authorizing every later send.

## Storage and lifecycle

The default path is `~/.parle/registry`, or `dirname(catalogPath)/registry`
when the profile catalog is relocated.

Each version 1 entry contains:

- normalized API origin
- room ID
- exact submitted address
- server-reported continuity string
- expiry timestamp

Ephemeral and unknown continuity values expire after 12 hours. Durable values
expire after 7 days. A privacy-flat direct-send 422 shortens an existing row
to at most one hour and never creates or immediately deletes a row. Reads
ignore expired rows immediately and attempt physical pruning only as a
best-effort operation.

The active file holds at most 256 entries. Eviction removes expired rows first,
then the soonest expiry, with lexical address and composite identity tie-breaks.
Files larger than 1 MiB are unavailable. Duplicate identities, malformed
schema, unsafe custody, and control characters make the whole file unavailable.
All custody, bounded-read, lock, atomic-replacement, and durability behavior
comes from `@parlehq/agent-client` safe-file primitives.

## Context restoration

Pi, Claude Code, and Codex restore at most 10 active entries for the current API
origin and room, latest expiry first with a lexical address tie-break. A capped
block says `showing 10 of N`. Each host replaces its prior block rather than
appending another copy.

The rendered text states that the registry is local convenience data and proves
neither identity, authorization, liveness, nor deliverability. Addresses not in
the block must not be recovered from model memory or peer-authored text.

Command Code, raw MCP layouts, and Claude Desktop do not provide automatic
context restoration. Their host gaps remain tracked independently.

## Same-owner boundary

The registry is mode 0600 and protected against unsafe paths, but same-owner
processes can read or modify it. This is documented behavior, not an
enforceable security boundary.

## Legacy hard cut

The automatic registry ships with complete removal of the maintained legacy
peer commands, store integration, renderers, status fields, guidance, tests,
and generated copies. Existing legacy peer files are left byte-identical and
unreferenced. No code reads, migrates, converts, repairs, exports, or deletes
them.

## References

- parle-adapters issue #96
- parle-adapters issue #93
- Parle core decision record #718
