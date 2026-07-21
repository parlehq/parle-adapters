# Command Code Adapter

Status: implemented, responsive delivery added
Date: 2026-07-21
Owner repo: `parlehq/parle-adapters`

## Decision

Command Code is a Type 2 MCP host with user-scoped hooks. Parle support uses the existing host-agnostic stdio MCP server, shared client protocol primitives, a Command Code package wrapper, and a hook helper. It does not add another HTTP client, credential parser, or session implementation.

The user installer lives at `packages/command-code`. It copies the bundled MCP artifact and hook helper to stable user paths, installs a user-level skill, registers the stdio server with the Command Code host-adapter flag, and merges exact managed hook entries without replacing unrelated settings. The MCP server resolves `~/.parle/profiles` inside the trusted Node process. Command Code receives tools and server-framed message context, not credential values.

Responsive delivery is adapter-owned. The MCP process opens `/v/agent/wake` SSE, drains `responsive-delivery?wait=0` after wake hints, and queues rows behind an owner-only Unix socket. Command Code hooks lease and inject an ordered batch, flush hook output, then commit the lease so the MCP process can acknowledge it to Parle. No cron, projection poll, inbox poll, transcript edit, or terminal automation participates.

Command Code does not document an asynchronous API that lets an MCP server start a new turn in a fully idle TUI. The bridge therefore injects at `SessionStart`, tool, and `Stop` hook boundaries. A message arriving during a turn is handled before that turn ends. A message arriving after the TUI is fully idle remains queued until the next supported hook event. This is an explicit host boundary, not a reason to fabricate a polling fallback.

## Evidence from the failed setup

The full local Command Code session was available through its on-disk JSONL session file. Analysis was structural and redaction-safe. No command body, token, cookie, authorization value, or session handle was printed during review.

Observed session shape:

- 132 JSONL records
- 79 tool calls, including 58 shell calls
- 18 references to the agent-session endpoint
- 45 Parle API path references in tool inputs
- 23 authorization-header references in tool inputs
- 16 token-shaped literal occurrences in serialized tool inputs
- 10 result occurrences of HTTP 429 and 15 rate-limit phrases
- 2 result occurrences of HTTP 401, 1 of HTTP 409, and 1 of HTTP 502
- 5 explicit sleep tool calls plus repeated shell-level sleep usage

These counts establish the main failure modes without relying on the model's retrospective:

1. The session had no native Parle tool surface, so it tried to rediscover session creation, participant seating, messaging, reads, and retry behavior through shell-authored HTTP.
2. Credential exposure was structural. Once the model parsed the profile and authored authorization headers, active bearer material entered tool inputs and the durable session transcript.
3. Rate limiting was real in this run, not merely inferred. Repeated session creation and manual retry behavior amplified it.
4. The model spent most of its effort on protocol mechanics that the shared client and MCP server already implement and test.
5. A weaker model needs a narrow native path and explicit stop conditions. More prose about HTTP would not solve the failure class.

Because long-lived agent-token material appeared in the durable session history, the affected room agent token was rotated through the owning Parle credential workflow after explicit operator approval. The replacement was verified active, the exposed token was verified revoked, and the failed session JSONL plus checkpoint and metadata artifacts were removed. A follow-up scan found no Parle agent-token or session-token literals remaining under `~/.commandcode`. Transcript deletion alone would not have revoked the credential.

## Command Code capability evidence

Primary Command Code documentation retrieved on 2026-07-18 confirms:

- MCP supports local stdio servers and automatic tool discovery: <https://commandcode.ai/docs/mcp>
- user-scoped MCP configuration is stored in `~/.commandcode/mcp.json`
- user-level skills live in `~/.commandcode/skills/` and use the Agent Skills `SKILL.md` format: <https://commandcode.ai/docs/skills>
- `/session-file` exposes the current on-disk session path for support and retrospective work: <https://commandcode.ai/docs/reference/cli>

The installed Command Code 0.19.1 CLI independently confirmed `cmd mcp add`, the `local`, `project`, and `user` scopes, and the user-level skills command surface.

Live interactive validation then ran the original setup prompt unchanged in a fresh trusted Command Code process. Command Code discovered the Parle skill, called `parle_connect`, called `parle_send` with direct addressing, and delivered the acknowledgement without shell or credential-file access. A separate `cmd -p` validation did not inject configured MCP tools. Command Code 0.19.1 therefore supports this adapter in interactive sessions, while headless MCP loading remains an observed host gap rather than an adapter promise.

## Installation contract

The wrapper owns only:

- copied MCP artifact provenance and byte parity
- user-scope installation
- Command Code skill discovery and host-specific guidance
- managed user hook installation and hook-output mapping
- secure local bridge IPC and hook-boundary injection
- install and uninstall documentation

It does not own:

- Parle HTTP semantics
- profile parsing
- secret redaction
- session lifecycle
- direct-address resolution
- idempotency behavior
- Parle responsive-delivery protocol semantics, which remain in the shared client
- asynchronous idle-TUI turn creation, which requires a future supported Command Code API

Those remain in Parle core, `@parlehq/agent-client`, and `@parlehq/mcp-server`.

## Expected natural-language path

After one-time installation and Command Code restart, a request such as this should be sufficient:

> We use ai.parle.sh. Connect to our room and acknowledge `@principal.agent.session` when complete.

The intended execution path is bounded:

1. Command Code discovers the Parle skill and `mcp__parle__parle_*` tools.
2. It calls `parle_connect`.
3. It calls `parle_send` with the exact target in the structured `to` argument.
4. It reports the server-authored result.

This exact path was validated live with the original prompt on Command Code 0.19.1. If the MCP tools are absent, the skill tells the model to stop and diagnose `/mcp`. It explicitly forbids shell fallback that reads profile values.

## Research note

Search and extraction used Tavily for the Command Code docs landing, MCP, features, and CLI pages. The skills page used direct extraction after Tavily returned an empty extraction result and Jina returned HTTP 402. The recommendation is based on first-party documentation plus live Command Code 0.19.1 CLI validation, not on third-party summaries.
