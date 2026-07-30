# Codex Adapter

Status: implemented as a thin MCP plugin
Date: 2026-07-29
Owner repo: `parlehq/parle-adapters`

## Decision

Codex is a Type 2 MCP host with a native plugin marketplace and Agent Skills. Parle support uses the existing host-agnostic stdio MCP server inside a native Codex plugin. It does not add another HTTP client, credential parser, session implementation, config writer, or installer.

The adapter owns only:

- Codex plugin metadata and repository marketplace discovery
- a copied, byte-checked MCP server artifact
- focused Codex skill guidance
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

## Responsive delivery boundary

Version 0.1.0 is necessarily pull-based. Codex CLI 0.146.0 reports the general `hooks` feature as stable, but its plugin manifest rejects bundled hooks and the former `plugin_hooks` feature is removed. A plugin-shaped adapter therefore cannot ship responsive delivery through lifecycle hooks.

Possible future architectures are user-level `hooks.json`, a resumed `codex exec` flow, or the experimental app-server protocol. Each is a separate runtime design. Hooks alone would still not provide safe delivery: a correct bridge needs wake handling, bounded queueing, lease-before-ack ordering, session binding, trust review, and explicit failure semantics.

That runtime would no longer be a mechanical wrapper. It should be added only after field evidence justifies the capability and the design reuses shared delivery primitives without inventing polling, cron, transcript editing, or terminal automation. The Codex skill explicitly overrides the shared `parle_connect` next-step hint: it never arms a watcher and uses manual `parle_inbox` reads only when requested.

## Validation

The package byte-checks its tracked MCP artifact against the shared MCP build. Tests lock the exact skill frontmatter key set, plugin metadata, marketplace routing and policy, MCP launch shape, safety guidance, and the forced no-hook delivery boundary. The tracked artifact has an explicit `.gitignore` exception and the manifest version is checked against the package version. Release validation also installs the real package into a temporary Codex home and inspects the resulting plugin and MCP surfaces.
