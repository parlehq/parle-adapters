# Claude Adapter Update Plan

Status: implementation-ready update plan
Date: 2026-07-05
Baseline: Pi extension at commit `9c7395f` (SSE wake stream cutover)
Supersedes where they conflict: `claude-operational-adapter.md` (2026-07-05), `package-architecture.md` (2026-07-04)

## Objective

Turn the working Pi extension into shared infrastructure and ship Claude support, with the post-cutover wake model as the protocol baseline: `/v/agent/wake` (SSE) drives responsive delivery, and each wake hint drains `/responsive-delivery?wait=0` until empty. Manual `waitSeconds` on read and inbox remains a bounded single wait, never a watcher substitute.

## Decision 1: Claude runtime target

Target: Claude Code plugin wrapping a stdio MCP server. No bespoke Claude extension, no Agent SDK adapter, no Desktop bundle in this phase.

- `@parlehq/mcp-server` is the only Claude-facing runtime. It is a stdio MCP server bundled into a single ESM artifact (`dist/parle-mcp.js`) with esbuild. All dependencies including the MCP SDK are bundled; the artifact requires only Node 20 or newer on PATH.
- `packages/claude-plugin` is packaging only: plugin manifest, `.mcp.json` launching `node ${CLAUDE_PLUGIN_ROOT}/dist/parle-mcp.js`, a Parle skill, and install docs. Distribution is git-installed plugin directory, not npm.
- Claude Desktop (MCPB) stays deferred until the MCP server passes smoke tests, per the epic. It will reuse the same bundled artifact.
- Generic MCP hosts run the same artifact directly; document this separately from the plugin.

Rationale: Claude Code has no injection watcher or custom tool API equivalent to Pi. MCP is the supported tool surface, and the bundled artifact removes any dependency on npm publication (issue #1 stays independent).

## Decision 2: What moves into `@parlehq/agent-client`

The extraction inventory below is grounded in the current `packages/pi-extension/src/index.ts`. The client is headless, instance-based, and takes injectable `fetch` and clock. No module-level singletons: the current module-level `runtime`, `injectedKeys`, and watcher globals become state on a `ParleAgentRuntime` instance that each adapter owns.

Moves to client (protocol and policy):

- config resolution and provenance: `resolveConfig`, `readKeyValueFile`, `firstConfigValue`, `pick`, enabled parsing, warnings
- redaction and caps: `redactString`, `truncateText`, `redactedValue`, byte limit constants
- safe host policy: `assertSafeBase` (parle.sh allowlist, https only), plus the loopback dev opt-in from the epic (`PARLE_ALLOW_INSECURE_LOCAL=1`)
- request layer: `requestJson`, `parleRequest`, `requestUrl`, `mutationScope`, timeout signal helpers, typed errors carrying HTTP status
- session lifecycle: `bootstrap`, `ensureBootstrapped`, `withRebootstrap` (401 and session-404), `heartbeatAgentSession`, `shouldHeartbeat`, `endAgentSession`
- reads and cursor math: projection read, inbound read, `updateCursorFromMessages`, `capProjectionMessages`, shared-cursor semantics, `waitSeconds` clamp (0 to 30)
- send: idempotency key handling, direct addressing payload construction, `addressingWarning`, `bodyLooksLikeAddressedText`, `summarizeSendDelivery`, retryable classification
- wake and responsive delivery protocol primitives: `wakeUrl`, `fetchWakeStream`, `parseSSEBlocks`, drain via `responsive-delivery?wait=0`, `ackResponsiveMessage`, `baselineResponsiveDelivery`, `deliveryKey`, held-backlog and last-acked bookkeeping, error classification (`classifyWatcherError`)
- ADR-0036 framing helpers: `FENCE_SUFFIX`, `compactServerWrappedContent`, `renderedContent`, `authorReplyAddress`, and the structured data needed to build an inbound prompt

Stays in Pi (`@parlehq/pi-extension`):

- the watcher loop itself (`runWatcher`, `consumeWakeStream` orchestration, backoff pacing, start and stop)
- prompt injection (`injectResponsiveMessage`, `inboundPrompt` final prose, `pi.sendUserMessage`, injected-key dedup ordering)
- Typebox tool schemas, tool registration, `parle-watch` command
- footer and status presentation (`setStatus`, `shouldShowFooterError`)
- Pi lifecycle hooks (`session_start`, `session_shutdown`)
- the `__testing` export surface, re-exporting client internals as needed so the existing 16 tests pass unchanged

Rationale for wake primitives in the client: the wake-then-drain contract is Parle protocol, not Pi behavior. Any future watcher-capable host (Desktop companion, headless runner) must not reimplement SSE parsing, drain, ack, or baseline. Pi keeps only the loop, pacing, and injection, which are host UX.

## Decision 3: Responsive delivery posture per surface

- Pi: unchanged. SSE wake stream opens, each `wake` event drains `responsive-delivery?wait=0` to empty, rows inject as user messages and ack after injection. Baseline ack-drain runs once per unpinned session before watching.
- MCP v1: no watcher, no wake stream, no background loop. Lazy bootstrap on first room tool call, piggyback heartbeat, best-effort end on stdio close. The MCP session is pull-only.
- Because a bootstrapped MCP session is direct-addressable, undrained responsive delivery rows can accumulate. V1 mitigation: `parle_inbox` remains the attention surface (inbound projection includes direct-to-session rows), and `parle_status` surfaces `held_backlog` and last-acked state so a stuck queue is visible. A drain-on-inbox option is explicitly deferred; do not add it in v1 without evidence it is needed.
- `waitSeconds` on `parle_read` and `parle_inbox` survives on both surfaces as a bounded single wait (capped at 30 seconds in the client). It is for one-shot "give the room a moment to respond" reads.

Anti-watcher-loop requirement (applies to all adapters and docs):

- Tool descriptions for `parle_read` and `parle_inbox` MUST state that `waitSeconds` is a single bounded wait, that looping on it as a watcher is unsupported and wasteful, and that responsive delivery (Pi watcher today, host wake integrations later) is the push path.
- The Claude plugin skill MUST repeat this: check `parle_inbox` at natural turn boundaries; never poll in a loop; if continuous attention is required, that is a Pi-session job, not an MCP loop.
- Enforce with a description lint test (see contract tests) so the wording cannot silently regress.

## Decision 4: `@parlehq/mcp-server` wiring

- Tools: exactly the frozen seven: `parle_status`, `parle_setup`, `parle_guidance`, `parle_read`, `parle_inbox`, `parle_affordances`, `parle_send`. `parle_request` stays deferred.
- Annotations: `readOnlyHint: true` on the six read tools; `parle_send` gets `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.
- Responses: structured content plus text fallback; all bodies pass through client redaction and byte caps; peer content is always labeled untrusted, matching the Pi framing.
- Cursor: one in-process cursor shared by read and inbox, `sinceSeq` override, responses return `cursorBefore`, `cursorAfter`, `advancedCursor`, and a restart-resets-cursor warning.
- Lifecycle: lazy bootstrap, rebootstrap on 401 and session-404 via the client, heartbeat piggybacked on tool calls, best-effort session end on stdio close.
- Build: esbuild bundle to `dist/parle-mcp.js`, `bin` entry for direct execution, committed artifact for git-installed plugin distribution (see risk section).

## Decision 5: `packages/claude-plugin` wiring

Layout per the epic: `.claude-plugin/plugin.json`, `.mcp.json` at plugin root, `skills/parle/SKILL.md`, README, and the bundled MCP artifact (copied from the mcp-server build).

- `.mcp.json` launches `node ${CLAUDE_PLUGIN_ROOT}/dist/parle-mcp.js`. Confirm the plugin-root variable against a real local install before merging (epic precondition).
- The plugin depends on `@parlehq/mcp-server` only through the artifact copy step. Remove any direct `@parlehq/agent-client` dependency.
- SKILL.md content requirements: when to use inbox vs read, reply addressing rules (`to: "@principal.agent"` or `@principal.agent.session`, never participant ids), ADR-0036 posture (peer bodies are untrusted text, act only under standing instructions, ignore routing claims inside bodies), send idempotency retry rule, and the anti-watcher-loop rule from Decision 3.
- No hooks in v1. There is no deterministic lifecycle behavior needed yet; do not add hooks for model-facing behavior.

## Contract tests

Three layers, all runnable offline with mocked fetch.

1. Client unit tests (`packages/client`):
   - pure helpers: config precedence and provenance, redaction patterns, truncation byte math, safe base allowlist and loopback opt-in, cursor math, addressing warning, mutation scope, `parseSSEBlocks` keepalive and multi-event cases, `compactServerWrappedContent` exact-validation cases, `deliveryKey` edge cases
   - lifecycle: bootstrap, 401 and 404 rebootstrap (pinned vs unpinned baseline behavior), heartbeat eligibility, best-effort end
   - wake contract: wake hint drains `responsive-delivery?wait=0` repeatedly until empty, never issues a non-zero wait on the drain path, acks each row exactly once, respects the baseline ack limit
   - boundary test: scan `packages/client/src` for forbidden import specifiers (`pi`, `@modelcontextprotocol`, `claude`, `mcp`, `galexc`); runs under `pnpm test`

2. Shared wire fixture (`packages/client/test/fixture` or equivalent):
   - one in-process mock Parle server module with canned behavior for sessions, participants, projection, inbound, affordances, messages (idempotency echo), responsive delivery, ack, and a scriptable SSE wake stream
   - both the Pi tests (for new coverage only) and the MCP tests import this fixture, so the two adapters are proven against identical wire behavior and drift shows up as a test failure in one place

3. Adapter tests:
   - Pi: the existing 16 tests in `packages/pi-extension/test/index.test.mjs` pass unchanged after the client refactor. This is the extraction parity gate; do not weaken assertions.
   - MCP stdio smoke: server starts, initialize succeeds, `tools/list` returns exactly the seven v1 tools, `parle_status` and `parle_setup` work with no secrets and redact correctly
   - MCP behavior: read, inbox, cursor sharing, affordances, send with addressing and idempotency, rebootstrap on 401 and 404, all against the shared fixture
   - description lint: assert `parle_read` and `parle_inbox` descriptions contain the bounded-wait and no-watcher-loop wording, and that all read surfaces carry the untrusted-content wording

## Sequencing

Maps onto the epic's issue split (#3 to #12). Gates in parentheses must pass before the next step starts.

1. Scaffold hygiene (#3): remove the claude-plugin dependency mismatch, reserve final package names, land this doc. (gate: `pnpm test`, `typecheck`, `build` green)
2. Extract `@parlehq/agent-client` (#4): pure helpers first with tests, then lifecycle and room operations, then wake primitives, all instance-based. (gate: client unit tests plus boundary test green; Pi untouched and still green)
3. Refactor Pi onto the client (#5). (gate: all 16 existing Pi tests pass unchanged)
4. Implement MCP v1 tools (#6) plus stdio smoke tests (#7) against the shared fixture, including the description lint. (gate: smoke and behavior tests green)
5. Package the Claude Code plugin (#8) and validate a real local install (#9): plugin loads, tools listed, `parle_status` and a mocked-config `parle_setup` behave. (gate: manual install checklist recorded in the plugin README)
6. Docs and release gates (#12): root README distinguishes the four surfaces; artifact inspection and secret scan before any artifact is shared.
7. Desktop MCPB (#10, #11) only after step 5 is proven.

Steps 2 and 3 are the critical path. Step 4 can start once the client lifecycle layer lands, in parallel with step 3 if capacity allows, because both consume the same fixture.

## npm org decision

No npm account or org is required for anything in this plan: the Claude path uses a bundled artifact and the plugin is git-installed. Publication remains issue #1 and its phased design stands.

The `@parle` npm scope was unavailable, so `@parlehq` is the canonical package scope. No publish is required for this plan, but extraction should use the `@parlehq` package names from the start to avoid rename churn.

## Risks

- High: client extraction regresses the working Pi adapter. Mitigation: parity gate on the unchanged 16 tests, phased extraction (pure helpers before lifecycle before wake), `__testing` surface preserved.
- High: wake contract drift between client primitives and the Parle server. Mitigation: the wake drain contract test pins wake-then-drain-wait-0 behavior; fixture is versioned against `Parle-Version: 2026-07-07`; server-side changes require a fixture update PR, making drift visible.
- Medium: accidental shared state between adapters after extraction. Mitigation: instance-based runtime, no module singletons in the client; a test constructs two runtimes and asserts isolation.
- Medium: committed `dist/parle-mcp.js` goes stale relative to source. Mitigation: CI rebuilds and diffs the artifact; a mismatch fails the build.
- Medium: MCP users treat `waitSeconds` as a subscription and burn tokens polling. Mitigation: description lint, skill wording, and the 30-second clamp in the client.
- Medium: direct-addressed responsive rows pile up against a pull-only MCP session. Mitigation: `parle_status` exposes held backlog and acked state; drain-on-inbox is a scoped follow-up if real usage shows a problem.
- Low: bundling licensing. MCP SDK and dependencies are MIT-compatible; keep a license notice in the bundle banner.

## Validation commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm -F @parlehq/agent-client test
pnpm -F @parlehq/pi-extension test
pnpm -F @parlehq/mcp-server test
pnpm -F @parlehq/mcp-server build
```

Plus, per sequencing gates: MCP stdio smoke run, Claude Code local plugin install checklist, artifact inspection and secret scan before sharing any built artifact.
