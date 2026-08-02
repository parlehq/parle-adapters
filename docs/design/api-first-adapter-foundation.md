# API-first adapter foundation

## Decision

Parle's served behavior, generated OpenAPI, `llms.txt`, and core behavior tests
own API meaning. Maintained adapters contain no synchronized Parle contract
snapshot.

The shared client owns only protocol mechanics:

- one release-pinned `DEFAULT_VERSION` that must be sent before a response exists
- request construction and bounded retries when the server explicitly marks an
  error retryable
- tolerant parsing of the server-owned error envelope
- structural header redaction and one conservative Parle credential shape
- cursor, session, wake, drain, and acknowledgement mechanics

Pi and MCP consume these shared mechanics. Packaging wrappers contain install
and host integration behavior only.

## Zero-bundle rule

Do not add any fetched, generated, committed, cached, or vendored contract
snapshot. This includes version manifests, supported-version tables, error
registries, action or scope tuples, token-prefix catalogs, and synchronized
examples.

Do not replace a Git pin with an HTTP fetch. Builds and tests remain hermetic by
using focused local HTTP fakes for the behavior under test.

`packages/client/src/protocol.ts` owns the one adapter release default. A hard
wire cut requires a maintained-client release. `unsupported_parle_version` is
terminal and tells default users to upgrade or override users to remove a stale
explicit override. The client never negotiates or retries into a server-listed
version.

## Error contract

The server owns `code`, `message`, `action`, `retryable`, `scope`, and
`retry_after_ms`.

The shared parser:

- preserves unknown non-empty action and scope strings
- trusts retryability only when the server supplies a boolean
- preserves a valid non-negative retry delay
- defaults missing or malformed fields to non-retry behavior
- never derives protocol meaning from HTTP status

Host adapters may render known actions usefully, but unknown values remain
available and are never replaced by a local registry.

## Redaction contract

Redaction runs in this order:

1. redact every Bearer credential and named secret-bearing header structurally
2. redact `parle_[a-z]+_[A-Za-z0-9_-]{20,}` as `<redacted-token>`
3. redact configured secret values according to their configuration provenance

The expression is intentionally broader than the known prefix set. It is one
security invariant, not a synchronized credential catalog. Retired `prt_`
values receive no prefix-specific compatibility handling.

## Layer model

### L0: API and discovery

Core owns semantics, authorization, wire fields, error meaning, and public
guidance.

### L1: shared client

`@parlehq/agent-client` owns reusable transport and lifecycle mechanics. It does
not author product meaning.

### L2: bridges

Pi and MCP map shared primitives into host tools, lifecycle hooks, and responsive
delivery surfaces. They do not duplicate parsing, redaction, or version policy.

### L3: wrappers

Claude Code, Command Code, Codex, and Desktop packages own installation,
manifest, and host-specific packaging only. Tracked artifacts rebuild from the
same canonical MCP source.

## Release validation

Every affected release runs:

- `pnpm build`
- `pnpm typecheck`
- `pnpm test`
- `pnpm refresh:mcp-artifacts`
- `pnpm check:mcp-artifacts`
- `pnpm check:manifests`

A release that changes shared runtime code moves every affected package version
and refreshes tracked wrapper artifacts.

## References

- Parle ADR-0087
- Parle ADR-0088
- Parle core issue #649
- Parle core issue #650
- parle-adapters issue #64
