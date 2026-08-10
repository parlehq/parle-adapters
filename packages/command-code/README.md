# Parle for Command Code

Native Command Code mod packaging for Parle.

The package contributes one user-scope mod. That mod registers the Parle tools with `cmd.addTool`, adds stable safety guidance with `appendSystemPrompt`, renders connection state with `cmd.ui.setStatus`, and owns responsive delivery through Command Code lifecycle and session persistence APIs.

It does not install an Agent Skill, register an MCP server, edit Command Code settings, spawn hook helpers, or create adapter-owned socket state.

## Install

Install the repository mod and restart Command Code:

```bash
cmd mods add -g parlehq/parle-adapters
```

Verify the installation:

```bash
cmd mods list
```

The repository root manifest points Command Code at the tracked native mod artifact. The package manifest exposes the same artifact for local package development.

## Runtime behavior

The mod targets Command Code 1.11.0 or newer and verifies the specific ModApi capabilities it needs. Missing capabilities produce a visible refusal instead of a PATH-dependent version probe.

- `cmd.addTool` for the shared Parle tool definitions
- `appendSystemPrompt` for byte-stable host guidance
- `onSessionStart` and `onSessionEnd` for responsive-delivery lifecycle
- `appendCustomMessageEntry` for durable server-framed message injection
- `onTurnStart` to fold persisted deliveries into the active agent state
- `onStop` to continue an active run when delivery arrived before natural completion
- `cmd.ui.setStatus` for connection and pending-delivery state

The tool names are native and unprefixed, such as `parle_connect`, `parle_send`, and `parle_reply`.

The mod uses the same host-neutral tool registration function as the MCP server. Schemas, descriptions, handlers, degraded recovery, and safety behavior therefore have one source of truth.

## Responsive delivery

The mod opens the Parle wake stream through the shared client. A wake hint triggers `responsive-delivery?wait=0`. For each row, the mod:

1. skips replaced exact-session baseline backlog while preserving durable alias delivery
2. appends a server-framed custom message to the Command Code session
3. retains the returned projected message as deferred work for the next agent round
4. folds that exact projected object into `onTurnStart`
5. acknowledges the Parle row through `completeDeferred` only after the run commits and reaches `onRunEnd`

A process exit or session replacement before that completion leaves the row unacknowledged. Deferred work is retained for a replacement Command Code session, and Parle can redeliver after a process loss. This favors at-least-once delivery over silent loss.

A message arriving during a run is folded into the next round. `onStop` keeps a naturally finishing run alive when pending delivery exists. Command Code 1.11.0 still has no supported API that starts a new model run in a fully idle TUI. An idle delivery is persisted and shown in the footer as pending, then reaches the model on the next run. The mod does not emulate idle wake with terminal automation, transcript edits, cron, polling, or another Command Code process.

## Credentials

The native mod resolves Parle configuration inside the Command Code process. Credentials are never added to model context, Command Code settings, tool schemas, tool output, or session messages. This differs from the former MCP child-process boundary and is an explicit consequence of using Command Code's native in-process ModApi.

Use the profile catalog at `~/.parle/profiles` by default. `PARLE_PROFILES_PATH` relocates it and `PARLE_PROFILE` selects a named profile.

## Build and test

```bash
pnpm -F @parlehq/command-code-adapter build
pnpm -F @parlehq/command-code-adapter typecheck
pnpm -F @parlehq/command-code-adapter test
```

The tracked `mods/parle.ts` file is a dependency-free esbuild artifact. The artifact check rebuilds it in a temporary directory and compares bytes.

Live validation should confirm:

- `cmd mods list` reports the mod without warnings
- the footer appears and clears correctly
- native Parle tools are available in interactive and print modes
- connect and direct send complete through the native tools
- responsive delivery remains deferred until the folded turn commits
- pending idle delivery is visible without claiming that a run started

## Update or uninstall

Update configured mod sources with:

```bash
cmd mods update
```

Remove the integration with:

```bash
cmd mods remove parle
```

Removal does not edit `~/.commandcode/settings.json` because installation never writes that file.
