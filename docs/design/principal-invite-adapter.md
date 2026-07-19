# Principal Invite Adapter

Status: design draft
Owner repo: `parlehq/parle-adapters`
Core dependency: deployed Parle API version `2026-07-07`

## Objective

Let an authenticated room owner invite a known principal into a shared room from both Pi and Claude without exposing a reusable human session cookie or placing the one-time invite capability in model-visible tool output.

The first production use is Gilman inviting principal handle `kljensen` into shared room `galexc-kyleops`.

## Live facts

- Parle core already supports human-session `POST /v/rooms/{roomID}/invites`.
- A principal-seat request uses `seat_type: principal` and `target.kind: principal` with a discovery handle. The server resolves the handle to an immutable principal ID when it mints the invite.
- Kyle's immutable principal ID is `019f3894-bb87-726a-8deb-17d367054426`.
- The current `galexc-kyleops` room token can participate but reports `mint_invite: missing_scope`.
- Generic human-session requests are intentionally unsupported in adapters.
- Pi already has typed human-session room creation and own-agent seating. Claude's MCP server does not expose those account-plane operations.
- The server returns the invite secret and code once. Both values together are the claim capability and must be handed to Kyle out of band.
- A logged-in principal previews and completes a claim through `POST /v/claim/preview` and `POST /v/claim/complete`.

## API-first triage

1. API meaning is already complete and canonical.
2. No database or migration change is needed.
3. The missing behavior is safe local credential custody and harness UX.
4. Shared request and file mechanics belong in L1.
5. Pi and MCP should expose matching typed tools at L2.
6. Claude plugin prose should explain the human handoff at L3 without inventing protocol semantics.

Verdict: adapter-only work.

## Proposed workflow

### Owner mint

Both Pi and MCP expose `parle_mint_principal_invite` with:

- `roomId`
- `principalId`, the immutable authorization target
- `principalHandle`, a human-facing confirmation label
- `confirmMutation: true`
- required `reason`

V1 intentionally omits offered rights, alternate seat types, direct IDs, custom expiry, email targets, unbound targets, and exact-agent targets. The tool always submits an ordinary principal-seat invite:

```json
{
  "seat_type": "principal",
  "target": {
    "kind": "principal",
    "principal_id": "019f3894-bb87-726a-8deb-17d367054426"
  }
}
```

The tool reads the human session cookie only from resolved local configuration. It never accepts or returns that cookie.

On success, the shared client atomically writes the one-time claim bundle beneath the resolved Parle state directory:

```text
~/.parle/invites/<invite-id>.json
```

The directory is mode `0700`. The file is a regular, owner-owned, non-symlink file with mode `0600`. The file contains the server-returned invite secret and code plus non-secret version, room, invite, seat, target, and expiry facts needed for claim and audit. It does not select an API base. The recipient always uses locally resolved safe configuration, so an imported bundle cannot redirect its capability to another host.

The tool result returns only non-secret facts and the local handoff path. It must not return the secret, code, cookie, authorization header, or raw response.

Gilman transfers the bundle to Kyle through a private out-of-band channel. Parle itself does not deliver the invitation.

### Recipient preview and claim

Both Pi and MCP expose `parle_claim_principal_invite` with:

- `action: preview | complete`
- `handoffPath`
- `confirmMutation: true` and required `reason` for complete
- optional `deleteHandoffOnSuccess`, defaulting to true

For preview, the shared client accepts only a regular, owner-owned, non-symlink file with mode `0600`, parses a bounded schema, and submits its capability to `POST /v/claim/preview` using Kyle's configured human session. The result passes through only the server's non-secret disclosure and admission terms.

For complete, the shared client revalidates the private bundle, submits `POST /v/claim/complete`, and returns only non-secret room, seat, and admission facts. It deletes the local recipient copy only after confirmed success when deletion is enabled. Neither action echoes the capability or raw bundle.

The issuer copy remains until Gilman confirms Kyle joined, then Gilman deletes it. The capability is single-use after a successful claim.

## Layer ownership

### L0: Parle core

No change. Existing endpoints, immutable target resolution, claim disclosure, single-use behavior, expiry, audit, and error semantics remain canonical.

### L1: `@parlehq/agent-client`

Add a small account-plane module that owns:

- safe human-session cookie resolution from the existing state directory
- fixed human-session request construction
- principal handle validation
- private invite bundle creation and validation
- response whitelisting and redaction
- typed mint, preview, and complete methods

The account module may live in the existing shared client package for v1. It must remain separate from room-agent runtime state and must never publish a watcher runtime snapshot.

### L2: Pi and MCP

Register the same two tool names, parameter shapes, descriptions, confirmation gates, and safe results.

Pi should call the shared account module rather than add another local HTTP implementation. Existing Pi-only room creation and own-agent seating can migrate later under their existing refactor issue.

MCP adds the tools directly from the shared module. Claude Code and Claude Desktop receive them through the same bundled MCP artifact.

### L3: Claude plugin

Update the Parle skill and README to describe:

- mint, private handoff, preview, and claim order
- the difference between inviting a principal and seating one's own agent
- why secrets never appear in chat or tool results
- the required out-of-band transfer
- post-claim cleanup and agent seating as a separate action

No Claude-specific protocol or credential logic belongs in the wrapper.

## Security invariants

1. Generic human-session requests remain prohibited.
2. The session cookie comes only from safe local configuration and never appears in parameters, results, files other than the existing session file, logs, or errors.
3. Invite secret and code never appear in model-visible tool output, status, logs, argv, error text, or runtime snapshots.
4. Mint is fixed to one ordinary principal seat targeted by principal handle.
5. The server-resolved immutable principal ID is returned as non-secret evidence and must match the intended principal before handoff.
6. Handoff files are bounded, owner-owned regular files with mode `0600`; symlinks and permissive files fail closed.
7. Handoff content never selects the request host, version, session file, or profile. Locally resolved configuration remains authoritative.
8. Preview is read-only with respect to admission. Complete requires explicit mutation confirmation and reason.
9. Failed mint or claim leaves no partial temporary file. Atomic rename is required.
10. Successful claim consumes the server capability once. Local deletion happens only after server success.
11. Pi and MCP behavior is derived from the same L1 implementation and parity tests.

## Test plan

### Shared client

- principal handle normalization and invalid target rejection
- cookie absent, symlinked, foreign-owned, and permissive-file failures
- exact mint request and no extra terms
- atomic `0700` directory and `0600` handoff file creation
- failure cleanup with no partial file
- output and thrown-error secret scans
- preview and complete request shapes
- claim failure preserves the handoff
- claim success optionally deletes only the recipient handoff
- malformed, oversized, symlinked, and permissive handoff rejection

### Pi

- tool contract and confirmation enforcement
- shared-client delegation
- no secret in formatted result, status, watcher state, or runtime file

### MCP and Claude

- matching tool schemas and annotations
- tool contract lock update
- stdio end-to-end mint fixture with a safe result
- plugin and Desktop bundle synchronization
- wrapper artifact secret scan
- Claude skill workflow assertions

### Production dogfood

1. Gilman mints an ordinary principal invite for `kljensen` in `galexc-kyleops`.
2. Gilman verifies the returned immutable target principal ID.
3. Gilman transfers the private bundle out of band.
4. Kyle previews and claims with his authenticated human session.
5. Room details show Kyle's active direct principal seat.
6. Gilman and Kyle exchange one message each.
7. Kyle optionally seats and connects his own durable agent as a separate workflow.
8. Both parties remove local handoff copies after confirmation.

## Non-goals

- Generic human-session HTTP
- Agent-scoped invite minting
- Elevated offered rights
- Exact-agent, email, or unbound invite UX
- Platform-mediated invite delivery
- Invite listing or recovery
- Command Code-specific watcher or footer work
- Core API or database changes

## Resolved implementation decisions

1. The shared account module lives inside `@parlehq/agent-client` for v1 so Pi and MCP use one L1 implementation without adding another package.
2. The recipient saves the transferred file directly under the resolved private Parle invite directory and passes its absolute path. The tool rejects anything outside that canonical directory, plus symlinks, permissive modes, foreign ownership, oversized files, and filename or embedded invite-ID mismatches.
3. V1 has no issuer delete helper. The mint result returns the path and requires explicit local cleanup after confirmation.
4. The immutable principal UUID is the mint authorization target. The handle is a human-facing label only and cannot redirect admission.

## Acceptance criteria

- Gilman can mint a principal-targeted ordinary-member invite from Pi without exposing human or invite secrets to the model.
- The same tools and safe behavior are available through MCP for Claude Code and Claude Desktop.
- Kyle can preview and claim from a private local handoff file with his own human session.
- No server or migration change is required.
- The real `galexc-kyleops` flow ends with Kyle seated and bidirectional messaging proven.
