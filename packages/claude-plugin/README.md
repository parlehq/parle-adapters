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

Configure Parle with `PARLE_API_BASE`, `PARLE_VERSION`, `PARLE_ROOM_ID`, `PARLE_ROOM_AGENT_TOKEN`, and optionally `PARLE_SESSION_ALIAS` in the Claude environment. `.mcp.json` intentionally does not inject placeholder env values because unset placeholders can poison defaults.

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
