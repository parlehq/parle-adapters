# Parle Agent Adapters

This repository is the private pre-release home for Parle agent harness adapters.

## Posture

- Keep package boundaries narrow and explicit.
- Prefer deterministic behavior and fail-closed credential handling.
- Keep the shared client headless. It must not import Pi, Claude, GalexC, or harness-specific APIs.
- Keep each adapter independently installable. Do not create an all-in-one runtime package that loads every harness integration.
- Keep GalexC-specific UX and compatibility glue out of this repo.

## Package map

- `packages/client` - shared Parle agent client primitives.
- `packages/mcp-server` - host-agnostic MCP server package.
- `packages/pi-extension` - Pi adapter package.
- `packages/claude-plugin` - Claude Code plugin directory. Current scaffold still has `packages/claude-extension` and should be renamed before real Claude work starts.

## Tooling

- Runtime management: mise.
- Package manager: pnpm.
- Language: TypeScript.

Run `pnpm typecheck` before committing TypeScript changes.
