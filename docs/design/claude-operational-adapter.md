# Claude Operational Adapter Design

Status: implementation-ready epic design
Date: 2026-07-05
Issue: https://github.com/parlehq/parle-agent-adapters/issues/2

## Objective

Make the working Parle adapter pattern operational for Claude users without duplicating Parle protocol logic or creating a Claude-only client.

Supported user paths:

1. Claude Code users working in a terminal or project repo.
2. Generic MCP host users who can run a local stdio MCP server.
3. Claude Desktop users who want chat, cowork, or code-adjacent workflows with the least setup possible.

The phrase "Claude CLI harness" means Claude Code CLI only when it refers to Anthropic's `claude` terminal app. For any other CLI host, the supported integration point is the generic MCP server.

## Final architecture

Use one shared implementation with four install or runtime surfaces:

1. `packages/client`, package `@parlehq/agent-client`: headless Parle protocol client.
2. `packages/pi-extension`, package `@parlehq/pi-extension`: native Pi extension rebuilt on the shared client.
3. `packages/mcp-server`, package `@parlehq/mcp-server`: stdio MCP server for Claude and other MCP hosts.
4. `packages/claude-plugin`: Claude Code plugin that launches the MCP server.
5. `packages/claude-desktop-extension`: Claude Desktop MCPB bundle packaging that launches the same MCP server.

`packages/claude-desktop-extension` does not exist yet. It should be added after the MCP server is proven.

Do not introduce an all-in-one runtime package.

## Implementation preconditions

Before client extraction starts:

- Treat the current Pi extension as the extraction parity baseline. The recent Pi fixes are committed and include direct addressing, `parle_inbox`, `parle_affordances`, heartbeat 404 re-bootstrap, room-tool 404 re-bootstrap, and best-effort session end behavior.
- Freeze the MCP v1 tool list to `parle_status`, `parle_setup`, `parle_guidance`, `parle_read`, `parle_inbox`, `parle_affordances`, and `parle_send`.
- Defer `parle_request` from MCP v1. It can return later as an advanced Claude Code tool with explicit confirmation semantics.
- Decide the room handle path for Desktop. If room handle resolution requires human session auth, Desktop v1 should accept room id first and track handle support as follow-up.
- Confirm the final Claude Code `.mcp.json` command shape against a local Claude Code plugin install.
- Confirm MCPB manifest validation and pack commands against the current `mcpb` CLI.

## Server distribution decision

Do not block Claude support on npm publication.

For v1, build a single bundled JavaScript artifact for the MCP server, for example `dist/parle-mcp.js`, using a bundler such as esbuild. Both Claude surfaces should launch that built artifact:

- Claude Code plugin `.mcp.json` should run `node ${CLAUDE_PLUGIN_ROOT}/dist/parle-mcp.js` or the equivalent supported plugin-root variable.
- Claude Desktop MCPB should include the same server artifact under its bundle directory and run it with `node ${__dirname}/server/parle-mcp.js`.

This keeps issue #1, npm publication, separate from operational Claude support.

## Session lifecycle decision

Claude MCP hosts do not have Pi's injection watcher model.

MCP v1 should use lazy bootstrap and re-bootstrap:

- Bootstrap the agent session on the first tool call that needs room access.
- Piggyback heartbeat on tool calls when a session exists and is near expiry.
- Accept that the agent may appear offline between tool calls.
- Best-effort end the agent session when the stdio process closes.
- Do not run a background watch loop in v1.

This preserves safety and avoids unsupported host behavior while keeping long-lived MCP server processes healthy during active use. If a later Claude surface supports responsive background delivery, it must use the `/v/agent/wake` SSE stream as the trigger and drain `/responsive-delivery?wait=0` after each wake hint. It must not emulate a watcher with repeated `waitSeconds` or `wait` calls.

## Cursor decision

MCP v1 uses in-memory cursor state only.

`parle_read` and `parle_inbox` must:

- accept an explicit `sinceSeq` argument
- default to the process-local cursor when `sinceSeq` is absent
- share one process-local cursor across both read surfaces, matching the global room sequence space
- return `cursorBefore`, `cursorAfter`, and `advancedCursor`
- return a warning that Desktop or plugin process restarts reset the in-memory cursor

Persistent cursor state is follow-up work. Do not write cursor state into project files or user config in v1.

## Mutation and tool-safety decision

MCP does not provide Pi's host-specific confirmation API. Safety must be expressed through tool shape and MCP metadata.

V1 rules:

- `parle_status`, `parle_setup`, `parle_guidance`, `parle_read`, `parle_inbox`, and `parle_affordances` are read-only tools.
- `parle_send` is additive, not destructive, and relies on host-level tool approval plus idempotency keys.
- If `parle_request` returns later, every non-GET request must require an explicit `confirm: true` argument and a human-readable reason.
- Tool definitions should include MCP annotations where the SDK supports them: `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
- Tool responses should provide structured content where practical, with a text fallback for compatibility.

## Safe host policy

Default safe API base policy:

- Allow `https://api.parle.sh` and other `https://*.parle.sh` hosts.
- Reject non-HTTPS API bases by default.
- Allow local development hosts only behind an explicit development opt-in, for example `PARLE_ALLOW_INSECURE_LOCAL=1`, and only for loopback hosts.
- Never allow arbitrary remote hosts from user config.

This policy belongs in `@parlehq/agent-client` and should be shared by Pi and MCP.

## Package contracts

### `@parlehq/agent-client` in `packages/client`

Owns:

- config resolution and source provenance
- redaction and truncation
- safe base URL validation
- request helpers with injectable fetch
- setup diagnostics
- guidance fetch
- session bootstrap and re-bootstrap on 401 and session-404 responses
- heartbeat eligibility and heartbeat request primitives
- best-effort session end primitives
- participant join where required
- projection read and shared cursor math
- inbound self-excluding projection read
- room affordances fetch
- direct addressing payload construction and address validation result classification
- send with idempotency key support
- structured delivery and moderation state
- typed errors that adapters can map into host-safe responses

The client should return structured state, not final host-specific prose. Adapters own user-facing guidance strings and tool-name-specific next steps.

Must not import:

- Pi APIs
- Claude plugin APIs
- MCP SDK
- Claude Desktop MCPB packaging code
- GalexC-specific APIs

Boundary check mechanism:

- Add a small test script that scans `packages/client/src` for forbidden import specifiers such as `pi`, `@modelcontextprotocol`, `claude`, `mcp`, and `galexc`.
- Run that script under `pnpm test`.

### `@parlehq/pi-extension` in `packages/pi-extension`

Owns:

- Pi tool registration
- Pi Typebox schemas
- Pi runtime status and footer presentation
- SSE wake stream loop
- responsive delivery injection
- injection deduplication keys
- Pi lifecycle hooks
- Pi-specific README and install notes

Acceptance for Pi refactor:

- Existing Pi tests pass without weakening their assertions.
- Add tests only for new behavior, not to paper over extraction regressions.

### `@parlehq/mcp-server` in `packages/mcp-server`

Owns:

- stdio MCP server entrypoint
- `bin` entry for local execution
- MCP tool schemas and annotations
- mapping client results and errors into MCP structured content plus text fallback
- output caps and redacted error responses
- MCP smoke-test fixtures

Must depend on `@parlehq/agent-client`.

Must not import Pi, Claude plugin, Desktop bundle, or GalexC code.

### `packages/claude-plugin`

Owns:

- `.claude-plugin/plugin.json`
- `.mcp.json`
- `skills/parle/SKILL.md`
- README for Claude Code install and use
- bundled copy or build output of the MCP server artifact

Must invoke `@parlehq/mcp-server`, not `@parlehq/agent-client` directly. The current placeholder dependency on `@parlehq/agent-client` should be removed or replaced during scaffold hygiene.

### `packages/claude-desktop-extension`

Owns:

- Desktop Extension `manifest.json`
- MCPB bundle scripts
- user configuration fields
- sensitive token field wiring
- packed server artifact
- README for non-developer Desktop users
- pack inspection and secret scan checks

## MCP v1 tools

### `parle_status`

Read-only. Reports configuration provenance, enabled state, runtime state, and redacted session information.

### `parle_setup`

Read-only. Explains missing configuration without exposing secret values.

### `parle_guidance`

Read-only. Fetches capped Parle guidance from allowlisted Parle URLs.

### `parle_read`

Read-only. Reads projection rows after `sinceSeq` or the shared process-local cursor. It includes the agent's own rows. It may expose `waitSeconds` only as an explicit one-shot manual wait. Do not use it for background loops or responsive triggers. Returns cursor fields and untrusted-content warnings.

### `parle_inbox`

Read-only. Reads the self-excluding inbound attention surface after `sinceSeq` or the shared process-local cursor. Use this as the default cowork attention surface so Claude does not repeatedly react to its own sends. It may expose `waitSeconds` only as an explicit one-shot manual wait. Do not use it for background loops or responsive triggers. Returns cursor fields and untrusted-content warnings.

### `parle_affordances`

Read-only. Fetches advisory room affordances so Claude can see which room actions are available before attempting them.

### `parle_send`

Additive write. Sends a room message with an idempotency key and optional direct addressing. Returns delivery and moderation state in a structured form.

Deferred tools:

- `parle_request`: advanced generic request tool.

## Implementation issue split

Issue #2 is the umbrella epic. Create or track these implementation issues under it:

1. #3 Scaffold hygiene and package contracts.
2. #4 Extract tested `@parlehq/agent-client`.
3. #5 Refactor Pi onto the shared client with parity tests.
4. #6 Implement MCP v1 safe tools.
5. #7 Add MCP stdio smoke tests.
6. #8 Package Claude Code plugin.
7. #9 Validate Claude Code local plugin install.
8. #10 Add Claude Desktop MCPB package.
9. #11 Add MCPB pack inspection, secret scan, and Desktop validation.
10. #12 Update docs and release gates.

## Detailed sequence

### 1. Scaffold hygiene and package contracts

- Confirm the current Pi extension and tests are the baseline for extraction.
- Remove `@parlehq/agent-client` dependency from `packages/claude-plugin` unless a direct build-time reason remains.
- Make `packages/claude-plugin` depend on or bundle `@parlehq/mcp-server` only through the MCP artifact path.
- Add placeholder `packages/claude-desktop-extension` only when ready to implement Desktop packaging.
- Align `docs/design/package-architecture.md` so MCP v1 does not include `parle_request` as an initial tool.
- Add package contract notes to each package README as they become real.

### 2. Extract tested `@parlehq/agent-client`

Subphases:

1. Extract pure helpers first: config parsing, redaction, truncation, safe base validation, request URL construction, mutation classification, cursor math, idempotency helpers.
2. Add tests for those helpers in `packages/client`.
3. Extract session and room operations: bootstrap, 401 and 404 re-bootstrap, heartbeat, best-effort end, projection read, inbound read, affordances fetch, direct addressing, send, wake SSE stream handling, responsive-delivery drain with `wait=0`, ack, and delivery classification.
4. Keep runtime state injectable or adapter-owned so MCP and Pi do not share accidental singleton behavior.
5. Add forbidden import boundary test.

### 3. Refactor Pi onto the shared client

- Replace duplicated helper logic with `@parlehq/agent-client` imports.
- Keep Pi-owned watcher, injection, status, footer, and schemas in `packages/pi-extension`.
- Run the current Pi tests unchanged, including direct addressing, inbox, affordances, heartbeat 404, and room-tool 404 coverage.

### 4. Implement MCP v1 safe tools

- Add MCP SDK dependency.
- Add stdio entrypoint and `bin`.
- Register the seven v1 tools with schemas and annotations.
- Return structured content and text fallback.
- Ensure no live secrets are required for `parle_status` or `parle_setup` tests.

### 5. Add MCP stdio smoke tests

Automate:

- server starts over stdio
- initialize succeeds
- `tools/list` includes the seven v1 tools
- `parle_status` works with no secrets
- `parle_setup` reports missing config with redacted output
- read, inbox, affordances, and send logic can be unit-tested with mocked fetch

### 6. Package Claude Code plugin

- Add plugin manifest.
- Add `.mcp.json` that launches the bundled MCP artifact from the plugin root.
- Add `skills/parle/SKILL.md` with concise routing guidance.
- Add README with install, setup, status check, read, and send examples.
- Validate in Claude Code with a local plugin directory.

### 7. Package Claude Desktop extension

- Add `packages/claude-desktop-extension`.
- Add MCPB `manifest.json` using `manifest_version` supported by the selected `mcpb` CLI.
- Use `server.type = "node"` and a bundled server artifact.
- Add `user_config` for API base, room id, optional room handle when supported, agent token, and default read limit.
- Mark the agent token field `sensitive: true`.
- Add compatibility runtime requirements for Node matching Claude Desktop support.
- Run `mcpb validate` or the current equivalent and `mcpb pack` in CI once the CLI command is confirmed.

### 8. Release and docs gates

- Inspect the plugin package and MCPB archive.
- Confirm no `.env`, `.parle`, `.galexc`, `.claude`, `.pi`, root workspace cache, local credentials, or unrelated `node_modules` contents are included.
- Run a secret scan before release artifacts are shared.
- Update root README to distinguish Pi extension, generic MCP server, Claude Code plugin, and Claude Desktop bundle.
- Keep npm publication as a separate issue.

## Validation commands

Baseline local gate:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

Package gates as they become real:

```bash
pnpm -F @parlehq/agent-client test
pnpm -F @parlehq/pi-extension test
pnpm -F @parlehq/mcp-server test
pnpm -F @parlehq/mcp-server build
```

Additional gates:

- MCP stdio smoke test for initialize, tools/list, `parle_status`, and `parle_setup`.
- MCP unit or smoke coverage for `parle_read`, `parle_inbox`, `parle_affordances`, and `parle_send` with mocked fetch.
- Claude Code local plugin install test.
- MCPB validate and pack.
- Archive inspection and secret scan.

## Acceptance criteria for the epic

- Current Pi extension behavior is the extraction parity baseline.
- `@parlehq/agent-client` owns shared protocol behavior and has no harness imports.
- Package boundary checks prevent client imports from Pi, Claude, MCP, or GalexC packages.
- Pi extension still typechecks and tests after client extraction.
- `@parlehq/mcp-server` exposes only the seven safe v1 tools over stdio MCP.
- MCP tools include appropriate tool annotations where supported by the SDK.
- MCP smoke tests verify tool list plus `parle_status` and `parle_setup` without live secrets.
- MCP tools redact secrets, enforce safe host validation, cap output sizes, and avoid arbitrary remote hosts.
- Shared cursor behavior is explicit in `parle_read` and `parle_inbox` responses and tests.
- MCP session lifecycle uses lazy bootstrap, piggyback heartbeat, re-bootstrap, and best-effort stdio-close end.
- Claude Code plugin launches the MCP server artifact and includes a concise Parle skill.
- Claude Code README documents install, setup, status check, read, and send flows.
- Generic MCP host use is documented separately from Claude Code plugin use.
- Desktop Extension bundle can be validated and packed as `.mcpb`.
- Desktop Extension manifest uses sensitive fields for agent tokens.
- Desktop Extension pack inspection confirms no local credentials, repo config, or workspace caches are included.
- Secret scanning is part of release readiness for Claude Desktop artifacts.
- Claude Desktop install can show `parle_status` and `parle_setup` without manual JSON editing.
- Root README distinguishes Pi extension, generic MCP server, Claude Code plugin, and Claude Desktop bundle.
- No all-in-one runtime package is introduced.

## Risks and mitigations

- High: client extraction breaks the working Pi adapter. Mitigation: use the current committed Pi behavior as the extraction baseline, extract behind tests, and preserve Pi tests unchanged.
- High: Desktop bundle leaks credentials in manifests, logs, or packed files. Mitigation: use sensitive manifest fields, redaction tests, pack inspection, and secret scan before release.
- High: Claude surfaces depend on npm publication by accident. Mitigation: bundle a single MCP server artifact into Claude plugin and MCPB v1.
- Medium: agent session expires while Claude is idle. Mitigation: lazy re-bootstrap and piggyback heartbeat on tool calls; document offline between calls.
- Medium: Claude Code plugin and Desktop bundle drift. Mitigation: make both launch the same MCP server artifact.
- Medium: basic Desktop users get stuck on setup. Mitigation: prefer MCPB prompts over manual JSON; include setup diagnostics and clear troubleshooting.
- Medium: `parle_request` is too powerful for v1. Mitigation: defer it from MCP v1 and reintroduce only with explicit confirmation and annotations.

## Review summary

Mode: refine
Artifact: Claude operational adapter design and issue #2

### Consensus

- The architecture remains sound.
- The plan needed stronger implementation preconditions, especially around the current Pi extension baseline.
- The MCP server artifact distribution decision was load-bearing and is now resolved for v1.
- The session lifecycle, cursor state, and mutation confirmation model needed explicit decisions.
- The implementation should be split under the umbrella issue before coding.
- The current Pi `parle_inbox` and `parle_affordances` behavior should be extracted into the client, and both should be included in MCP v1.

### Divergence

- Reviewers differed on whether to add Desktop scaffolding immediately. Recommendation: do not add Desktop scaffolding until MCP server smoke tests pass.

### Blockers addressed

- Current Pi behavior must be treated as the extraction baseline.
- Server distribution no longer depends on npm publication.
- MCP session lifecycle is specified.
- Cursor persistence is scoped to in-memory v1 behavior.
- Mutation confirmation is mapped to MCP annotations and tool parameters.
- Package-boundary checks have a concrete mechanism.

### Stability assessment

Converging. The second design iteration changed sequencing and validation, not the core architecture.

### Verdict

Ready to start with scaffold hygiene using the current Pi extension as the extraction parity baseline.

## Evidence from external research

- Claude Code plugins can include skills, agents, hooks, MCP servers, settings, and plugin metadata. Plugins are for reusable distribution, while standalone `.claude/` config is better for personal or project-local use.
- Claude Code plugin structure supports `.mcp.json` at the plugin root.
- MCP tools include optional annotations and clients should consider annotations untrusted unless they come from trusted servers.
- The MCP tools spec recommends human confirmation for sensitive operations and requires servers to validate inputs, implement access controls, rate limit, and sanitize outputs.
- Claude Desktop supports Desktop Extensions as single-click local MCP server packages and custom `.mcpb` installation.
- MCPB manifests support `user_config`, sensitive string fields, variable substitution into `mcp_config`, `server.type = "node"`, and compatibility runtime constraints.

## Sources

- https://docs.anthropic.com/en/docs/claude-code/plugins
- https://docs.anthropic.com/en/docs/claude-code/mcp
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- https://github.com/modelcontextprotocol/mcpb
- https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md

## Research note

Research used Tavily Search and Tavily Extract on 2026-07-05. Jina was not used because Tavily search and extraction succeeded with normal quality.
