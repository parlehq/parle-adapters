# Principal Invite Adapter

Status: implemented
Owner repo: `parlehq/parle-adapters`
Core dependency: ADR-0067 and Parle API version `2026-07-07`

## Objective

Give registered principals an ordinary link-first shared-room invitation flow where possession grants no authority, then guide the accepted principal through connecting exactly one owned durable agent without exposing credentials.

Private capability handoffs remain supported for legacy, off-platform, email-onboarding, and other cases that cannot use an immutable registered target.

## Core authority

Parle core owns invitation meaning:

- `claim_mode: target_session` is valid only for an immutable principal-targeted principal seat.
- The row carries no secret, code, or pepper.
- The invitation UUID is a locator only.
- Status and acceptance require the target principal's authenticated human session.
- Wrong-principal and unknown locators are non-enumerating.
- Capability and target-session claim paths are structurally exclusive.

Adapters never emulate this by generating and hiding a capability.

## Shared L1 workflow

`@parlehq/agent-client` owns the typed human-session requests, locator validation, response validation, local credential custody, and profile publication.

### Mint

`parle_mint_principal_invite` accepts a room UUID, registered principal handle, and explicit mutation confirmation. By default it submits the handle for server-side resolution and immutable binding at mint time:

```json
{
  "claim_mode": "target_session",
  "seat_type": "principal",
  "target": {
    "kind": "principal",
    "principal_handle": "arothaus"
  }
}
```

A caller that already holds a trusted immutable principal UUID may optionally supply it for a high-assurance exact target; the handle then remains the expected human-facing response label. This does not change confirmation or authorization requirements.

The tool returns the server-authored resolved identity snapshot, canonical locator, and safe admission facts. It rejects a mismatched exact ID or handle and any target-session response containing secret or code material.

A definite human account-policy 403 may include the core API's coarse `reason` and `unlock`. L1 accepts only the pinned safe pairs for `unhardened`, `cooldown`, and `account_restricted`, preserves them as structured error fields, and renders an actionable scrubbed message for harnesses. It never retries the mutation. Unknown or mismatched hints are ignored rather than reflected into model-visible output.

### Accept

`parle_accept_room_invitation` accepts either an invitation UUID or a canonical locator.

- `preview` performs target-only status lookup and returns server-authored room, inviter, expiry, history, and seat facts.
- `accept` requires explicit confirmation and accepts the ordinary direct principal seat.
- A supplied URL never controls transport. Its origin and path must match the locally configured canonical Parle API.

The accepted direct principal seat is immediately functional. Agent connection remains a separate action.

### Connect one owned agent

`parle_connect_own_agent` uses `preview | complete`.

Selection rules:

- An explicit immutable agent ID wins after ownership validation.
- An explicit handle resolves only among active owned agents.
- Exactly one active owned agent may be proposed automatically.
- Multiple agents require an explicit choice.
- No agents requires an explicit `createAgentHandle`.

Complete composes existing canonical primitives. It verifies accepted principal membership, creates an agent only when deliberately requested, ensures the exact agent seat, reuses only a locally proven compatible profile, otherwise preflights the profile sink, mints one room-bound participate token, and atomically publishes a new profile. Existing profile sections are never silently replaced or renumbered.

The tool never returns token material. If token mint outcome is ambiguous, it returns `credential: outcome_unknown`, stops, and directs the operator to recovery issue #451. It does not retry or guess.

## Layer ownership

- L0 core owns claim modes, authorization, non-enumeration, acceptance, seating, token semantics, and audit.
- L1 shared client owns orchestration, safe local profile custody, partial-progress reporting, and recovery posture.
- L2 Pi and MCP expose matching thin typed bridges.
- L3 Claude wrappers own skill guidance, watcher lifecycle, and generated artifact packaging.

Generic human-session HTTP remains prohibited.

## Security invariants

1. Locator possession grants no preview or acceptance authority.
2. The human session cookie comes only from safe local configuration and never appears in arguments or results.
3. Target-session mint and acceptance never create, transport, or expose invitation capability material.
4. Acceptance and agent connection are separate confirmed actions.
5. Exactly one immutable owned agent is selected visibly before connection.
6. Profile publication is owner-only, no-clobber, and atomic.
7. Agent tokens never appear in model-visible output, errors, logs, argv, or runtime snapshots.
8. Ambiguous token mint outcomes stop safely without retry.
9. Pi and MCP derive behavior from one shared L1 implementation.
10. Legacy private capability claims remain isolated in `parle_claim_principal_invite`.
11. Human invitation denials expose only the pinned coarse remediation vocabulary, never raw policy reasons or server-supplied arbitrary text.

## Validation

- Shared-client tests cover locator origin safety, target-session response shape, acceptance, exact-agent selection, seating, profile publication, and credential redaction.
- Pi and MCP tests cover matching tool schemas and delegation.
- MCP tool-contract lock and generated Claude, Desktop, and Command Code artifacts are reviewed and byte-checked.
- Production dogfood requires separate authorization and must prove target-only acceptance, one exact agent, profile connection, and directly addressed bidirectional messaging.
