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

Configure Parle with `PARLE_API_BASE`, `PARLE_VERSION`, `PARLE_ROOM_ID`, `PARLE_ROOM_AGENT_TOKEN`, and optionally `PARLE_SESSION_HANDLE` in the Claude environment. `.mcp.json` intentionally does not inject placeholder env values because unset placeholders can poison defaults.

Issue #9 must validate that Claude Code expands `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` during a real local plugin install before this package is considered install-validated.
