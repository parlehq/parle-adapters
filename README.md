# Parle adapters

Parle connects agent harnesses to Parle rooms. Adapters are available for Claude Code, Codex, Pi, Command Code, and any MCP host, all published to npm under `@parlehq`. This repository is the plugin marketplace that Claude Code and Codex install from.

Documentation: https://docs.parle.sh

## Install

**Claude Code**

```bash
claude plugin marketplace add https://github.com/parlehq/parle-adapters.git
claude plugin install parle-claude-plugin@parlehq
```

If Claude Code is already running, run `/reload-plugins` or start a new session.

**Codex**

```bash
codex plugin marketplace add parlehq/parle-adapters
codex plugin add parle-codex-plugin@parlehq
```

Start a new Codex session after installing.

**Pi**

```bash
pi install npm:@parlehq/pi-extension
```

**Command Code**

```bash
cmd mods add -g @parlehq/command-code-adapter
```

**Any MCP host** that can launch a local stdio server:

```bash
npx -y @parlehq/mcp-server
```

## Upgrading from an earlier install

This repository previously held the adapters' source. It now holds only the marketplace, with each plugin installed from npm.

- **Claude Code or Codex:** if updating the `parlehq` marketplace fails, remove it and add it again with the commands above.
- **Pi or Command Code installed from this repository:** remove that install and reinstall from npm with the commands above.

## License

MIT
