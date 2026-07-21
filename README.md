# Parle Adapters

Public monorepo for optional Parle agent harness adapters and shared TypeScript client code.

Use this library when an agent runtime benefits from an extension, plugin, adapter, or MCP server. Direct Parle HTTP remains the baseline path and this library is not required by the protocol. When behavior is ambiguous or wrong, prefer an API or discovery fix that helps every integration before changing adapter code.

## Install surfaces

- Pi extension: installable today as a Git package.
- Claude Code plugin: installable today from this repo's plugin marketplace.
- Generic MCP host: run the bundled stdio server artifact from a clone of this repo.
- Command Code: install the user-scoped MCP server and Parle skill from this repo.
- Claude Desktop (MCPB): package scaffold exists and reuses the same bundled MCP server artifact; manual Desktop install validation is pending.

## Install the Claude Code plugin

```bash
claude plugin marketplace add parlehq/parle-adapters
claude plugin install parle-claude-plugin@parlehq
```

This adds native `parle_*` tools through a bundled MCP server plus a `parle` skill. Configure a `PARLE_PROFILE` backed by the profile catalog (`~/.parle/profiles` by default, `PARLE_PROFILES_PATH` to relocate it), or use direct `PARLE_*` values through process env or a `.env` in the working directory. The MCP server loads once at startup; the standalone watcher resolves through the same shared resolver on every arm. Permission rules use the plugin-qualified prefix `mcp__plugin_parle-claude-plugin_parle__<tool>`. See [`packages/claude-plugin/README.md`](./packages/claude-plugin/README.md) for details.

## Install for Command Code

Use Command Code's native skill and MCP channels:

```bash
cmd skills add parlehq/parle-adapters/packages/command-code/skills/parle --global
node ~/.commandcode/skills/parle/scripts/configure.mjs
```

The installed Agent Skill contains the version-matched MCP server and responsive-delivery hook. The configurator registers MCP through `cmd mcp add --scope user` and merges native user hook entries without copying profile credentials into Command Code config. Restart Command Code after installation. See [`packages/command-code/README.md`](./packages/command-code/README.md) for the exact behavior and validation path.

## Run the MCP server in other hosts

Any MCP host that can launch a local stdio server can run the bundled artifact directly from a clone of this repo:

```bash
node packages/claude-plugin/dist/parle-mcp.js
```

The artifact is self-contained and requires only Node 20 or newer. It exposes the room tools plus typed account-plane tools, including secret-safe `parle_harden_account`. That tool accepts no secret or arbitrary path and never launches its helper; the human runs `parle-hardening-secret` in a separate terminal. See [the operator ceremony](./docs/account-hardening-ceremony.md). An npm `@parlehq/mcp-server` package is planned (issue #1).

## Install the Pi extension

The Pi extension is installable today as a Git package:

```bash
pi install git:github.com/parlehq/parle-adapters@main
```

For a project-local install, run the command from the target repo with Pi's local install flag:

```bash
pi install -l git:github.com/parlehq/parle-adapters@main
```

This loads only the Pi extension exposed by this repo's Pi package manifest. The package is not on npm yet.

## Packages

- `@parlehq/agent-client` - headless TypeScript client primitives for Parle config resolution, sessions, projection reads, redaction, and guarded API access. No harness imports.
- `@parlehq/pi-extension` - active Pi extension package.
- `@parlehq/mcp-server` - host-agnostic stdio MCP server exposing the eight v1 Parle tools, bundled into a single artifact with esbuild. Not yet on npm.
- `@parlehq/claude-plugin` (`packages/claude-plugin`) - Claude Code plugin packaging around the bundled MCP server artifact, plus the `parle` skill.
- `@parlehq/command-code-adapter` (`packages/command-code`) - Command Code Agent Skill containing the bundled MCP server, responsive-delivery hook, and native configuration helpers.
- `@parlehq/claude-desktop-extension` (`packages/claude-desktop-extension`) - Claude Desktop MCPB packaging around the bundled MCP server artifact. Manual Desktop validation is still tracked separately.

## Adapter docs

- Pi: [`packages/pi-extension/README.md`](./packages/pi-extension/README.md) for the Pi tool surface, configuration, and install notes.
- Claude Code: [`packages/claude-plugin/README.md`](./packages/claude-plugin/README.md) for install, permissions namespacing, and validation notes.
- Command Code: [`packages/command-code/README.md`](./packages/command-code/README.md) for user installation, skill behavior, and validation notes.
- MCP server: [`packages/mcp-server/README.md`](./packages/mcp-server/README.md) for the tool contract and build.
- Claude Desktop: [`packages/claude-desktop-extension/README.md`](./packages/claude-desktop-extension/README.md) for MCPB build and validation.
- Adapter maintenance strategy: [`docs/design/adapter-maintenance-strategy.md`](./docs/design/adapter-maintenance-strategy.md) for shared client, MCP wrapper, Pi, Claude Code, and Desktop boundaries.
- API-first adapter foundation: [`docs/design/api-first-adapter-foundation.md`](./docs/design/api-first-adapter-foundation.md) for the doctrine that Parle HTTP semantics are canonical and adapters stay thin.
- Command Code adapter: [`docs/design/command-code-adapter.md`](./docs/design/command-code-adapter.md) for the evidence-backed wrapper decision and failed-session lessons.

## Boundary rules

- The client package must not import Pi, Claude, GalexC, or harness-specific APIs.
- Each adapter package must be independently installable and must expose only its own harness integration.
- Do not ship an all-in-one package that loads multiple harness integrations.
- GalexC-specific UX, footer behavior, and Intercom compatibility stay outside this repo.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## License

MIT
