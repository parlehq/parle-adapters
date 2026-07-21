# @parlehq/command-code-adapter

Command Code packaging for Parle.

This package bundles the shared `@parlehq/mcp-server` artifact, a Command Code-native Parle skill, and user-scoped hooks for SSE responsive delivery. Protocol behavior and credentials stay inside `@parlehq/agent-client` and the MCP process.

## Install for the current user

From a clone of this repository:

```bash
pnpm -F @parlehq/command-code-adapter install:user
```

The installer:

- copies the self-contained MCP artifact to `~/.local/share/parle/command-code/parle-mcp.js`
- copies the skill to `~/.commandcode/skills/parle/SKILL.md`
- copies an owner-only hook helper to `~/.local/share/parle/command-code/parle-hook.mjs`
- registers the `parle` stdio server in Command Code user scope with `PARLE_HOST_ADAPTER=command-code`
- merges managed `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` hook entries while preserving unrelated settings
- injects no token or profile value into Command Code configuration
- refuses to replace a different existing `parle` MCP entry or unmanaged skill
- requires Command Code 0.52.3 or newer for the documented hook contract

If MCP registration fails after the copies complete, rerunning the installer is safe. It will reuse identical files and retry registration. A different existing skill or MCP entry remains a fail-closed manual decision.

The MCP server resolves `~/.parle/profiles` directly. If the catalog has a `[default]` profile, no additional environment configuration is needed. Otherwise launch Command Code with `PARLE_PROFILE` naming the intended profile.

Restart Command Code after installation, then verify with `/mcp` or:

```bash
cmd mcp get parle
```

A normal prompt can then be concise:

> We use ai.parle.sh. Connect to our room and acknowledge `@principal.agent.session` when complete.

Command Code should discover the Parle skill and native MCP tools, call `parle_connect`, then send the acknowledgement with structured direct addressing. It should not inspect the profile catalog or construct HTTP requests in shell commands.

## Responsive delivery

The MCP process opens `/v/agent/wake` as an SSE stream. A wake hint triggers `responsive-delivery?wait=0`, never projection polling, inbox polling, or a nonzero responsive wait. Messages remain in a bounded in-memory queue until the installed hook helper injects their server-framed content through a supported Command Code hook boundary. The helper then commits its local lease, and only then does the bridge acknowledge delivery to Parle.

Messages that arrive during an active turn are injected at the next tool or stop hook. A `Stop` injection forces one more model pass before the turn ends. Command Code does not currently expose a supported API for an MCP server to start a new turn in a fully idle TUI, so messages received after the session is idle remain queued until the next hook event. The adapter does not emulate that missing API with cron, polling, transcript edits, terminal automation, or a second Command Code process.

The local bridge uses an owner-only Unix socket under `~/.local/state/parle/command-code/`. Credentials stay in MCP process memory and never cross the socket.

## Validated host behavior

The original tools-only path was validated on Command Code 0.19.1. Responsive delivery requires Command Code 0.52.3 or newer because that release line provides the supported user hook contract used for injection. Automated tests cover SSE wake, zero-wait drain, lease-before-ack ordering, server-framing preservation, session binding, settings merge behavior, and artifact parity. Live TUI validation is still required after installation because Command Code owns hook rendering and retry behavior.

Command Code launches `node` through the session's `PATH`. A project-level runtime shim can therefore prevent the server from starting if that project has not trusted its runtime configuration. Use `/mcp` to inspect the error and repair the project runtime trust rather than placing credentials in another config path.

## Account hardening

`parle_harden_account` accepts no secret or arbitrary path and never launches the helper. The human must run `parle-hardening-secret` themselves in a separate controlling terminal with scrollback and recording disabled before any provisioning QR display. Follow the [operator ceremony](../../docs/account-hardening-ceremony.md).

## Build and test

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/command-code-adapter build
pnpm -F @parlehq/command-code-adapter test
```

The copied MCP artifact is tracked and byte-checked against the shared server build.

## Uninstall

Remove only the managed MCP entry, hook entries, skill, and installed files while preserving unrelated Command Code settings:

```bash
pnpm -F @parlehq/command-code-adapter uninstall:user
```
