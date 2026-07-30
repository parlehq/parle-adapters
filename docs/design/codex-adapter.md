# Codex Adapter

Status: implemented with a host-neutral hook delivery bridge
Date: 2026-07-29
Owner repo: `parlehq/parle-adapters`

## Decision

Codex is a Type 2 MCP host with a native plugin marketplace and Agent Skills. Parle support uses the existing host-agnostic stdio MCP server inside a native Codex plugin. It does not add another HTTP client, credential parser, session implementation, config writer, or installer.

The adapter owns:

- Codex plugin metadata and repository marketplace discovery
- a copied, byte-checked MCP server artifact
- focused Codex skill guidance
- trusted Codex lifecycle-hook packaging
- host-thread binding through Codex MCP request metadata
- install documentation and package-local validation

Parle protocol behavior, profile resolution, redaction, tool schemas, session lifecycle, and API errors remain in Parle core, `@parlehq/agent-client`, and `@parlehq/mcp-server`.

## Evidence

Codex CLI 0.146.0 exposes native Git marketplaces, plugin installation, bundled stdio MCP servers, and Agent Skills. A disposable plugin installed through a temporary `CODEX_HOME` confirmed that:

- `.agents/plugins/marketplace.json` is discovered from a marketplace root
- the plugin manifest, skill, MCP configuration, and server artifact are copied into the Codex plugin cache
- `cwd: "."` resolves to the installed plugin root
- `./dist/parle-mcp.js` resolves as a plugin-relative MCP command argument
- when both root marketplace files exist, Codex selects `.agents/plugins/marketplace.json` and lists only `parle-codex-plugin`
- an explicit marketplace entry pointed at `packages/claude-plugin` is skipped, and installation fails because that package has no Codex manifest

First-party Codex documentation also describes plugin-bundled MCP servers, skills, and separately configured trusted lifecycle hooks:

- <https://developers.openai.com/codex/plugins>
- <https://developers.openai.com/codex/extend/mcp>
- <https://developers.openai.com/codex/build-skills>
- <https://developers.openai.com/codex/hooks>
- <https://developers.openai.com/plugins/build/plugins>

Research used Tavily Search and Tavily extraction. Jina was not used because Tavily returned normal-quality first-party documentation.

## Rejected thinner rival

Reusing `packages/claude-plugin` is not a valid Codex adapter. A live Codex CLI 0.146.0 probe did not list or install that package when an explicit marketplace entry pointed to it because it has no `.codex-plugin/plugin.json`. Even if a future compatibility path accepts it, its Claude-specific watcher, background task, permissions, and statusline guidance would be incorrect in Codex and would violate the narrow host-package boundary.

The dedicated Codex package is therefore the thinnest credible wrapper, not avoidable duplication. It contains only host metadata, one host-appropriate skill, and the shared artifact.

## Installation contract

Users add this repository as a marketplace and install the Codex package:

```bash
codex plugin marketplace add parlehq/parle-adapters
codex plugin add parle-codex-plugin@parlehq
```

The installed `.mcp.json` launches the bundled server from the plugin root. The MCP server resolves the Parle profile catalog directly. No credential value is copied into Codex configuration.

## Responsive delivery

Codex CLI 0.146.0 supports trusted plugin-bundled lifecycle hooks under the stable general `hooks` feature. The removed `plugin_hooks` flag was a former feature gate, not evidence that current plugin hooks are unsupported.

The plugin enables the shared MCP server's host-neutral `hook-bridge` delivery mode. The bridge owns wake SSE handling, zero-wait responsive drain, bounded queueing, lease-before-ack ordering, and failure state. Codex MCP request metadata binds the bridge to the exact Codex thread before lifecycle hooks can take a delivery. Plugin hooks inject server-framed content at user-prompt, tool, and stop boundaries.

The remaining boundary is idle-time initiation. Codex does not expose a supported plugin API for starting a new turn when no lifecycle event is running. Messages that arrive while fully idle remain queued until the next user prompt or hook boundary. The adapter does not invent polling, cron, transcript editing, terminal automation, or a second Codex process to bypass that boundary. A future app-server or remote-control design may close it, but that is a separate trust and lifecycle architecture.

Codex's status line accepts only Codex-owned item identifiers. Plugins cannot register a dynamic footer segment. The canonical supported status surface is `parle_status`, which reports watcher state from the owned bridge.

## Validation

The package byte-checks its tracked MCP and hook artifacts against the shared MCP build. Tests lock the exact skill frontmatter key set, plugin metadata, marketplace routing and policy, MCP launch shape, safety guidance, host-thread binding, hook injection, and lease-before-ack behavior. The tracked artifacts have explicit `.gitignore` exceptions and the manifest version is checked against the package version. Release validation also installs the real package into a temporary Codex home and inspects the resulting plugin, hook, and MCP surfaces.
