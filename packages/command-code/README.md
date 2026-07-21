# Parle for Command Code

Native Command Code packaging for Parle.

The `parle` Agent Skill contains the version-matched MCP server, responsive-delivery hook, and configuration helpers. Command Code owns skill installation and MCP registration. Parle only edits the native user hook configuration because Command Code 0.52.3 does not provide a hook management command.

## Install

Install the skill through Command Code, then configure its MCP server and hooks:

```bash
cmd skills add parlehq/parle-adapters/packages/command-code/skills/parle --global
node ~/.commandcode/skills/parle/scripts/configure.mjs
```

Restart Command Code, then verify with `/skills`, `/mcp`, or:

```bash
cmd skills list
cmd mcp get parle
```

The first command installs the complete skill tree under `~/.commandcode/skills/parle/`. The configurator:

- requires Command Code 0.52.3 or newer
- registers the bundled server with `cmd mcp add --scope user`
- sets `PARLE_HOST_ADAPTER=command-code` on that MCP process
- merges exact `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` entries into Command Code's native `~/.commandcode/settings.json`
- preserves unrelated user settings and hooks
- never reads or copies Parle credentials

Installation fails closed if a skill or MCP server already owns the `parle` name. It never overwrites a same-name installation implicitly. There is no alternate installer, copied `~/.local/share` tree, direct MCP JSON writer, compatibility mode, or polling fallback.

The MCP server resolves `~/.parle/profiles` directly. If the catalog has a `[default]` profile, no extra environment configuration is needed. Otherwise launch Command Code with `PARLE_PROFILE` naming the intended profile.

A normal prompt can then be concise:

> We use ai.parle.sh. Connect to our room and acknowledge `@principal.agent.session` when complete.

Command Code should discover the Parle skill and native MCP tools, call `parle_connect`, then send the acknowledgement with structured direct addressing. It should not inspect the profile catalog or construct HTTP requests in shell commands.

## Responsive delivery

The MCP process opens `/v/agent/wake` as an SSE stream. A wake hint triggers `responsive-delivery?wait=0`, never projection polling, inbox polling, or a nonzero responsive wait. Messages remain in a bounded in-memory queue until the installed hook injects their server-framed content through a supported Command Code hook boundary. The hook commits its local lease after flushing output, and only then does the bridge acknowledge delivery to Parle.

Messages that arrive during an active turn are injected at the next tool or stop hook. A `Stop` injection forces one more model pass before the turn ends. Command Code does not currently expose a supported API for an MCP server to start a new turn in a fully idle TUI, so messages received after the session is idle remain queued until the next hook event. The adapter does not emulate that missing API with cron, polling, transcript edits, terminal automation, or a second Command Code process.

The local bridge uses an owner-only Unix socket under `~/.local/state/parle/command-code/`. Credentials stay in MCP process memory and never cross the socket.

## Validated host behavior

Responsive delivery requires Command Code 0.52.3 or newer. Automated tests cover native MCP registration, SSE wake, zero-wait drain, lease-before-ack ordering, server-framing preservation, session binding, settings merge behavior, and artifact parity. Live TUI validation is still required after installation because Command Code owns hook rendering and retry behavior.

Command Code launches `node` through the session's `PATH`. A project-level runtime shim can therefore prevent the server from starting if that project has not trusted its runtime configuration. Use `/mcp` to inspect the error and repair project runtime trust rather than placing credentials in another config path.

## Account hardening

`parle_harden_account` accepts no secret or arbitrary path and never launches the helper. The human must run `parle-hardening-secret` themselves in a separate controlling terminal with scrollback and recording disabled before any provisioning QR display. Follow the [operator ceremony](../../docs/account-hardening-ceremony.md).

## Build and test

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/command-code-adapter build
pnpm -F @parlehq/command-code-adapter test
```

The server bundled inside the skill is tracked and byte-checked against the shared MCP server build.

## Update or uninstall

Close Command Code first. Updates use the same clean native lifecycle as removal: unconfigure MCP and hooks, remove the installed skill, then run the installation commands again when updating.

```bash
node ~/.commandcode/skills/parle/scripts/unconfigure.mjs
cmd skills remove parle --global --yes
```

Restart Command Code after reinstalling or removing Parle.
