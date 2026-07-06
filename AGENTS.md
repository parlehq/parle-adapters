# Parle Agent Adapters

This repository is the public home for Parle agent harness adapters.

## Posture

- Keep package boundaries narrow and explicit.
- Prefer deterministic behavior and fail-closed credential handling.
- Keep the shared client headless. It must not import Pi, Claude, GalexC, or harness-specific APIs.
- Keep each adapter independently installable. Do not create an all-in-one runtime package that loads every harness integration.
- Keep GalexC-specific UX and compatibility glue out of this repo.
- API-first fixes are the default. Before changing an adapter for a bug, ambiguity, or UX problem, ask whether the Parle HTTP API, discovery guidance, OpenAPI schema, or primitive semantics can fix it safely for all clients. Adapter-local fixes are for host UX and packaging, not protocol ambiguity, unless an API-layer fix is not viable. Use `docs/design/api-first-adapter-foundation.md` as the controlling doctrine.

## Package map

- `packages/client` - shared Parle agent client primitives (`@parlehq/agent-client`).
- `packages/mcp-server` - host-agnostic stdio MCP server package, bundled to a single artifact.
- `packages/pi-extension` - Pi adapter package.
- `packages/claude-plugin` - Claude Code plugin directory wrapping the bundled MCP server artifact. The tracked `dist/parle-mcp.js` is copied from the mcp-server build; rebuild with `pnpm -F @parlehq/mcp-server build && pnpm -F @parlehq/claude-plugin build` after server changes.
- `packages/claude-desktop-extension` - Claude Desktop MCPB package wrapping the same bundled MCP server artifact. The tracked `server/parle-mcp.js` is copied from the mcp-server build; rebuild with `pnpm -F @parlehq/mcp-server build && pnpm -F @parlehq/claude-desktop-extension build` after server changes.

## Tooling

- Runtime management: mise.
- Package manager: pnpm.
- Language: TypeScript.

Run `pnpm typecheck` before committing TypeScript changes.
