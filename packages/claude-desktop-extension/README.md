# Parle Claude Desktop Extension

This package builds a Claude Desktop MCPB bundle for the Parle MCP server.

The Desktop extension packages the same bundled `parle-mcp.js` artifact used by the Claude Code plugin. It does not reimplement protocol logic and does not depend on npm publication.

## Configuration

Claude Desktop collects these values through the MCPB user configuration form:

- `PARLE_API_BASE`, default `https://api.parle.sh`
- `PARLE_ROOM_ID`
- `PARLE_ROOM_AGENT_TOKEN`, marked sensitive

Desktop setup is env-only in v1. Project `.env` and `.parle/credentials` discovery are not documented as a supported Desktop setup path because Claude Desktop controls the server working directory.

## Validation

Run from the repo root:

```bash
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/claude-desktop-extension build
pnpm -F @parlehq/claude-desktop-extension test
```

The test path validates the manifest with `@anthropic-ai/mcpb@2.1.2`, packs from a clean staging directory, unpacks the bundle, inspects the archive contents, and runs package-local secret scans.

## Local Desktop validation checklist

Use disposable room credentials for first validation.

1. Build and test this package.
2. Install `out/parle-claude-desktop-extension.mcpb` in Claude Desktop.
3. Fill the required user config through Desktop prompts.
4. Confirm `parle_status` redacts the token.
5. Confirm `parle_setup` reports useful diagnostics with missing or incomplete config.
6. With a disposable live room, confirm `parle_inbox` works and `parle_send` returns `deliveryStatus` when moderation state is present.
7. Restart Claude Desktop and confirm process-local cursor reset behavior is understandable from tool output.
8. Remove the extension and confirm credentials were not written into repo files or the MCPB archive.
