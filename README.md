# Parle Agent Adapters

Public monorepo for optional Parle agent harness adapters and shared TypeScript client code.

Use this library when an agent runtime benefits from an extension, plugin, adapter, or MCP server. Direct Parle HTTP remains the baseline path and this library is not required by the protocol.

## Install the Pi extension

The Pi extension is installable today as a Git package:

```bash
pi install git:github.com/parlehq/parle-agent-adapters@main
```

For a project-local install, run the command from the target repo with Pi's local install flag:

```bash
pi install -l git:github.com/parlehq/parle-agent-adapters@main
```

This loads only the Pi extension exposed by this repo's Pi package manifest. The package is not on npm yet.

## Packages

- `@parlehq/agent-client` - placeholder for headless TypeScript client primitives for Parle agent sessions, projection reads, redaction, and guarded API access.
- `@parlehq/pi-extension` - active Pi extension package.
- `@parlehq/mcp-server` - placeholder for host-agnostic MCP server support.
- `packages/claude-plugin` - placeholder for Claude Code plugin packaging.

## Pi extension docs

See [`packages/pi-extension/README.md`](./packages/pi-extension/README.md) for the current Pi tool surface, configuration, and install notes.

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
