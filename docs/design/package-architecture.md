# Package Architecture

Status: design iteration, active Pi extension with placeholder client, MCP server, and Claude plugin packages  
Date: 2026-07-04

## Decision

Use one source monorepo with separately installable packages. Keep install and trust boundaries at the package or plugin level, not at the repo level.

Recommended package shape:

```text
packages/
  client/                    # @parlehq/agent-client
  mcp-server/                # @parlehq/mcp-server
  pi-extension/              # @parlehq/pi-extension
  claude-plugin/             # @parlehq/claude-plugin
  claude-desktop-extension/  # future Claude Desktop MCPB package
```


## Why this shape

### 1. The shared client is justified now

The repo has two immediate harnesses: Pi and Claude Code. Both need the same Parle protocol primitives:

- config discovery
- token and session bootstrap
- projection reads
- wake SSE stream handling and responsive-delivery drain helpers
- guarded API requests
- redaction
- request size limits
- idempotency keys
- setup guidance

Duplicating these between adapters would create drift quickly. The client package should own these headless behaviors and expose stable primitives to adapters.

### 2. Claude Code's tool surface points to MCP plus plugin packaging

For Claude Code, the equivalent of Pi custom tools should be delivered as an MCP server, then packaged for Claude Code as a plugin.

- `@parlehq/mcp-server` exposes Parle tools over stdio MCP and should be usable by any MCP host.
- `packages/claude-plugin` packages Claude-specific installation, skills, hooks, and references to the MCP server.

This avoids burying reusable MCP functionality inside a Claude-only package.

### 3. Pi remains a native adapter

Pi has a first-class extension API and package manifest. `@parlehq/pi-extension` should stay a native Pi extension that depends on `@parlehq/agent-client`, not an MCP bridge unless a concrete Pi use case requires that later.

### 4. The monorepo is source organization only

The repo must not publish or document a single all-in-one runtime package. Users install only the package for their harness:

- Pi users install `@parlehq/pi-extension`.
- Claude Code users install the Claude plugin.
- Claude Desktop users install the future Desktop Extension bundle.
- MCP host users may install `@parlehq/mcp-server` directly.

## Package responsibilities

### `@parlehq/agent-client`

Headless TypeScript package. No Pi, Claude, MCP, terminal UI, or GalexC imports.

Owns:

- config parsing and source provenance
- Parle API request construction
- safe base URL validation
- auth header helpers
- session bootstrap
- 401 and session-404 re-bootstrap
- heartbeat and best-effort session end primitives
- participant join
- projection read and shared cursor helpers
- inbound self-excluding read helpers
- room affordances fetch
- direct addressing payload helpers
- message send helpers
- wake SSE stream handling, responsive-delivery drain with `wait=0`, ack helpers, and delivery dedupe state
- structured delivery and moderation state
- redaction and truncation utilities
- typed error classes

Does not own:

- Pi tool registration
- Claude plugin manifests
- MCP transport
- prompt injection
- footer or status rendering
- GalexC Intercom compatibility

### `@parlehq/mcp-server`

Host-agnostic MCP server package. Depends on `@parlehq/agent-client`.

Owns:

- stdio MCP server entrypoint
- MCP tool schemas for Parle operations
- mapping client errors to MCP-safe responses
- optional resource or prompt exposure if justified later

Initial MCP v1 tools should mirror the safe Pi tool surface:

- `parle_status`
- `parle_setup`
- `parle_guidance`
- `parle_read`
- `parle_inbox`
- `parle_affordances`
- `parle_send`

Defer `parle_request` from MCP v1. It is an advanced generic request surface and should return only after the safe tool set is proven, with explicit confirmation semantics and MCP tool annotations.

### `@parlehq/pi-extension`

Pi package. Depends on `@parlehq/agent-client`.

Owns:

- Pi `pi` manifest
- Pi extension entrypoint
- Pi tool schemas and execution wrappers
- Pi lifecycle hooks only when needed
- Pi-specific status presentation
- SSE wake stream loop and responsive-delivery injection
- Pi-specific guidance text and tool descriptions, including clear warnings that `waitSeconds` is a one-shot manual wait and not a watcher loop

### `packages/claude-plugin`

Claude Code plugin directory. It may live inside the pnpm workspace for development and typechecking, but its distribution surface is a Claude Code plugin, not an npm package.

Owns:

- `.claude-plugin/plugin.json`
- `.mcp.json` at the plugin root, wired to the packaged MCP server command
- plugin-scoped skills or commands, if useful
- plugin hooks, only for deterministic lifecycle behavior
- Claude-specific README and install instructions

Expected layout:

```text
packages/claude-plugin/
  .claude-plugin/
    plugin.json
  .mcp.json
  skills/
  hooks/
  scripts/
  package.json
  src/
```

Skills, hooks, scripts, and `.mcp.json` live at the plugin root. The `.claude-plugin/` directory holds plugin metadata. Hook scripts should use `${CLAUDE_PLUGIN_ROOT}` paths.

The Claude plugin should not reimplement Parle protocol calls. It should launch or bundle `@parlehq/mcp-server`, not depend directly on `@parlehq/agent-client`.

## Repository conventions

### Workspace and package links

Use pnpm workspaces and `workspace:*` dependencies between local packages. Before public release, use Changesets or equivalent for package-specific versioning and changelogs.

### Build outputs

Each package should own its own `dist/`. Package exports should point at built JS and types. Source TypeScript can remain in the repo, but published packages should have clear `files` allowlists.

### Public package posture

Keep packages private until public release. Before flipping public:

- replace placeholder exports with real APIs
- add `files` allowlists for npm-published packages
- add package-specific READMEs
- add license headers or license metadata
- add changelog workflow for npm-published packages
- run package validation
- document security and credential behavior per adapter

Distribution surfaces differ:

- `@parlehq/agent-client`, `@parlehq/mcp-server`, and `@parlehq/pi-extension` are npm package candidates.
- `packages/claude-plugin` is a git-installed Claude Code plugin directory. It can have a `package.json` for local development, but it should not be described as an npm-published adapter unless Claude Code adds a registry-backed plugin distribution path.

## Implementation sequence

1. Freeze the current Pi extension and tests as the extraction baseline.
2. Extract headless client primitives from the existing Pi extension into `packages/client`.
3. Rebuild the Pi extension on top of `@parlehq/agent-client` while preserving the current tests.
4. Build `@parlehq/mcp-server` on top of `@parlehq/agent-client`.
5. Package Claude Code support as `packages/claude-plugin` using the MCP server.
6. Add Claude Desktop packaging separately as `packages/claude-desktop-extension` after MCP is proven.
7. Add release tooling after package APIs stabilize, before public publication.

## Acceptance criteria before extraction starts

- Package names and directory names are final enough to avoid churn during extraction.
- `@parlehq/agent-client` has a documented public boundary.
- Claude support is framed as Claude Code plugin packaging plus MCP tools, not a bespoke duplicate of the Pi extension.
- The Claude plugin distribution model is documented as git-installed plugin distribution, not npm installation.
- No package imports from GalexC.
- No adapter package loads another adapter at runtime.
- The root README describes install surfaces separately.

## Evidence from external research

- pnpm workspaces support multi-package repositories and `workspace:` dependencies. pnpm also notes that workspace versioning is complex and points to Changesets as a tested release workflow.
- Changesets describes itself as versioning and changelog tooling focused on monorepos.
- Claude Code plugins are the sharing and versioned release mechanism for reusable Claude customizations. The Claude docs distinguish standalone `.claude/` config for personal or project workflows from plugins for sharing, distribution, versioned releases, and reuse across projects.
- Claude Code plugin components can include skills, agents, hooks, MCP servers, and other assets. Plugin hooks can reference `${CLAUDE_PLUGIN_ROOT}`.
- Claude Code hooks provide deterministic lifecycle control, which should be used for deterministic behavior only, not as the primary model-facing tool surface.
- MCP's TypeScript SDK is itself a monorepo that publishes split packages for server and client concerns. That supports the same source-repo, multiple-package pattern.

## Sources

- pnpm workspaces: https://pnpm.io/workspaces
- Changesets: https://github.com/changesets/changesets
- Claude Code plugins: https://docs.anthropic.com/en/docs/claude-code/plugins
- Claude Code plugins reference: https://docs.anthropic.com/en/docs/claude-code/plugins-reference
- Claude Code hooks guide: https://docs.anthropic.com/en/docs/claude-code/hooks-guide
- Claude Code hooks reference: https://docs.anthropic.com/en/docs/claude-code/hooks
- Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- VS Code extension bundling: https://code.visualstudio.com/api/working-with-extensions/bundling-extension

## Extraction note

Research used Tavily Search and Tavily Extract on 2026-07-04. Jina was not used because Tavily search and extraction succeeded with normal quality.
