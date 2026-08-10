# Parle Adapters

This repository is the public home for Parle agent harness adapters.

## Posture

- Keep package boundaries narrow and explicit.
- Prefer deterministic behavior and fail-closed credential handling.
- Keep the shared client headless. It must not import Pi, Claude, GalexC, or harness-specific APIs.
- Keep each adapter independently installable. Do not create an all-in-one runtime package that loads every harness integration.
- Keep GalexC-specific UX and compatibility glue out of this repo.
- API-first fixes are the default. Before changing an adapter for a bug, ambiguity, or UX problem, ask whether the Parle HTTP API, discovery guidance, OpenAPI schema, or primitive semantics can fix it safely for all clients. Adapter-local fixes are for host UX and packaging, not protocol ambiguity, unless an API-layer fix is not viable. Use `docs/design/api-first-adapter-foundation.md` as the controlling doctrine.
- Version adapter packages whenever a change is more than trivial docs, comments, tests, or internal cleanup. User-visible behavior, packaged artifacts, runtime semantics, config behavior, protocol handling, or installable extension changes require the relevant package version to move in the same commit or an explicitly documented release commit.

## Package map

- `packages/client` - shared Parle agent client primitives (`@parlehq/agent-client`).
- `packages/mcp-server` - host-agnostic stdio MCP server package, bundled to a single artifact.
- `packages/pi-extension` - Pi adapter package.
- `packages/claude-plugin` - Claude Code plugin directory wrapping the bundled MCP server artifact.
- `packages/command-code` - native Command Code mod with direct Parle tools, lifecycle hooks, footer status, and durable responsive delivery.
- `packages/codex-plugin` - Codex plugin wrapping the bundled MCP server artifact and focused Agent Skill guidance.
- `packages/claude-desktop-extension` - Claude Desktop MCPB package wrapping the same bundled MCP server artifact.

After shared client or MCP server changes, run `pnpm refresh:mcp-artifacts` to rebuild canonical source in dependency order, refresh the native Pi and Command Code bundles, and refresh the three tracked MCP wrappers. Run `pnpm check:mcp-artifacts` before committing to verify clean-checkout reproducibility, stale-dist isolation, and divergence detection. Apply the package version and changelog policy below to every installable package whose bundled runtime changed.

## Tooling

- Runtime management: mise.
- Package manager: pnpm.
- Language: TypeScript.

### Test isolation

Adapter tests routinely run inside Parle-enabled harnesses. Child-process fixtures must not inherit ambient `PARLE_*` configuration unless a test explicitly exercises that configuration. Copy the ambient environment, strip every `PARLE_*` key, then apply the fixture's explicit overrides. Do not mutate the parent test process environment globally. Package and root test commands must pass without requiring operators to unset their live Parle configuration first.

Run `pnpm typecheck` before committing TypeScript changes.
