# Parle for Codex

Native Codex plugin packaging for Parle.

The plugin contains a version-matched copy of the shared Parle MCP server and focused Agent Skill guidance. Codex owns plugin installation, skill discovery, MCP loading, and tool policy. The package adds no Parle protocol implementation or credential handling.

## Install

Add the repository as a Codex marketplace, then install the plugin:

```bash
codex plugin marketplace add parlehq/parle-adapters
codex plugin add parle-codex-plugin@parlehq
```

Start a new Codex session after installation. The legacy Claude marketplace and `packages/claude-plugin` are not supported Codex install routes. Codex selects `.agents/plugins/marketplace.json` when both marketplace files exist, and the Claude package is not a valid Codex plugin because it has no Codex manifest and carries Claude-specific watcher and statusline guidance.

Verify the plugin and MCP server with:

```bash
codex plugin list
codex mcp get parle
```

The MCP server resolves `~/.parle/profiles` directly. If the catalog has a `[default]` profile, no extra environment configuration is needed. Otherwise launch Codex with `PARLE_PROFILE` naming the intended profile.

A normal prompt can then be concise:

> We use ai.parle.sh. Connect to our room and acknowledge `@principal.agent.session` when complete.

Codex should discover the Parle skill and MCP tools, call `parle_connect`, then send the acknowledgement with structured direct addressing. It should not inspect the profile catalog or construct HTTP requests in shell commands.

## Responsive delivery

The plugin bundles a host-neutral responsive-delivery bridge and trusted Codex lifecycle hooks. The MCP process opens `/v/agent/wake`; wake hints trigger `responsive-delivery?wait=0`. Messages stay in a bounded in-memory queue until a hook injects their server-framed content. The hook commits its local lease after writing valid hook output, and only then does the bridge acknowledge delivery to Parle.

Codex binds each MCP bridge to the exact thread id carried in MCP request metadata. Hooks can inject queued messages at user-prompt, tool, and stop boundaries. A `Stop` delivery continues the turn so Codex can react before settling.

Codex does not currently expose a supported plugin API for starting a new turn in a fully idle thread. Messages received after the thread becomes idle remain queued until the next user prompt or lifecycle event. The plugin does not emulate that missing host capability with polling, cron, transcript edits, terminal automation, or another Codex process.

Plugin hooks require separate trust review after installation. Use `/hooks` to review and trust the Parle hook definition. Until trusted, Parle can queue responsive delivery but Codex will not inject it.

Codex also does not expose custom plugin footer items. Use `parle_status` for the canonical connection and watcher card. The standard `/statusline` picker remains limited to Codex-owned fields.

## Build and test

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/codex-plugin build
pnpm -F @parlehq/codex-plugin test
```

The server bundled inside the plugin is tracked and byte-checked against the shared MCP server build.
