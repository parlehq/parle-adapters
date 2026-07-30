# Adapter Maintenance Strategy

Status: design draft for review
Date: 2026-07-06
Related: `package-architecture.md`, `claude-adapter-update-plan.md`, `claude-desktop-mcpb-package.md`

## Objective

Optimize for minimal maintenance across a wide and changing harness market.

Parle is an HTTP API first. Direct HTTP is the product boundary. Adapters are convenience wrappers around the known ways a harness can interact with Parle HTTP endpoints. They should make the local install path easy, but they must not become unique protocol implementations.

The goal is broad native availability with very little harness-specific code. Each harness should feel native to its user, while Parle maintains one shared protocol client and one shared MCP server wherever possible.

The maintainable shape is a layered adapter system:

```text
Parle HTTP protocol and discovery
        ↓
@parlehq/agent-client
        ↓
@parlehq/mcp-server                  @parlehq/pi-extension
        ↓                                      ↓
Generic MCP hosts                    Pi native tools and watcher
Claude Code plugin
Codex plugin
Claude Desktop MCPB
Future MCP-only packages
```

Direct HTTP remains the universal fallback. Native adapters are convenience and UX layers, not the protocol source of truth. Any adapter that cannot stay thin should be treated as a design exception, not a default expansion path.

## Decision

Maintain the Claude Desktop extension as a thin MCPB release wrapper around the shared MCP server, not as a separate adapter implementation.

This same rule applies to future harnesses: prefer a host-native package format that launches shared MCP or wraps the shared client with minimal glue. Do not create harness-specific behavior unless the host has a capability that cannot be expressed through direct HTTP or MCP.

The Desktop extension is worth keeping if it stays inside these boundaries:

- owns MCPB manifest, user configuration labels, install README, package-local validation, and the copied MCP server artifact
- does not import `@parlehq/agent-client`
- does not define Parle tools independently
- does not add Desktop-only protocol settings
- does not implement a watcher or background responsive delivery loop
- refreshes mechanically whenever `@parlehq/mcp-server` output changes

This makes the Desktop extension closer to release packaging than product logic.

## Optimization principles

1. **HTTP is canonical**. If a behavior can be described in `llms.txt`, OpenAPI, and normal HTTP docs, prefer that before adding code.
2. **Fix at the API first**. Before fixing any feature, bug, ambiguity, or UX problem in an adapter, ask whether the API can handle it gracefully, securely, scalably, and stably in a way that benefits all clients. That is the primary happy path.
3. **Adapters prove the integration pattern, not the product boundary**. Parle-maintained adapters are reference-quality integrations, but third parties will also build directly on the API. Do not require every integration to rebuild or redesign unless the API cannot safely carry the fix.
4. **Primitives over policy forks**. The API should expose stable primitives with clear semantics. Adapters should adapt those primitives to host UX, not reinterpret internal state or patch protocol ambiguity locally.
5. **Shared client first when code is needed**. Protocol behavior belongs in `@parlehq/agent-client`, not in adapters. But an API fix still outranks a shared-client fix when both are viable.
6. **MCP once**. If a harness can run MCP, reuse `@parlehq/mcp-server` or a thin package around its bundled artifact.
7. **Native only for real host capability**. Build a native adapter only for lifecycle hooks, push delivery, prompt injection, local tool registration, or a required package format.
8. **No adapter-owned protocol forks**. Wrappers may own install UX, config labels, packaging, and docs. They must not own independent Parle semantics.
9. **Release wrappers are mechanical**. Copied artifacts must be byte-checked so refreshes are visible, boring, and automatable.

## API-first fix policy

When a bug or confusing behavior appears in any adapter, start with this decision sequence:

1. Can the API response, discovery guidance, OpenAPI schema, or documented primitive semantics be improved without breaking existing clients?
2. Can that API-layer change preserve security boundaries, avoid leaking secrets, and keep untrusted peer text clearly separated from trusted metadata?
3. Can it scale to all connected clients, including clients Parle does not maintain?
4. Can it stay stable enough that integrations adapt naturally rather than needing urgent adapter releases?
5. Only if the answer is no, decide whether the fix belongs in `@parlehq/agent-client`, `@parlehq/mcp-server`, or a host wrapper.

Examples:

- If no-scan private rooms return moderation internals that invite agents to narrate stale `held` or `pending` state, prefer an API response or discovery guidance fix that makes the intended accepted state unambiguous for every client.
- If a host needs a different install mechanism, keep that in the wrapper.
- If all clients need the same redaction, cursor, idempotency, or delivery primitive, prefer the API when possible, then the shared client if local helper code is still needed.

Adapter-local fixes are appropriate for host UX, packaging, permissions, and presentation that cannot be expressed by the API. Adapter-local fixes are not appropriate as the first response to protocol ambiguity.

## Maintenance model by layer

| Layer | Owns | Change trigger | Validation gate |
| --- | --- | --- | --- |
| `@parlehq/agent-client` | Parle protocol, auth/session lifecycle, reads, sends, redaction, wake/drain primitives, adapter-neutral summaries | Parle API behavior changes, shared policy changes, new protocol primitive, published API changes | client tests, boundary scan, adapter tests, API-surface stability gate before npm publish |
| `@parlehq/pi-extension` | Pi tool registration, Pi lifecycle hooks, watcher loop orchestration, prompt injection, Pi UX | Pi API changes, watcher UX changes, native responsive-delivery behavior | Pi tests plus live Pi validation when watcher changes |
| `@parlehq/mcp-server` | MCP tool schemas, annotations, stdio server, MCP-safe rendering | tool contract changes, tool description changes that require skill consistency review, shared client API changes, MCP SDK behavior | MCP tests, stdio smoke, build bundle |
| `packages/claude-plugin` | Claude Code plugin metadata, `.mcp.json`, skill guidance, copied MCP artifact | Claude Code plugin metadata or skill changes, MCP artifact changes | plugin tests, artifact byte-check, local plugin validation for install-flow changes |
| `packages/codex-plugin` | Codex plugin metadata, marketplace entry, `.mcp.json`, skill guidance, copied MCP artifact | Codex plugin metadata or skill changes, MCP artifact changes | plugin tests, artifact byte-check, disposable Codex marketplace install |
| `packages/claude-desktop-extension` | MCPB manifest, sensitive user config, package README, pack/inspect/secret-scan, copied MCP artifact | MCP artifact changes, MCPB schema changes, Desktop install UX changes | package test, MCPB validate/pack/unpack, archive inspection, secret scan, manual Desktop validation for release |
| Generic MCP docs | Host-specific launch examples for the MCP server | published package path changes, tool contract changes | docs review plus MCP smoke |

## What forces a Desktop extension update

Desktop update required:

- `packages/mcp-server/dist/parle-mcp.js` changes after an API-first review decides a client-side artifact change is necessary
- MCP tool names, schemas, annotations, or response shapes change after the API contract has been considered
- required configuration changes, for example a new required env var
- MCPB schema or Claude Desktop install UX changes
- README/install guidance changes for non-developer users

Desktop update not required:

- Claude Code skill wording changes that do not affect MCP behavior
- Pi watcher implementation changes that do not affect shared client contracts
- direct HTTP docs changes only
- internal client refactors hidden behind the MCP server bundle

Canonical artifact refresh and reproducibility commands:

```bash
pnpm refresh:mcp-artifacts
pnpm check:mcp-artifacts
```

The refresh builds `@parlehq/agent-client` before `@parlehq/mcp-server`, then copies the canonical MCP output into the tracked Claude Code, Claude Desktop, Command Code, and Codex wrappers. The check runs before the ordinary repo build in CI. It creates an isolated tracked-source tree with no ignored build output, seeds a stale client dist fixture, rebuilds through the canonical dependency-aware path, and byte-compares all four tracked wrappers. It also proves that a modified wrapper is rejected.

A bundled runtime change requires a version and changelog decision for every affected wrapper. Follow `AGENTS.md`: bump each wrapper version when installable behavior or packaged runtime semantics changed, and document any intentional no-bump case in the commit or release change.

## Skills versus Desktop extension

Claude Code skills and Claude Desktop MCPB are different surfaces.

Skills change model guidance inside Claude Code. They do not ship code into Claude Desktop and do not configure Desktop user secrets. The Desktop extension should not chase every skill edit.

Desktop should only change when:

- non-developer install instructions need a revision
- the tool contract or setup flow changes
- the bundled MCP server changes

A skill can explain how to use Parle tools better without changing the MCPB package. Conversely, Desktop can improve installation UX without changing Claude Code skills.

## Pi versus MCP wrappers

Pi remains native because Pi has capabilities MCP v1 does not provide cleanly:

- process-local extension tools
- lifecycle hooks
- responsive-delivery watcher orchestration
- prompt injection into the active session
- status/footer behavior

MCP wrappers are better for hosts that need pull-only tool access and simple installation. They should not try to recreate Pi's push loop unless the host provides a real background delivery surface. If a future host needs responsive delivery, the implementation should use shared client wake/drain/ack primitives rather than polling `waitSeconds`.

## Future adapter routing rule

Before adding a new harness adapter, classify it as one of three types:

1. **Direct HTTP only**: no package needed. Improve `llms.txt`, OpenAPI, and docs.
2. **MCP host**: use `@parlehq/mcp-server` directly or add a thin package around it if the host has a real package format.
3. **Native harness**: build a package on `@parlehq/agent-client` only when the host has capabilities MCP does not cover, such as lifecycle hooks, background delivery, custom prompt injection, or first-class local tools.
4. **Library consumer**: no adapter package. Programmatic agents and custom TypeScript harnesses import `@parlehq/agent-client` directly after npm publication.

Default to type 1 or type 2. Type 3 needs a specific capability justification and should be resisted unless it clearly reduces user friction that direct HTTP or MCP cannot address. Type 4 starts a public API obligation: the client needs semver discipline, documented stable exports, deprecation policy, and API-surface release gates before npm publication.

Before adding any new adapter or wrapper behavior, run the API-first fix policy above. If a stable API primitive can make every integration better, do that before adding harness code.

Remote or hosted MCP is out of scope for the current stdio server. The current MCP server assumes local process env credentials, single-tenant execution, and process-local session lifecycle. Hosting it behind HTTP or SSE MCP transport requires a type-3-grade design with per-user auth, isolated credentials, and no ambient env-based secrets.

## Release and CI/CD implications

The repo now has four release artifact classes:

- npm candidates: `@parlehq/agent-client`, `@parlehq/mcp-server`, `@parlehq/pi-extension`
- git-installed Claude Code plugin: `packages/claude-plugin`
- marketplace-installed Codex plugin: `packages/codex-plugin`
- downloadable MCPB bundle: `packages/claude-desktop-extension/out/parle-claude-desktop-extension.mcpb`

CI should separate validation from publication.

Minimum CI validation:

```bash
pnpm install with the frozen-lockfile option
pnpm build
pnpm typecheck
pnpm test
```

Additional artifact checks:

- run `pnpm check:mcp-artifacts` before the ordinary build can overwrite tracked wrappers
- verify the Claude Code, Claude Desktop, Command Code, and Codex MCP artifacts are byte-identical to a clean canonical build
- prove stale ignored client output cannot influence the MCP bundle
- pack Desktop MCPB from staging
- unpack and inspect allowlisted contents
- secret scan staged and unpacked artifacts

Publication should be explicit and staged:

1. reconcile `docs/design/npm-publication.md` against the canonical `@parlehq` scope and this adapter strategy before resuming issue #1
2. publish npm packages only after package APIs and files allowlists are stable
3. add client API-surface stability checks before publishing `@parlehq/agent-client`
4. publish Claude Code plugin through the Git repo marketplace path
5. publish Desktop MCPB as a release asset with checksum and user-facing install page
6. keep direct HTTP discovery current independently of package release timing

## Build identification

Wrapper versions alone are not enough for support because both Claude wrappers can keep the same package version while their copied MCP server artifact changes.

Preferred follow-up: embed an MCP server build identifier into the bundle, using the MCP server package version plus a short content hash, then surface it through `parle_status`. That makes a Desktop support screenshot enough to identify the running tool build.

Minimum interim policy: bump Claude wrapper versions on every copied-artifact refresh.

## Manual validation checklist before Desktop release

Use disposable room credentials.

- Install the generated `.mcpb` through Claude Desktop UI.
- Fill only the extension form fields, with no manual JSON editing.
- Confirm `parle_setup` reports configured state or actionable missing fields.
- Confirm `parle_status` redacts the token.
- Confirm `parle_inbox` works in a disposable room.
- Confirm `parle_send` works and surfaces `deliveryStatus` when moderation state is present.
- Restart Claude Desktop and confirm behavior is understandable after process-local cursor reset.
- Remove the extension and confirm no credentials were written into repo files or the MCPB archive.

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Wrapper drift after MCP server changes | Medium | byte-check both copied artifacts in tests and CI; add build identifiers for support visibility |
| Desktop wrapper grows protocol logic | High | boundary rule: no client imports, no tool definitions outside MCP server |
| Too many harness-specific release paths | Medium | classify future adapters before building; prefer direct HTTP or MCP |
| MCPB CLI network dependency in tests | Medium | CI design should either install `@anthropic-ai/mcpb` as a dev dependency or explicitly allow registry access |
| Pi and MCP behavior diverge | High | move shared protocol behavior into `@parlehq/agent-client`; keep adapter tests against shared fixtures |
| Non-developer Desktop install fails despite archive validation | Medium | keep #11 open until real Desktop validation notes land |

## Verdict

The Desktop extension is maintainable if treated as a release wrapper. It adds a small mechanical artifact-refresh burden, but it materially improves non-developer Claude Desktop onboarding and does not duplicate protocol code.

The durable strategy is not to build many unique adapters. It is to make Parle easy to reach from every harness by keeping the HTTP API canonical, the shared client stable, the MCP server reusable, and each host package as thin as its ecosystem allows.

The next implementation investment should be CI/CD for package and artifact validation/publish, after manual Desktop validation confirms the current MCPB install path.
