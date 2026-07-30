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

## Delivery boundary

This first Codex adapter is necessarily pull-based. Use `parle_inbox` for explicit inbound attention reads. It does not bundle lifecycle hooks or a responsive-delivery bridge.

Codex exposes user-level lifecycle hooks, but the current plugin manifest rejects bundled hooks and the installed CLI reports the former plugin-hooks feature as removed. Safe responsive delivery would also require wake handling, bounded queueing, lease-before-ack ordering, session binding, and explicit failure semantics. That is a separate runtime capability, not mechanical plugin packaging. The adapter does not emulate it with polling, cron, transcript edits, or terminal automation.

## Build and test

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/codex-plugin build
pnpm -F @parlehq/codex-plugin test
```

The server bundled inside the plugin is tracked and byte-checked against the shared MCP server build.
