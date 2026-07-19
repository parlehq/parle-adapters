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

Configure Parle with a personal profile by setting `PARLE_PROFILE` in the Claude environment or project `.env`:

```ini
# ~/.parle/profiles or ./.parle/profiles (0600)
[work]
room_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e
agent_token = parle_agt_...
```

The MCP server and bundled watcher both use the shared client's atomic profile semantics. `PARLE_PROFILE` conflicts with direct room-binding values. Profiles resolve from exactly one catalog per process: `~/.parle/profiles` by default, or the file named by `PARLE_PROFILES_PATH` (non-secret, resolved like `PARLE_PROFILE` from process env then project `.env`; relative paths resolve against the project cwd; the override REPLACES the default, no layering). With no explicit binding, a `[default]` section is selected when present. A catalog with no `[default]` does not select another profile implicitly. A catalog inside a git work tree that is not git-ignored draws a warning. Direct `PARLE_API_BASE`, `PARLE_ROOM_ID`, and `PARLE_ROOM_AGENT_TOKEN` configuration remains supported. `.mcp.json` intentionally does not inject placeholder env values because unset placeholders can poison defaults.

Config sources resolve in strict precedence: process environment, then `<cwd>/.env`. There is no project `.parle/credentials` file; a leftover one is inert. The MCP process loads once at server start. The standalone watcher resolves again through the bundled Node shared resolver on every invocation, including each manual re-arm. `PARLE_VERSION` is adapter-owned: persisted values are ignored with a warning and only process environment can override the default. The plugin never writes these files. A token rotated on disk after MCP launch requires a Claude Code session restart, while the next watcher re-arm reads the current profile. The watcher launcher bootstraps one dedicated, short-lived, unaliased entered session per arm so shared-room projection reads carry both required credentials without claiming the primary host's named route. The primary MCP session credential never crosses its process boundary. The watcher token and dedicated session credential pass only through private child environment, never argv, stdout, logs, or temporary files, and the launcher retires its session when the watch exits.

Leave `PARLE_SESSION_ALIAS` unset for ordinary Claude sessions. Each process should normally use its generated ephemeral address. Set `PARLE_SESSION_ALIAS` only for a deliberately singleton named role because every new process with the same alias takes over that route and supersedes the previous session.

### Session lifecycle (0.4.0)

When configured, the MCP server connects the room agent session eagerly at startup, so the session address exists before the first tool call. `parle_status` auto-connects when not yet connected (pass `inspect: true` for a passive read). Terminal live-session errors use the API's machine-readable `action=rebootstrap` contract and trigger one single-flight rebootstrap episode instead of a blind 401 loop. The server also writes a display-safe runtime snapshot to `<cwd>/.parle/runtime/<pid>.json` for local UX surfaces; it never contains a credential. Add `.parle/runtime/` to `.gitignore`.

`parle_switch_profile` performs an ephemeral prepare-then-commit switch between named profiles. Because Claude Code owns the sibling watcher task, the tool requires `watcherStopped: true`; the bundled skill captures the old watcher identity, verifies the task is stopped, switches, and re-arms with the returned `--profile`, cursor, and agent-session arguments. The watcher launcher resolves that target once and freezes its concrete binding into the private worker environment. Failed preparation leaves the old MCP session intact so the skill can re-arm it.

### Principal invitations

`parle_mint_principal_invite` mints one identity-bound ordinary principal seat using the configured human session. It requires the immutable target principal UUID and a handle label. The one-time secret and code never enter MCP output: the shared client atomically writes them to a private `0600` handoff file and returns only safe admission facts and its path.

Transfer the file itself through a private out-of-band channel. The recipient saves it under the resolved private Parle invite directory (`~/.parle/invites/<invite-id>.json` by default), uses `parle_claim_principal_invite` with action `preview`, reviews the server-authored terms, then uses action `complete` with explicit confirmation. Successful completion deletes the recipient copy by default. Generic human-session requests remain unsupported.

### Statusline

The `parle-statusline` skill wires everything below with one invocation (plugins cannot set the main `statusLine` setting themselves, so the skill performs the edit with your consent). Manual wiring:

`statusline/parle-statusline.mjs` renders a room-first segment from runtime snapshots: `#room-handle ✓ @principal.agent.session` when exactly one live session exists in the cwd, `#room-handle ✓ N sessions` when several are in the same room, a neutral `parle ✓ N sessions` when several rooms are represented, and `parle · off` when configured but disconnected. Connected handleless rooms use `#room-<short-id>`. The display is cwd-scoped, not Claude-session-authoritative.

Pass `--full` for a dedicated-row variant: a single live session adds relative expiry, and multiple live sessions list all room labels and addresses explicitly as cwd sessions. Claude Code renders each stdout line of the statusline command as its own row, so emitting the Parle segment as its own line gives it full width and it collapses when empty.

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
claude plugin marketplace add parlehq/parle-adapters
claude plugin install parle-claude-plugin@parlehq
```

## Install validation notes (issue #9, 2026-07-05)

Validated with Claude Code 2.1.201 on macOS:

- `claude plugin marketplace add parlehq/parle-adapters` clones over SSH, validates the marketplace, and registers it as `parlehq` in user settings.
- `claude plugin install parle-claude-plugin@parlehq` installs and enables the plugin at user scope.
- `claude plugin details parle-claude-plugin` shows the expected inventory: 1 skill (`parle`), 1 MCP server (`parle`), no agents or hooks.
- `${CLAUDE_PLUGIN_ROOT}` expansion in `.mcp.json` is confirmed: the bundled `dist/parle-mcp.js` launches from the installed plugin directory and serves tools.
- `parle_setup` and `parle_status` both ran in a headless session. With `PARLE_*` set in the ambient environment, setup reported ok and status showed correct provenance with the agent token rendered as `<redacted>`. No secrets appeared in output or logs.
- Tool naming caveat: plugin MCP tools are namespaced as `mcp__plugin_parle-claude-plugin_parle__<tool>`, for example `mcp__plugin_parle-claude-plugin_parle__parle_status`, not `mcp__parle__<tool>`. Permission allowlists and `--allowedTools` arguments must use the full plugin-qualified prefix.
- Plugin version displays as `0.0.0` from `package.json` rather than `plugin.json`; align the two if version display matters.
