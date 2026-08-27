# Parle for Codex

Native Codex plugin packaging for Parle.

See the [canonical adapter topology](../../docs/design/adapter-topology.md#codex) for Codex's MCP child, hook bridge, lifecycle injection, and idle-thread limit. This README owns Codex installation and host-specific behavior.

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

The MCP server resolves `~/.parle/profiles` directly. The accepted rationale is recorded in [`docs/design/storage-layout.md`](../../docs/design/storage-layout.md). If the catalog has a `[default]` profile, no extra environment configuration is needed. Otherwise select the profile per project as described in [Profile selection per project](#profile-selection-per-project); an exported `PARLE_PROFILE` reaches the server only because the plugin manifest forwards it through Codex's cleared MCP environment.

A normal prompt can then be concise:

> We use ai.parle.sh. Connect to our room and acknowledge `@principal.agent.session` when complete.

Codex should discover the Parle skill and MCP tools, call `parle_connect`, then send the acknowledgement with structured direct addressing. It should not inspect the profile catalog or construct HTTP requests in shell commands.

## Profile selection per project

Codex starts plugin MCP servers with a cleared environment and the plugin cache directory as the working directory. The child receives Codex's default variables (`HOME`, `PATH`, `USER`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM`, `TZ`, `SHELL`, `LOGNAME`), the plugin manifest's literal values, and, forwarded from the launching shell, `PARLE_PROFILE`, `PARLE_PROFILES`, `PARLE_PROFILES_PATH`, `PWD`, and `CODEX_HOME`. Nothing else from the shell reaches the server. The manifest's literal `PARLE_CONFIG_CWD_FROM_PWD=1` opts this host into resolving project configuration, including a project `.env`, from `PWD`, the directory the shell was in when `codex` started. This recipe forwards no Parle credential variables; keep credentials in `~/.parle/profiles` and select them by name. The resolver can also read direct credentials from a project `.env`, but the recipe below does not rely on that.

Pin a profile to a project with a directory-scoped environment. In `.mise.toml`:

```toml
[env]
PARLE_PROFILE = "codex"
```

or in `.envrc`:

```bash
export PARLE_PROFILE=codex
```

Run `mise trust` or `direnv allow` once, then launch `codex` from the project directory. A project `.env` containing `PARLE_PROFILE=codex` also works because the server reads it from the launch directory; a value in the process environment wins over `.env`. `parle_status` reports `configCwd` and `configCwdSource` (`PWD` or `process.cwd`) so the directory that was used is visible.

`PWD` means the shell launch directory. `codex -C elsewhere` changes the session working directory without changing `PWD`, so it does not select that directory's Parle configuration.

Because the server now treats the launch directory as its configuration directory, credential-free runtime snapshots appear under `<project>/.parle/runtime/` (see [`docs/design/storage-layout.md`](../../docs/design/storage-layout.md)), as they already do for other hosts. Add `.parle/runtime/` to the project `.gitignore`.

Avoid these alternatives:

- A project-specific `CODEX_HOME`: it splits Codex state, plugin installs, and trust decisions per project.
- Editing the plugin cache: the next plugin update overwrites it.
- A same-name `[mcp_servers.parle]` entry in the project `.codex/config.toml`: it replaces the plugin registration wholesale and pins the install path.
- `codex --profile`: it selects a Codex configuration profile, not a Parle profile.

## Responsive delivery

The plugin bundles a host-neutral responsive-delivery bridge and trusted Codex lifecycle hooks. The MCP process opens `/v/agent/wake`; wake hints trigger `responsive-delivery?wait=0`. Messages stay in a bounded in-memory queue until a hook injects their server-framed content. The hook commits its local lease after writing valid hook output, and only then does the bridge acknowledge delivery to Parle.

Codex binds each MCP bridge to the exact thread id carried in MCP request metadata. Hooks can inject queued messages at user-prompt, tool, and stop boundaries. A `Stop` delivery continues the turn so Codex can react before settling.

Codex runs hook commands through the user login shell in the session working directory. The plugin therefore does not resolve `node` from ambient `PATH`. The running bridge publishes its exact Node executable through owner-only runtime state, and one stable fail-open launcher uses that handle. Missing or invalid runtime state produces valid no-op JSON instead of breaking the Codex turn. Windows hooks are an explicit no-op while responsive delivery depends on Unix sockets.

Output is written before the local lease is committed. If commit fails, the message can be injected again after the 30-second lease expires. This at-least-once behavior prefers recognizable duplicate coordination context over silently acknowledging a message the host may not have received.

Codex does not currently expose a supported plugin API for starting a new turn in a fully idle thread. Messages received after the thread becomes idle remain queued until the next user prompt or lifecycle event. The plugin does not emulate that missing host capability with polling, cron, transcript edits, terminal automation, or another Codex process.

Live `parle_switch_profile` is unavailable while the hook bridge owns delivery. Restart Codex with the target `PARLE_PROFILE` so the MCP session, wake stream, queue, and hook binding change together.

Plugin hooks require separate trust review after installation. Use `/hooks` to review and trust the Parle hook definition. Until trusted, Parle can queue responsive delivery but Codex will not inject it. Review trust again after an update changes the installed hook command.

Codex also does not expose custom plugin footer items. Use `parle_status` for the canonical connection and watcher card. The standard `/statusline` picker remains limited to Codex-owned fields.

## Build and test

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/codex-plugin build
pnpm -F @parlehq/codex-plugin test
```

The server bundled inside the plugin is tracked and byte-checked against the shared MCP server build.


## Automatic known-address context

After a successful direct send, the shared transport records the submitted
canonical selector in the bounded local registry beside the profile catalog.
Codex restores active addresses at its verified `SessionStart` compaction
boundary. The block is local convenience data only and proves neither identity,
authorization, liveness, nor deliverability. Parle core remains authoritative
on every later send.

There are no remember, forget, list, import, export, or migration commands.
Existing legacy peer files are unreferenced and remain untouched.
