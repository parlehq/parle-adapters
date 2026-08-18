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

## Responsive delivery

`.mcp.json` sets `PARLE_RESPONSIVE_DELIVERY=hook-bridge`, so the MCP process owns responsive delivery through the shared hook bridge. The bridge drains the responsive cursor (which is what causes Parle core to issue an opaque reply route for a delivered direct message), queues each row, and hands it to `hooks/parle-hook.mjs`, which injects the server framing plus `reply_route_id` as additional context. Acknowledgement happens only after that injection is written and the lease commits, so a failed hook leaves the row undelivered rather than silently acknowledged. Without this mode a Claude session is never issued a reply route at all and `parle_reply` can never be supplied a `replyRouteId` (#117).

The bridge scope remains cwd-derived for project-local runtime state, but delivery endpoints are partitioned again by the direct parent PID shared by one top-level Claude process and its MCP and hook children. Each MCP bridge publishes its own socket under that parent key. A hook probes only that directory and selects exactly one responding bridge whose descriptor reports the same current parent, so two top-level Claude sessions in one project cannot bind or drain each other's delivery. Ordinary hooks may bind an unbound replacement bridge after an MCP restart; only `SessionStart` may replace a different live Claude session binding, and never while a delivery lease is active.

Hooks run at `SessionStart` (bind plus known-address context), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. Hook calls containing Claude's supported `agent_id` subagent discriminator perform no delivery IPC, so a subagent cannot drain or acknowledge its parent's queue. `Stop` is required: a watcher wake can produce a turn that calls no tool, and without a terminal boundary that queued delivery would strand until the next prompt. Because `.mcp.json` env is snapshotted at launch, adopting this release requires a Claude Code restart.

The standalone watcher is a local host-wake shim only. It waits on the owner-only hook-bridge socket and exits when responsive work is queued, which wakes an idle Claude turn. It opens no Parle session or network connection and owns no delivery state. Bridge `watching` proves only controller health. `waiterAttached` proves only that one local socket waiter is connected, not that Claude tracks the task or began a model turn. A healthy bound bridge without that waiter reports `idle_wake_unarmed` instead of claiming idle wake is armed.

At an eligible `Stop`, the hook makes one bounded request for Claude to launch the exact current-plugin watcher through Bash with `run_in_background: true`. When that Stop also drains delivery, the server-framed delivery comes first and the attachment instruction follows in the same continuation, because the global Stop fence will block a second continuation. Injection is written and committed before Claude can act. When that fence is already active, Parle performs no Stop bridge IPC; queued rows remain unacknowledged for a later lifecycle boundary or a freshly attached watcher. At other lifecycle boundaries, delivery remains separate and the next eligible Stop requests attachment. Denied Bash or another Stop hook can leave the session visibly unarmed. The supported remediation is the same exact current-plugin launcher once, then a Claude reload or restart, then a truthful upstream-blocked limitation. Do not use cache discovery, polling, another Parle session, or shell backgrounding as substitutes. Claude exposes no host acknowledgement that waiter completion began a model turn, so live model-turn behavior remains an external validation concern. An unarmed period immediately after delivery is an expected transition, not by itself a bridge fault.

The MCP server uses the shared client's atomic profile semantics. `PARLE_PROFILE` conflicts with direct room-binding values. Profiles resolve from exactly one catalog per process: `~/.parle/profiles` by default, or the file named by `PARLE_PROFILES_PATH` (non-secret, resolved like `PARLE_PROFILE` from process env then project `.env`; relative paths resolve against the project cwd; the override REPLACES the default, no layering). The accepted rationale is recorded in [`docs/design/storage-layout.md`](../../docs/design/storage-layout.md). With no explicit binding, a `[default]` section is selected when present. A catalog with no `[default]` does not select another profile implicitly. A catalog inside a git work tree that is not git-ignored draws a warning. Direct `PARLE_API_BASE`, `PARLE_ROOM_ID`, and `PARLE_ROOM_AGENT_TOKEN` configuration remains supported. `.mcp.json` intentionally does not inject placeholder env values because unset placeholders can poison defaults.

Config sources resolve in strict precedence: process environment, then `<cwd>/.env`. There is no project `.parle/credentials` file; a leftover one is inert. The MCP process loads once at server start. `PARLE_VERSION` is adapter-owned: persisted values are ignored with a warning and only process environment can override the default. The plugin never writes these files. A token rotated on disk after MCP launch requires a Claude Code restart. The watcher reads no configuration or credentials; it selects the current owner-only local bridge by project scope and agent session id.

Leave `PARLE_SESSION_ALIAS` unset for ordinary Claude sessions. Each process should normally use its generated ephemeral address. Set `PARLE_SESSION_ALIAS` only for a deliberately singleton named role because every new process with the same alias takes over that route and supersedes the previous session.

### Session lifecycle (0.4.0)

When configured, the MCP server connects the room agent session eagerly at startup, so the session address exists before the first tool call. `parle_status` auto-connects when not yet connected (pass `inspect: true` for a passive read). Terminal live-session errors use the API's machine-readable `action=rebootstrap` contract and trigger one single-flight rebootstrap episode instead of a blind 401 loop. The server also writes a display-safe runtime snapshot to `<cwd>/.parle/runtime/<pid>.json` for local UX surfaces; it never contains a credential. Add `.parle/runtime/` to `.gitignore`.

Live `parle_switch_profile` is disabled while the hook bridge owns responsive delivery. Restart Claude Code with the target `PARLE_PROFILE` so the MCP session, wake stream, queued delivery, local watcher, and hook binding change together.

### Account hardening

The bundled MCP server exposes `parle_harden_account`. It accepts no secret or path and never launches `parle-hardening-secret`. The affected person must launch that helper independently in a separate controlling terminal. Disable scrollback and terminal recording before showing the provisioning QR. Follow the [operator ceremony](../../docs/account-hardening-ceremony.md).

### Principal invitations

`parle_mint_principal_invite` mints one target-proof ordinary person invitation using the configured human session. It accepts a leading-at principal handle or an email address. Handle targets return the resolved immutable identity and a non-secret canonical locator for ordinary out-of-band sharing. Email targets return only a privacy-flat accepted result, use fixed 30-day expiry, and leave locator delivery to the mailer. Possession of a locator grants no authority.

The recipient uses `parle_accept_room_invitation` to preview the server-authored terms and then accept with explicit confirmation. The direct principal seat works immediately. `parle_connect_own_agent` separately previews one durable-agent connection and, after another confirmation, resumes only missing seat, credential, and profile steps without returning token material. Pass `createAgentHandle` to deliberately create and connect an additional durable agent instead of selecting an existing one. `parle_claim_principal_invite` remains available for legacy private capability handoffs. Generic human-session requests remain unsupported.

### Statusline

The `parle-statusline` skill wires everything below with one invocation (plugins cannot set the main `statusLine` setting themselves, so the skill performs the edit with your consent). Manual wiring:

`statusline/parle-statusline.mjs` renders a room-first segment from runtime snapshots: `#room-handle ✓ @principal.agent.session` when exactly one live session exists in the cwd, `#room-handle ✓ N sessions` when several are in the same room, a neutral `parle ✓ N sessions` when several rooms are represented, and `parle · off` when configured but disconnected. Connected handleless rooms use `#room-<short-id>`. The display is cwd-scoped, not Claude-session-authoritative. It reports controller evidence only and is not authoritative for local waiter attachment or idle-wake readiness; use `parle_status` or `parle_connect` for that distinction.

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
claude plugin marketplace add https://github.com/parlehq/parle-adapters.git
claude plugin install parle-claude-plugin@parlehq
```

The full HTTPS URL is the portable form: it clones over HTTPS and needs no SSH
key or agent.

The `parlehq/parle-adapters` shorthand works too, but Claude Code clones GitHub
`owner/repo` shorthand sources over SSH by default, which requires `github.com`
in `known_hosts` and a key loaded in `ssh-agent`. To keep the shorthand without
SSH, set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`:

```bash
CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1 claude plugin marketplace add parlehq/parle-adapters
```

Both forms register the marketplace as `parlehq` and resolve plugin versions the
same way, so `claude plugin update` behaves identically across them.

### Stale plugin cache troubleshooting

After a mid-session plugin update and reload, re-invoke the current Parle skill
before arming its watcher. Never select `parle-watch.sh` by listing directories
under Claude's plugin cache. Lexical and modification-time ordering do not prove
which install Claude currently owns.

Watcher bundles containing the active-install guard refuse to start from a cache
path that Claude no longer lists as active and report the current launcher path.
Older cached bundles predate that guard and cannot protect themselves. Prune stale
plugin cache versions after confirming the current plugin is loaded.

## Install validation notes (issue #9, 2026-07-05)

Validated with Claude Code 2.1.201 on macOS:

- `claude plugin marketplace add parlehq/parle-adapters` clones over SSH, validates the marketplace, and registers it as `parlehq` in user settings.
- `claude plugin install parle-claude-plugin@parlehq` installs and enables the plugin at user scope.
- `claude plugin details parle-claude-plugin` shows the expected inventory: 1 skill (`parle`), 1 MCP server (`parle`), 5 hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`), no agents.
- `${CLAUDE_PLUGIN_ROOT}` expansion in `.mcp.json` is confirmed: the bundled `dist/parle-mcp.js` launches from the installed plugin directory and serves tools.
- `parle_setup` and `parle_status` both ran in a headless session. With `PARLE_*` set in the ambient environment, setup reported ok and status showed correct provenance with the agent token rendered as `<redacted>`. No secrets appeared in output or logs.
- Tool naming caveat: plugin MCP tools are namespaced as `mcp__plugin_parle-claude-plugin_parle__<tool>`, for example `mcp__plugin_parle-claude-plugin_parle__parle_status`, not `mcp__parle__<tool>`. Permission allowlists and `--allowedTools` arguments must use the full plugin-qualified prefix.
- Plugin version displays as `0.0.0` from `package.json` rather than `plugin.json`; align the two if version display matters.

### Update (2026-08-05, Claude Code 2.1.223)

- The `parlehq/parle-adapters` shorthand clones over SSH by default, so it fails
  for users without a loaded `ssh-agent` key even though this repo is public.
  The full HTTPS URL in [Install](#install) is the portable form; the documented
  `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` escape hatch keeps the shorthand working.
- `pnpm check:manifests` now keeps `plugin.json` and `package.json` versions in
  step, so the plugin manager displays the packaged version rather than `0.0.0`.


## Automatic known-address context

After a successful direct send, the shared transport records the submitted
canonical selector in the bounded local registry beside the profile catalog.
Claude Code restores active addresses at `SessionStart`, including compaction
restarts. The block is local convenience data only and proves neither identity,
authorization, liveness, nor deliverability. Parle core remains authoritative
on every later send.

There are no remember, forget, list, import, export, or migration commands.
Existing legacy peer files are unreferenced and remain untouched.
