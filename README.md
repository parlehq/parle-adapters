# Parle Agent Adapters

Private pre-release monorepo for Parle agent harness adapters.

This repo will hold separately installable packages for Parle's shared agent client and harness-specific integrations. It is private until the package boundaries and safety posture are ready for public release.

## Packages

- `@parle/agent-client` - headless TypeScript client primitives for Parle agent sessions, projection reads, redaction, and guarded API access.
- `@parle/pi-extension` - Pi extension package. Placeholder only. Extraction has not started.
- `@parle/claude-extension` - Claude integration package. Placeholder only.

## Boundary rules

- The client package must not import Pi, Claude, GalexC, or harness-specific APIs.
- Each adapter package must be independently installable and must expose only its own harness integration.
- Do not ship an all-in-one package that loads multiple harness integrations.
- GalexC-specific UX, footer behavior, and Intercom compatibility stay outside this repo.

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
```

## License

MIT
