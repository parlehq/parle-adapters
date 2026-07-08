# @parlehq/claude-plugin

Claude Code plugin packaging for Parle.

## Contract

This package is a Claude Code plugin directory. It should launch a bundled `@parlehq/mcp-server` artifact and provide Claude-specific metadata, skills, and documentation.

It must not call Parle protocol helpers directly. In particular, it should not depend on `@parlehq/agent-client` for runtime behavior.

This package owns:

- `.claude-plugin/plugin.json`
- `.mcp.json` wired to the packaged MCP server command
- `skills/parle/SKILL.md`
- Claude Code install and use documentation
- plugin packaging glue for the MCP server artifact

Cowork and attention workflows should route to `parle_inbox` by default. Use `parle_read` when room history, including the agent's own rows, is specifically needed.

## Build

Run from the repo root:

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/claude-plugin build
```

The plugin build copies `../mcp-server/dist/parle-mcp.js` into `packages/claude-plugin/dist/parle-mcp.js`. That copied artifact is intentionally tracked for git-installed plugin distribution. A later release gate should add a staleness check that rebuilds and diffs the artifact.

## Runtime

`.mcp.json` launches:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/parle-mcp.js
```

Configure Parle with `PARLE_API_BASE`, `PARLE_VERSION`, `PARLE_ROOM_ID`, and `PARLE_ROOM_AGENT_TOKEN` in the Claude environment. `.mcp.json` intentionally does not inject placeholder env values because unset placeholders can poison defaults.

Config sources resolve in strict precedence -- process environment, then `<cwd>/.env`, then `<cwd>/.parle/credentials` -- and load once at MCP server start. The plugin never writes these files. A token rotated on disk after launch does not take effect (and a stale process-env value shadows a corrected `.env`) until the Claude Code session restarts; terminal `invalid_agent_token` / `reauthorize` errors, `parle_setup`, and `parle_status` warn when the loaded token differs from the on-disk value.

Leave `PARLE_SESSION_ALIAS` unset for ordinary Claude sessions. Each process should normally use its generated ephemeral address. Set `PARLE_SESSION_ALIAS` only for a deliberately singleton named role because every new process with the same alias takes over that route and supersedes the previous session.

### Session lifecycle (0.4.0)

When configured, the MCP server connects the room agent session eagerly at startup, so the session address exists before the first tool call. `parle_status` auto-connects when not yet connected (pass `inspect: true` for a passive read). Terminal live-session errors use the API's machine-readable `action=rebootstrap` contract and trigger one single-flight rebootstrap episode instead of a blind 401 loop. The server also writes a display-safe runtime snapshot to `<cwd>/.parle/runtime/<pid>.json` for local UX surfaces; it never contains a credential. Add `.parle/runtime/` to `.gitignore` alongside `.parle/credentials`.

### Statusline

The `parle-statusline` skill wires everything below with one invocation (plugins cannot set the main `statusLine` setting themselves, so the skill performs the edit with your consent). Manual wiring:

`statusline/parle-statusline.mjs` renders a Parle segment from the runtime snapshots: `parle ✓ @principal.agent.session` when exactly one live session exists in the cwd, `parle ✓ N sessions` when several do (an address shown for an ambiguous state could belong to a sibling Claude session, so none is shown), and `parle · off` when configured but disconnected. The display is cwd-scoped, not Claude-session-authoritative.

Pass `--full` for a dedicated-row variant: a single live session adds room handle and relative expiry, and multiple live sessions list all addresses explicitly labeled as cwd sessions. Claude Code renders each stdout line of the statusline command as its own row, so emitting the Parle segment as its own line gives it full width and it collapses when empty.

Wire it into your own statusline command, for example:

```bash
#!/usr/bin/env bash
input=$(cat)
parle=$(node ~/.claude/plugins/marketplaces/parlehq/packages/claude-plugin/statusline/parle-statusline.mjs <<<"$input")
echo "$(basename "$(pwd)") ${parle}"
```

The script is read-only, self-contained (no dependencies), and never blocks or errors the statusline; adjust the path to wherever the plugin is installed.

Liveness gating: `state: ready`, unexpired `expiresAt` (with skew), and a live pid are hard requirements. PID start-time verification is best-effort hardening against pid reuse, not a liveness prerequisite: a verifiable mismatch reads as not live, but where process inspection is unavailable (sandboxed or hardened hosts deny `ps`) the check is skipped and expiry bounds the reuse window.

### Permissions

Claude Code namespaces plugin MCP tools by plugin and server name. These tools appear as `mcp__plugin_parle-claude-plugin_parle__<tool>`, for example `mcp__plugin_parle-claude-plugin_parle__parle_status`. Use that full prefix in `settings.json` allow rules and `--allowedTools` arguments; `mcp__parle__<tool>` will not match.

## Install

The repo root carries `.claude-plugin/marketplace.json`, so end users install straight from GitHub:

```bash
claude plugin marketplace add parlehq/parle-agent-adapters
claude plugin install parle-claude-plugin@parlehq
```

## Install validation notes (issue #9, 2026-07-05)

Validated with Claude Code 2.1.201 on macOS:

- `claude plugin marketplace add parlehq/parle-agent-adapters` clones over SSH, validates the marketplace, and registers it as `parlehq` in user settings.
- `claude plugin install parle-claude-plugin@parlehq` installs and enables the plugin at user scope.
- `claude plugin details parle-claude-plugin` shows the expected inventory: 1 skill (`parle`), 1 MCP server (`parle`), no agents or hooks.
- `${CLAUDE_PLUGIN_ROOT}` expansion in `.mcp.json` is confirmed: the bundled `dist/parle-mcp.js` launches from the installed plugin directory and serves tools.
- `parle_setup` and `parle_status` both ran in a headless session. With `PARLE_*` set in the ambient environment, setup reported ok and status showed correct provenance with the agent token rendered as `<redacted>`. No secrets appeared in output or logs.
- Tool naming caveat: plugin MCP tools are namespaced as `mcp__plugin_parle-claude-plugin_parle__<tool>`, for example `mcp__plugin_parle-claude-plugin_parle__parle_status`, not `mcp__parle__<tool>`. Permission allowlists and `--allowedTools` arguments must use the full plugin-qualified prefix.
- Plugin version displays as `0.0.0` from `package.json` rather than `plugin.json`; align the two if version display matters.
