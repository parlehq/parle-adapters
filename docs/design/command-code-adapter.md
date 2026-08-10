# Command Code Adapter

Status: native mod implemented
Date: 2026-08-10
Owner repo: `parlehq/parle-adapters`

## Decision

Command Code 1.11.0 or newer receives Parle through one native user-scope mod package.

The mod uses Command Code's ModApi directly for tools, stable guidance, lifecycle integration, session persistence, and footer state. It detects the required ModApi functions at load time and visibly refuses registration when the host lacks them; it does not shell out to infer its own version. Command Code does not receive a Parle Agent Skill, MCP registration, settings hook entries, configurator, helper process, or adapter-owned socket bridge.

Installation is one command:

```bash
cmd mods add -g parlehq/parle-adapters
```

The repository root `commandcode.mods` manifest is the current Git distribution surface. The package manifest exposes the same tracked artifact for local package development. A separately published npm package can replace the root manifest later without changing runtime architecture.

## Why the design changed

The previous adapter was designed and validated against Command Code 0.19.1 and early 1.x behavior. Command Code 1.11.0 provides a materially stronger ModApi:

- `cmd.addTool` registers model-callable tools
- `appendSystemPrompt` adds byte-stable guidance
- `onSessionStart`, `onSessionEnd`, `onTurnStart`, and `onStop` cover the required host lifecycle
- `appendCustomMessageEntry` durably appends model-visible session messages
- `cmd.ui.setStatus` renders live footer segments
- user-scope mods load in interactive and print modes

Those surfaces make the former skill, configured MCP server, settings hooks, and socket bridge unnecessary for this host.

Primary Command Code references:

- <https://commandcode.ai/docs/mods>
- <https://commandcode.ai/docs/hooks>
- <https://commandcode.ai/docs/mcp>

## Shared tool contract

The Parle tool definitions have one source of truth in `packages/mcp-server/src/tool-runtime.ts`.

That host-neutral registration function owns tool names, schemas, descriptions, annotations, handlers, degraded recovery, and error rendering. The MCP server binds it through `server.registerTool`. The Command Code mod binds the same definitions through `cmd.addTool` and converts the Zod object shapes to JSON Schema.

Native Command Code tool names are bare names such as `parle_connect`, `parle_send`, and `parle_reply`. MCP prefixes are not part of this host surface.

## Responsive delivery

The mod constructs the shared `ParleAgentClient` and `ResponsiveDeliveryController` inside the Command Code process. It disables unread polling and uses the canonical wake stream followed by `responsive-delivery?wait=0` drains.

For each responsive row:

1. skip replaced exact-session baseline backlog while preserving durable alias delivery
2. preserve Parle's server framing and reply-route presentation
3. call `appendCustomMessageEntry` on the active Command Code session
4. retain the returned projected message as deferred work for the next `onTurnStart`
5. fold the exact returned object into the agent state so Command Code's persisted message id prevents duplicate session writes
6. call `completeDeferred` only from `onRunEnd`, after the folded turn commits

This preserves append-and-commit-before-ack ordering. A crash or session replacement before completion leaves the row unacknowledged or retained for the replacement turn, which favors at-least-once delivery over silent loss.

If a delivery arrives before an active run ends, `onStop` requests another round. The footer includes pending and baseline-skipped counts through the native status state.

## Idle boundary

Command Code 1.11.0 still has no supported API that starts a new model run in a fully idle TUI. `cmd.queueMessage` queues steering or follow-up input but does not start a run and provides no durable completion point suitable for Parle acknowledgement.

The adapter therefore does not use `queueMessage` as its delivery primitive. An idle delivery is durably appended, remains visible as pending in the footer, and reaches the model on the next run.

The adapter does not emulate idle wake through terminal input, transcript editing, cron, polling, or another Command Code process.

## Status

The mod renders one footer segment through `cmd.ui.setStatus`:

- one connected session: room label, session address, and pending count
- configured but disconnected: `parle · off`
- unconfigured: no segment

The former delayed startup notification was removed because footer status renders in current Command Code.

## Credential boundary

The previous MCP design kept profile credentials in a child process. A native mod necessarily resolves and holds them inside the Command Code process.

Credentials remain outside model context, system guidance, tool schemas, tool output, session messages, footer text, and Command Code settings. The mod never copies credentials into `~/.commandcode`.

This process-boundary change is accepted because native ModApi integration removes the second installation plane and all settings mutation. Redaction remains owned by the shared client.

## Removed surfaces

The native mod replaces and removes:

- `packages/command-code/skills/`
- `configure.mjs` and `unconfigure.mjs`
- Command Code MCP registration
- writes to `~/.commandcode/settings.json`
- `parle-hook.mjs`
- the Command Code copy of `parle-mcp.js`
- the Command Code hook-delivery socket and lease protocol
- the standalone footer mod and startup notice

The generic MCP server and hook bridge remain for hosts that still need them. They are no longer bundled into the Command Code artifact.

## Validation contract

Automated validation must prove:

- root and package manifests expose one native mod
- the mod registers the shared Parle tool set and stable guidance
- replaced exact-session baseline rows are skipped while alias rows remain durable
- responsive rows remain deferred until their folded turn commits
- persisted projected messages survive session replacement and are folded into the next turn
- pending delivery appears in footer state
- the generated mod artifact is reproducible
- no Command Code MCP, skill, settings-hook, or socket-bridge installation surface remains
- type checks and package tests pass

Live validation must prove:

- `cmd mods list` loads the mod without warnings
- footer status renders, updates, and clears
- bare Parle tools work in the TUI
- `cmd -p` exposes the native tools
- connect and direct send complete
- active-run responsive delivery reaches another round
- idle delivery remains pending without a false idle-wake claim
- uninstall leaves `~/.commandcode/settings.json` unchanged

## Research note

The 2026-08-10 review used first-party Command Code 1.11.0 bundled references and public docs. Tavily extracted the public mods, hooks, and MCP pages. Jina was not used. Local CLI and bundled reference inspection resolved version-specific behavior, including rendered status segments and the idle limitation of `queueMessage`.
