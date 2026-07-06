# API-First Adapter Foundation

Status: design draft for adversarial review
Date: 2026-07-06
Owner repo: `parlehq/parle-agent-adapters`
Core counterpart needed: `parlehq/parle` API and discovery doctrine
Related: `adapter-maintenance-strategy.md`, `package-architecture.md`, `claude-adapter-update-plan.md`, `claude-desktop-mcpb-package.md`, `parlehq/parle#41`

## Why this exists

Parle will only scale across the AI harness market if the API is the product boundary and adapters stay thin.

The market is moving too quickly to maintain bespoke behavior for every harness. Claude Code, Claude Desktop, Pi, generic MCP hosts, future Agent SDK apps, IDE agents, local runners, hosted runners, and third-party tools will all change. If each harness gets unique Parle semantics, the repo becomes a maintenance rats nest. If Parle exposes stable HTTP primitives and adapters only map those primitives into each host's install and tool surface, integrations can grow naturally.

The working rule is:

> Fix meaning at the API layer first. Use adapters to make harnesses convenient, not to define what Parle means.

The reverted no-scan masking fix is the template. The adapter could hide confusing moderation internals, but that would only help Parle-maintained wrappers and would require repacking installed artifacts. The better fix is `parlehq/parle#41`: make no-scan send responses unambiguous at the API and discovery layer so every client benefits.

## Layer model

### L0: API and discovery

Owner: `parlehq/parle`

Job: own meaning.

Examples:

- HTTP endpoints
- OpenAPI schema
- `llms.txt`
- `ai.parle.sh` guidance
- Parle-Version lifecycle
- event and error semantics
- delivery, moderation, direct addressing, wake, drain, ack, and ADR-0036 framing semantics

Drift to prevent: ambiguity that forces clients to interpret wire state.

Incident: no-scan private rooms returned a moderation envelope that looked held and pending even though `scan: skipped` plus empty `steps` meant accepted by room config. That made clients narrate stale internal state.

### L1: shared client

Owner: `@parlehq/agent-client`

Job: own protocol mechanics, not product meaning.

Examples:

- config resolution
- safe host policy
- request construction
- auth/session lifecycle
- cursor helpers
- redaction helpers
- idempotency helpers
- wake/drain/ack helpers
- exact ADR-0036 compaction helpers

Drift to prevent: reimplementation deltas across adapters.

Incidents:

- duplicated redaction and delivery-summary logic between Pi and client
- stale constants such as mismatched message caps
- invented defaults such as a separate wake host
- invented request fields such as `payload.turn`

### L2: bridges

Owners: `@parlehq/mcp-server`, `@parlehq/pi-extension`

Job: map shared primitives into host capability.

Examples:

- MCP tool schemas, annotations, and stdio transport
- Pi tool registration
- Pi lifecycle hooks
- Pi watcher orchestration and prompt injection

Drift to prevent: bespoke protocol behavior per host.

Incidents:

- Pi and MCP could have diverged on send delivery status
- `waitSeconds` could become watcher-by-polling in one surface while Pi uses SSE wake correctly

### L3: packaging wrappers

Owners: `packages/claude-plugin`, `packages/claude-desktop-extension`

Job: own install and config UX only. Wrappers may render canonical posture prose, but they do not author protocol posture. Skill text about untrusted content, addressing, anti-polling, and retries must come from L0 or L1 canonical guidance.

Examples:

- Claude Code plugin metadata
- Claude Code skill install and usage prose
- `.mcp.json`
- Claude Desktop MCPB manifest
- user config labels and sensitivity flags
- copied MCP server artifact
- pack, inspect, and secret-scan gates

Drift to prevent: stale artifacts and invented config.

Incidents:

- placeholder env blocks poisoning defaults
- invented `PARLE_DEFAULT_READ_LIMIT`
- misnamed token fields
- wrapper version veneer where `0.1.0` stays constant while bundled behavior changes

## API-first triage rule

Every adapter bug, UX issue, or ambiguous behavior starts with these questions:

1. Can the API response, OpenAPI schema, discovery guidance, or primitive semantics fix this for every client?
2. Can that API-layer fix preserve security boundaries and avoid leaking secrets?
3. Can it preserve ADR-0036 separation between trusted metadata and untrusted peer text?
4. Can it scale to third-party integrations Parle does not control?
5. Can it stay stable enough that integrations adapt naturally without urgent adapter rebuilds?
6. If not, does the fix belong in the shared client, an MCP bridge, a native adapter, or only a package wrapper?

The expected answer should usually be L0 or L1. L2 and L3 fixes need a host capability or packaging reason. Record the six answers in the originating issue so API-first triage is auditable.

## Interpretation ledger

Any L1 or higher code that translates wire state into agent-actionable meaning is interpretation debt.

Interpretation is permitted only when all are true:

- there is no safe immediate API-layer fix
- the code is centralized as low in the stack as possible
- the code has a comment linking the upstream Parle core issue that should obsolete it
- this ledger records the helper, issue, and removal condition

Current ledger:

- Helper: `summarizeSendDelivery` in `@parlehq/agent-client`
  - Marker: `@parle-interpretation parlehq/parle#41`
  - Layer: L1
  - Meaning interpreted: moderation envelope to send delivery status
  - Upstream issue: `parlehq/parle#41`
  - Removal condition: Parle API exposes canonical no-scan and delivery state semantics that clients can present directly, ideally as an explicit delivery state field plus docs.
  - Reason it still exists: current adapters need a temporary shared way to avoid divergent handling until the API makes the state unambiguous.
- Helper: `addressingWarning` and `bodyLooksLikeAddressedText` in `@parlehq/agent-client`
  - Marker: `@parle-interpretation parlehq/parle#42`
  - Layer: L1
  - Meaning interpreted: body text that looks addressed is only inert text unless structured addressing is present.
  - Upstream issue: `parlehq/parle#42`
  - Removal condition: message submit responses include canonical server-authored addressing advisories for inert body mentions.
  - Reason it still exists: current adapters need to warn users before the API can return the same advisory for every client.
- Helper: `compactServerWrappedContent` in `@parlehq/agent-client`
  - Marker: `@parle-interpretation parlehq/parle#44`
  - Layer: L1
  - Meaning interpreted: exact ADR-0036 fence and preamble byte shape.
  - Upstream issue: `parlehq/parle#44`
  - Removal condition: ADR-0036 framing bytes are versioned and documented, and the server offers canonical compact or non-repeated presentation where appropriate.
  - Reason it still exists: clients need safe exact-validation compaction without trusting peer-authored content.
- Helper: retryability inference in `requestJson`
  - Marker: `@parle-interpretation parlehq/parle#45`
  - Layer: L1
  - Meaning interpreted: HTTP status classes imply retryability, currently `429` or `>=500`.
  - Upstream issue: `parlehq/parle#45`
  - Removal condition: Parle API error bodies expose canonical retryability or documented error-code semantics.
  - Reason it still exists: adapters need a consistent retry hint until the API makes retryability explicit.
- Helper: Pi-local `summarizeSendDelivery`
  - Marker: `@parle-interpretation parlehq/parle#41`
  - Layer: L2 legacy copy
  - Meaning interpreted: same as shared-client `summarizeSendDelivery`.
  - Upstream issue: `parlehq/parle#41`
  - Removal condition: Pi refactor onto `@parlehq/agent-client`, then eventual API delivery-state fix.
  - Reason it still exists: Pi refactor is still pending, so the copy is explicitly marked as temporary debt.

Ledger rules:

- No adapter-specific interpretation helper may bypass this table.
- Every interpretation helper carries a marker comment of the form `@parle-interpretation <upstream issue>`.
- A future repo script should cross-check both directions: every tagged function appears in this ledger and every ledger row points at an existing tag.
- Pi-local interpretation should be deleted or reduced to presentation once `@parlehq/agent-client` exposes the shared helper.
- Ledger review is a standing item on every adapter release checklist.
- When an upstream API issue closes, release is blocked until the helper is removed, narrowed, or explicitly re-justified in this ledger.

## Conformance fixtures

Handwritten mock responses in adapter tests are not enough. They encode adapter guesses.

Parle core should own versioned conformance fixtures for each supported `Parle-Version`:

- request and response pairs for session bootstrap
- participant join
- projection reads
- inbound reads
- sends, including idempotency replays
- delivery and moderation envelopes
- no-scan rooms
- direct addressing success and failure
- error bodies with retryability
- SSE wake sequences
- responsive-delivery drain and ack sequences
- ADR-0036 wrapped content examples

Adapter tests should consume those fixtures instead of inventing local wire shapes. This creates one source of truth for N consumers and makes drift visible in both directions.

The adapter repo should pin a fixture version. Bumping that pin is the explicit act of adopting new server behavior.

Core CI should validate that fixtures match live handlers or generated OpenAPI examples. Adapter CI should validate that adapters consume the fixtures without rewriting semantics.

## Canonical guidance strings

Agent-facing guidance is part of the integration contract.

These strings should have one canonical source and byte-parity tests across surfaces where practical:

- anti-watcher-loop wording for `waitSeconds`
- untrusted peer content and ADR-0036 posture
- direct addressing rules
- idempotency retry rule
- no-scan and moderation state guidance after `parlehq/parle#41`
- setup and missing-config diagnostics

Preference order:

1. server-authored guidance where curl users and third-party clients will see it
2. shared client constants for local helper text when the server cannot speak
3. bridge-specific rendering only for host capabilities
4. wrapper prose only for install and config UX

Guidance can iterate faster than wire semantics. `llms.txt` and `ai.parle.sh` may change daily. Wire fields and endpoint semantics should not churn without versioning or compatibility review.

## Hard rules

These should become lint or CI gates where possible.

1. No adapter constructs Parle HTTP protocol behavior directly when the shared client can do it.
2. No protocol constant is defined in a wrapper. Wrappers may reference package names, file paths, and host metadata only.
3. No adapter-only capability is added before filing or considering an API feature request.
4. Interpretation above L0 must live in the shared client and have a ledger entry.
5. MCP tool contract is defined once in `@parlehq/mcp-server`; wrappers launch the byte-checked artifact.
6. Redaction patterns are defined once in the shared client or by core token format docs; adapters must not relax them.
7. Cross-adapter invariants get one canonical fixture or constant, not copy-pasted tests.
8. New adapter admission requires written classification before code.
9. Config plumbing must prove unset means absent or empty, never a literal placeholder.
10. Remote or hosted MCP is not the local stdio server with a different transport. It requires separate multi-tenant design.
11. MCP tool contract changes require an explicit lock-file diff, version decision, and changelog note.

## Adapter admission classes

### Type 1: direct HTTP only

Use when the harness can read docs, OpenAPI, and `llms.txt` and can make HTTP calls.

Maintenance cost: core docs and API only.

Default choice.

### Type 2: MCP host wrapper

Use when the harness supports local MCP and users benefit from tool discovery, permission prompts, or stdio launch configuration.

Maintenance cost: shared MCP server plus a thin package wrapper if the host has a package format.

Examples: generic MCP hosts, Claude Code plugin, Claude Desktop MCPB.

### Type 3: native harness adapter

Use only when the host has capability MCP cannot express:

- lifecycle hooks
- background or push delivery
- prompt injection
- native local tool registry
- host UI or status surfaces
- required package format that cannot launch MCP directly

Maintenance cost: shared client plus host capability glue.

Example: Pi extension.

### Type 4: library consumer

Use when programmatic agents or custom TypeScript harnesses import `@parlehq/agent-client` directly.

Maintenance cost: npm semver, documented public API, deprecation policy, and API-surface stability tests.

This obligation starts when `@parlehq/agent-client` is published, not when internal adapters use it.

### Explicit non-type: remote hosted MCP

The current `@parlehq/mcp-server` is local stdio, process-env credentialed, and single-tenant by construction.

A remote MCP connector would need:

- per-user auth
- per-user credential isolation
- no ambient env secrets
- remote session lifecycle design
- explicit tenant boundaries
- hosted operational runbooks

Treat that as a type-3-grade design, not as a transport flag.

## Anti-pattern catalog

### Helpful Wrapper Drift

A wrapper fixes a protocol issue locally and becomes the place users learn behavior.

Incident: adapter-level no-scan masking would have helped installed Desktop only after repack and reinstall, while third-party HTTP clients would stay confused.

### Invented Configuration

A wrapper adds config the API or shared client does not support.

Incidents: `PARLE_DEFAULT_READ_LIMIT`, invented wake host defaults, misnamed token variables.

### Guessed Protocol Constants

A client invents timing, caps, or lifecycle expectations the API never promised.

Incident: Pi's heartbeat cadence is useful operationally but the API has not yet specified the session lifecycle contract it should derive from.

### Interpretation Smearing

Multiple adapters translate wire state into meaning independently.

Incident: no-scan moderation status risked becoming Pi wording, MCP wording, Desktop wording, and third-party wording.

### Placeholder Poisoning

A package config includes literal placeholders that become runtime values.

Incident: Claude Code `.mcp.json` env placeholder block was removed because unset placeholders can poison defaults.

### Watcher by Polling

A client loops on `waitSeconds` instead of using wake/drain/ack.

Incident: docs needed repeated wording that `waitSeconds` is a bounded one-shot wait, not a watcher loop.

### Guidance Forking

Skill prose, tool descriptions, docs, and API guidance drift.

Incident: anti-watcher and untrusted-content guidance had to be linted in multiple places.

### Artifact Staleness

A wrapper ships an old copied MCP server artifact.

Mitigation already present: byte-check gates for Claude Code plugin and Desktop MCPB.

### Version Veneer

A wrapper version stays constant while bundled behavior changes.

Mitigation needed: build identifier surfaced through `parle_status`, or wrapper version bump on every artifact refresh.

## Release and compatibility contracts

### API

Contract:

- `Parle-Version` negotiation
- clear deprecation policy
- N-1 compatibility tests once multiple versions exist
- OpenAPI and discovery docs updated with semantic changes
- conformance fixtures published for adapters and third parties

Breaking wire semantics should be rare and explicit.

### Shared client npm package

Contract starts at first npm publish:

- semver
- documented stable exports
- API-surface tests
- deprecation discipline
- no harness imports
- clear difference between stable exports and internal helpers

### MCP bridge

The MCP tool contract is an API for models, users, and permission systems.

Tool renames, argument shape changes, and response shape changes can break saved prompts and allowlists. Treat tool renames as major compatibility events regardless of wrapper version.

Add a checked-in tool-contract lock file with tool names, argument schema hashes, and annotation flags. MCP server tests should regenerate and diff it. CI should fail when the lock changes without an explicit version decision and changelog line.

### Native adapters

Contract:

- preserve host-specific behavior users rely on
- do not fork protocol semantics
- use shared fixtures for protocol behavior
- validate host lifecycle behavior separately

### Packaging wrappers

Contract:

- install and config UX
- artifact provenance
- byte-identical artifact checks
- no independent protocol promises

## Underspecified core contracts

These belong primarily in `parlehq/parle`:

1. Canonical delivery and moderation state enum, including no-scan semantics.
2. Session lifecycle contract, including expiry, heartbeat expectation, and normality of rebootstrap.
3. Wake, drain, and ack normative spec, including SSE event names, ack idempotency, baseline semantics, and held backlog meaning.
4. Token format registry for redactors and secret scanners.
5. Error taxonomy with per-code retryability.
6. ADR-0036 fence and preamble byte format as a versioned spec.
7. `Parle-Version` lifecycle policy.
8. Canonical guidance strings for agent-facing integration behavior.
9. Conformance fixture generation and validation.

The adapter repo should cross-reference these, not own them.

## Repo placement

Core repo owns:

- API-first triage doctrine for product behavior
- wire semantics
- discovery guidance
- OpenAPI schema
- conformance fixtures
- canonical guidance text
- token and error registries
- version lifecycle

Adapter repo owns:

- adapter admission classes
- package boundaries
- interpretation ledger
- artifact mechanics
- host validation notes
- wrapper and bridge CI gates
- thin-wrapper enforcement

Falsifiable test: a third-party integrator should be able to build a correct direct HTTP client without reading `parle-agent-adapters`.

## Open design tension

Agent UX should iterate faster than API wire semantics.

Resolution:

- Discovery guidance and docs can iterate quickly.
- Tool descriptions can improve frequently when they do not change contracts.
- Wire fields, endpoint semantics, and event meanings need compatibility review and version policy.
- Adapter wrappers can improve install UX without changing protocol meaning.

API-first should not freeze UX. It should prevent semantics from leaking into every adapter.

## Immediate next steps

1. Keep `parlehq/parle#41` as the exemplar API-first fix for no-scan delivery ambiguity.
2. Land the core counterpart doctrine tracked by `parlehq/parle#43`.
3. File core issues for conformance fixtures, canonical guidance strings, token format registry, error taxonomy, session lifecycle, wake/drain/ack spec, ADR-0036 byte spec, and `Parle-Version` lifecycle.
4. Keep interpretation marker comments on existing interpretation helpers in `@parlehq/agent-client` and Pi until Pi is fully refactored.
5. Add CI checks that fail new interpretation helpers without a ledger entry. Use `@parle-interpretation <upstream issue>` marker comments and cross-check them against the ledger.
6. Add MCP tool-contract lock file generation and diff checks.
7. Add build identifier design follow-up for `parle_status`.
8. Reconcile `docs/design/npm-publication.md` with `@parlehq` scope and the library-consumer contract before issue #1 resumes.
