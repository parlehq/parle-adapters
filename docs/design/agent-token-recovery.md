# Agent Token Recovery

## Status

Implementation-ready design refresh against:

- `parlehq/parle` `786ae829d765517ffe1f55a66032f90c19687c71`
- `parlehq/parle-adapters` `214b3daca0e1bc279d82eddc7bb2ca77e24e3b14`
- Parle wire version `2026-07-07`
- adapter `conformance.pin.json` declares that exact core ref, and its vendored artifacts are byte-identical to that core export

The immediate recovery slice is blocked by one narrow L0 consistency fix described below. It is no longer blocked on speculative mint-recovery contracts. Mint crash recovery remains canonical Forgejo issue `parlehq/parle#451` and is explicitly outside this slice.

Engineer briefing:

https://share.galexc.io/30d/parle-token-recovery-20260719-1452.html

The briefing predates this refresh. Its architecture remains useful, but references to a quota of three and to all L0 items as blockers are superseded by this document.

## Problem

Parle permits an unhardened principal to hold up to five live bound participate tokens. When the fifth slot is occupied, another mint returns canonical HTTP 403 `token_quota_exceeded`.

Parle core already exposes the human-session recovery endpoints:

- `GET /v/agent-tokens`
- `POST /v/agent-tokens/{agentTokenID}/revoke`

The adapters do not expose those operations as typed tools. Local profiles are incomplete by construction because they contain only credentials persisted by a particular adapter installation. A live server token can therefore occupy quota without appearing in any local profile.

Generic `parle_request` intentionally cannot use human-session authority. Without typed inventory and revoke operations, a quota failure becomes a browser, raw-cookie, or credential-scavenging problem.

## Current baseline

### Parle core facts

The current pinned core contract already provides:

- a principal-wide token inventory at `GET /v/agent-tokens`
- metadata for room-bound and invite-bound tokens
- token scopes, creation, expiry, last-use, and revocation timestamps
- oldest-first ordering pinned by the `account-actions.json` response description and implemented by `ORDER BY created_at, agent_token_id`
- canonical revoke at `POST /v/agent-tokens/{agentTokenID}/revoke`
- 204 on successful revoke
- uniform 404 for missing, foreign, or already-revoked tokens
- a five-token unhardened bound-participate quota
- account actions and errors in versioned conformance artifacts

One current core inconsistency must be resolved before adapter release:

- the mint handler, account OpenAPI, and `account-actions.json` emit or document HTTP 403 `token_quota_exceeded`
- `internal/roomhttp/error_contract.go` and `error-registry.json` classify the same code as HTTP 409
- `writeErr` therefore emits HTTP 403 while deriving action and scope from a registry entry pinned to 409

The implementation decision is HTTP 403 because quota denial is an account-policy authorization denial and because the handler and account contract already expose 403. Core must update the error registry source, regenerate conformance and goldens, and test that handler status and registry status agree. The adapters then refresh the pin. No adapter may normalize the conflict locally.

The inventory currently returns one unpaginated `tokens` array containing active and revoked history. Adapters must preserve that contract exactly. They must not invent status filters, cursors, local pagination, stale-token labels, or completeness claims beyond the server response.

### Adapter facts

`@parlehq/agent-client` now contains a partial `ParleAccountClient` in `packages/client/src/account.ts`. It owns invitation and guided connection workflows used by Pi and MCP.

Account transport is still split:

- Pi retains `humanJson`, email login, room creation, own-agent seat admission, and token minting.
- `ParleAccountClient` owns newer invitation and connection workflows.
- `connectOwnAgent` performs token inventory and mint operations directly.
- its cleanup path attempts `DELETE /v/agents/{agentID}/tokens/{agentTokenID}`, which is not the canonical revoke endpoint
- its token mint has no server idempotency contract and reports outcome uncertainty through Forgejo issue `parlehq/parle#451`
- exported generic `RequestOptions` still advertises unimplemented `human_session` auth

The implementation must consolidate these paths rather than adding another transport.

## Scope split

### This slice: operator-selected recovery

This design delivers:

1. establish or refresh a protected human session
2. list the server-authoritative principal token inventory
3. let the operator select an exact token UUID
4. explicitly revoke that token
5. continue existing profile and mint workflows without browser or raw-cookie handling

### Follow-up: crash-recoverable mint

Forgejo issue `parlehq/parle#451` owns:

- mint idempotency
- committed-response replay or consumed-key evidence
- deterministic post-commit response-loss recovery
- exact-token status if retained revocation proof is required
- durable mint journals and crash-boundary reconciliation

Those requirements do not block read-only inventory or an explicitly confirmed revoke. This slice must not claim that mint is crash-recoverable, infer the outcome of a lost mint response, or add adapter-authored idempotency semantics.

## Invariants

1. Parle HTTP and pinned conformance remain authoritative.
2. Local profiles are never presented as server inventory.
3. Adapters never classify a token as stale or recommend a revoke candidate.
4. Revoke requires an exact server token UUID and explicit confirmation.
5. Revoke never edits profiles, ends sessions, switches runtime profiles, or retries automatically.
6. Generic request paths never receive human-session authority.
7. Pi and MCP use one shared account client and return the same structured results.
8. No adapter exposes the human cookie in parameters, results, logs, argv, child environment, or runtime snapshots.
9. No account-plane `principal_id` disclosure is introduced. ADR-0029, ADR-0030, returning login, and `GET /v/auth/whoami` keep that internal referent out of the account bootstrap contract.
10. Invite-bound and scoped tokens are first-class inventory rows. Recovery is not limited to the older room-only token shape.

## Tool surface

### `parle_list_agent_tokens`

Inputs: none in this wire version.

The tool calls fixed `GET /v/agent-tokens` through `ParleAccountClient` and returns:

```json
{
  "tokens": [
    {
      "agent_token_id": "<uuid>",
      "agent_id": "<uuid>",
      "display_name": "<server value>",
      "room_id": "<uuid or null>",
      "invite_id": "<uuid or null>",
      "scopes": ["participate"],
      "created_at": "<timestamp>",
      "expires_at": null,
      "last_used_at": "<timestamp or null>",
      "revoked_at": null
    }
  ]
}
```

The response is the validated server object after shared redaction. The tool does not:

- filter active rows locally
- hide revoked history
- label tokens stale
- correlate rows with profiles
- rank candidates
- reinterpret `last_used_at`
- claim pagination support

The client keeps a bounded response read. If the canonical response exceeds that bound, it fails with a namespaced local contract-limit error and points to core pagination as the required fix. It never silently truncates.

### `parle_revoke_agent_token`

Inputs:

- `agentTokenId`: required non-zero UUID
- `confirmMutation`: required `true`
- `reason`: required non-empty local rationale

The tool calls fixed `POST /v/agent-tokens/{agentTokenID}/revoke` with redirects and automatic retries disabled.

On canonical 204 it returns:

```json
{
  "agent_token_id": "<requested UUID>",
  "http_status": 204
}
```

The rationale is validated locally and is not transmitted, persisted, or logged.

A transport failure after dispatch returns a namespaced mutation-outcome-unknown error containing only the operation and requested non-secret token ID. It does not say whether revocation occurred and does not suggest blind retry. The operator may list inventory again. Because current inventory retains revoked rows, a row with the exact token ID and non-null `revoked_at` is useful evidence, but this slice does not promote it into a new exact-status protocol.

### `parle_login`

Pi and MCP expose the same action contract:

- `start`: request a returning-login email code
- `complete`: exchange the code and atomically persist only the protected human session
- `mint-from-session`: select an existing room and agent, mint a token, and persist a profile

`complete` must never continue into minting, even when room and agent selection is unambiguous. This corrects current Pi behavior.

`mint-from-session` requires `confirmMutation: true` and a non-empty `reason`. It never retries automatically. Until `parlehq/parle#451` lands, a lost or malformed post-dispatch mint response remains outcome-unknown and the adapter must say so without attempting compensation.

## Shared account client

Extend the existing `ParleAccountClient`. Do not add a second account module.

### Fixed methods

The shared client owns fixed methods for:

- start returning email login
- complete returning email login
- probe the current human session with `GET /v/auth/whoami`
- list owned rooms and agents
- create an owned room
- add an owned agent seat
- mint a bound agent token
- list principal agent tokens
- revoke an exact principal agent token
- existing principal invitation and guided connection workflows

A private request primitive backs those methods. No public method accepts a cookie, arbitrary path, arbitrary method, arbitrary headers, or redirect policy.

### Atomic Pi migration

In the same release:

- move `parle_login`, room creation, and own-agent seat admission from Pi to L1
- delete Pi `humanJson` and direct account fetches
- route `connectOwnAgent` inventory and mint calls through the same fixed L1 methods
- remove the noncanonical `DELETE /v/agents/{agentID}/tokens/{agentTokenID}` cleanup request
- remove automatic cleanup revoke after a successful mint followed by local persistence failure
- return the non-secret minted token ID and an outcome-safe recovery message when persistence cannot be completed
- remove unimplemented `human_session` from generic `RequestOptions`

The recovery tools do not ship while Pi retains a second account transport.

## Human-session confinement

The session store becomes a versioned record beside the resolved profile catalog:

```json
{
  "version": 1,
  "origin": "https://api.parle.sh",
  "cookie": "__Host-parle_session=parle_sess_<43 base64url characters>"
}
```

It does not contain `principal_id`.

Requirements:

- login completion records the exact normalized origin that returned the cookie
- authenticated account methods read the cookie only from the protected session record, not process environment or project `.env`
- login start and completion resolve origin and storage location without requiring an existing cookie
- account calls require exact equality between stored and configured origins
- fixed relative paths resolve only against that origin
- HTTPS is mandatory except the existing explicit localhost test override
- fetch uses manual redirect handling and rejects every 3xx before forwarding the cookie
- response final origin, when exposed, must match
- the record is bounded before parsing and rejects unknown or duplicate keys
- cookie shape follows the pinned `human_session_cookie` token class
- parent directory is current-user owned mode 0700
- session and profile targets are regular files, never symlinks
- writes use random exclusive mode-0600 temporaries, file sync, atomic replacement, and parent-directory sync
- Windows human-session tools remain unsupported until a reviewed credential-store design exists

A legacy one-line session file is accepted for read-only token inventory only when the configured origin is exactly `https://api.parle.sh`. Login completion upgrades it. Revoke, mint, profile creation, and other account mutations require the versioned record.

Each top-level account invocation reads one immutable session lease. A concurrent session-file replacement affects only the next invocation.

## Response and error handling

### Canonical server responses

L1 validates the pinned success and error shapes for each fixed operation. Valid canonical errors remain nested under `error` and preserve server fields after redaction.

Malformed or non-JSON server errors become:

```json
{
  "adapter_error": {
    "code": "parle_adapter_server_contract_mismatch",
    "operation": "<fixed operation>",
    "http_status": 500
  }
}
```

Malformed success responses become `parle_adapter_success_contract_mismatch`. Raw bodies and filesystem paths are never returned.

### Revoke transport uncertainty

A failure after revoke dispatch begins and before a complete HTTP response becomes:

```json
{
  "adapter_error": {
    "code": "parle_adapter_mutation_outcome_unknown",
    "operation": "revoke_own_agent_token",
    "outcome": "unknown",
    "request_may_have_reached_server": true,
    "retry_attempted": false,
    "agent_token_id": "<requested UUID>"
  }
}
```

Pi and MCP serialize the same object from L1.

## Bridge behavior

### Pi

- retain the existing tool name `parle_login`
- add list and revoke
- route every account action through L1
- keep adapter-owned rendering and Pi registration only

### MCP

- add `parle_login`, list, and revoke over L1
- use the same schemas and structured errors as Pi
- mark list read-only
- mark login conservatively because one action mints
- mark revoke destructive and non-idempotent

### Wrappers

Claude Code, Command Code, and Claude Desktop receive the tools through the rebuilt MCP artifact. They add no credential or protocol logic.

## Implementation sequence

### Slice 0: resolve the core quota contract

Core files:

- `internal/roomhttp/error_contract.go`
- `internal/roomhttp/account_openapi.go`
- the focused room HTTP error-contract test file
- generated conformance and OpenAPI goldens

Work:

1. classify `token_quota_exceeded` as HTTP 403 in the error registry
2. add a test that every emitted canonical error status matches its registry status
3. regenerate `error-registry.json`, the manifest, and affected goldens
4. refresh the adapter conformance pin

### Slice 1: shared transport and store

Files owned primarily by this slice:

- `packages/client/src/account.ts`
- `packages/client/src/index.ts`
- `packages/client/test/account.test.mjs`
- `packages/client/test/index.test.mjs`

Work:

1. refactor the existing account request primitive for fixed methods, manual redirects, bounded reads, and canonical error serialization
2. add the versioned exact-origin session record and legacy read-only handling
3. add fixed login, whoami, inventory, room, agent-seat, mint, list-token, and revoke methods
4. remove generic `human_session`
5. migrate `connectOwnAgent` to the fixed methods and remove noncanonical cleanup

### Slice 2: Pi parity

Files:

- `packages/pi-extension/src/index.ts`
- `packages/pi-extension/test/index.test.mjs`

Work:

1. replace Pi-local account transport with L1 calls
2. split login completion from mint
3. add list and revoke tools
4. delete `humanJson` and direct account fetches

### Slice 3: MCP parity and locks

Files:

- `packages/mcp-server/src/index.ts`
- `packages/mcp-server/test/index.test.mjs`
- `packages/mcp-server/tool-contract.lock.json`

Work:

1. register login, list, and revoke
2. lock full schemas and annotations
3. assert Pi and MCP structured-result parity

### Slice 4: packages and wrappers

Work:

1. version `@parlehq/agent-client`, `@parlehq/pi-extension`, and `@parlehq/mcp-server`
2. add changelog entries, including login completion behavior
3. rebuild Claude Code, Command Code, and Claude Desktop copied artifacts
4. version wrappers whose installable artifact changed

## Validation

### Core and conformance

- quota denial emits HTTP 403 and the registry pins HTTP 403
- handler status, OpenAPI, account actions, error registry, manifest, and goldens agree
- adapter conformance pin adopts the corrected core ref

### Shared client

- current conformance pin matches the corrected Parle core
- exact-origin mismatch fails before credential dispatch
- redirects fail without forwarding the cookie
- legacy session supports list only at the production origin
- mutations require the versioned session record
- malformed success and error bodies map to shared namespaced errors
- response caps fail without truncation
- inventory preserves room, invite, scope, timestamp, and revocation fields
- revoke uses canonical POST, accepts only 204, and never retries
- revoke transport uncertainty returns the exact non-secret token ID
- `connectOwnAgent` contains no direct account fetch or noncanonical DELETE cleanup
- generic `RequestOptions` contains no `human_session`

### Pi and MCP

- all Pi account requests route through L1
- Pi-local `humanJson` is absent
- `whoami` returns the validated authenticated and assurance shape on 200 and preserves the canonical credential rejection on 401
- login complete never mints
- mint and revoke require explicit confirmation and rationale
- list is available before an agent data-plane connection
- Pi and MCP return structurally equal list, revoke, canonical error, and local error objects
- schemas and annotations match the strengthened MCP lock

### Repository gates

- `pnpm typecheck`
- `pnpm test`
- package builds and package validation
- wrapper artifact byte checks
- secret scan
- repository-wide search for direct human-session account fetches
- repository-wide search for `PARLE_SESSION_COOKIE` use outside redacted status and migration guidance
- repository-wide search for the noncanonical token DELETE path

### Manual smoke

Using a disposable principal:

1. complete login and verify only the session record changes
2. mint or prepare five bound participate tokens
3. verify the sixth mint returns 403 `token_quota_exceeded`
4. list inventory through Pi and MCP and compare token IDs
5. revoke one explicitly selected active token
6. list again and verify the same row has non-null `revoked_at`
7. mint one replacement through the existing confirmed path
8. verify malformed selection never triggers revoke
9. clean up every token and temporary profile

Do not run the smoke against a shared personal principal.

## Deferred follow-ups

The following are useful but not blockers for this slice:

- server pagination and status filters for large token history
- exact-token status and account-lifetime revocation tombstones
- mint idempotency and replay semantics
- principal-safe journal reconciliation without exposing internal `principal_id`
- automatic stale-lock recovery
- cross-process profile-catalog write serialization, coordinated with the later journal design
- Windows human-session credential storage

Reopen pagination before the inventory response can approach the adapter response cap. Reopen mint journals only after core issue `parlehq/parle#451` defines authoritative replay and outcome evidence.

## Acceptance criteria

- Pi and local stdio MCP can log in, list the canonical principal token inventory, and revoke an explicitly selected token without browser or raw-cookie handling.
- The five-token quota and canonical 403 status match corrected Parle core and conformance.
- Inventory preserves room-bound and invite-bound token metadata and scopes.
- One `ParleAccountClient` owns every human-session request.
- Pi contains no separate account transport.
- Generic requests cannot obtain human-session authority.
- Login completion persists only the human session.
- Revoke uses the canonical POST endpoint, never mutates profiles, and never retries automatically.
- `connectOwnAgent` no longer uses a noncanonical cleanup endpoint or automatic compensation revoke.
- The protected session is confined to its exact origin and is not forwarded across redirects.
- No public `principal_id` contract is introduced.
- Mint outcome uncertainty remains honest and is tracked separately in canonical Forgejo issue `parlehq/parle#451`.
- Conformance, versions, changelogs, builds, tests, contract locks, wrapper artifacts, and secret scans pass.
