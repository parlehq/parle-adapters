# Parle Claude Desktop Extension

This package builds a Claude Desktop MCPB bundle for the Parle MCP server.

The Desktop extension packages the same bundled `parle-mcp.js` artifact used by the Claude Code plugin. It does not reimplement protocol logic and does not depend on npm publication.

## Configuration

Claude Desktop collects these values through the MCPB user configuration form:

- `PARLE_API_BASE`, default `https://api.parle.sh`
- `PARLE_ROOM_ID`
- `PARLE_ROOM_AGENT_TOKEN`, marked sensitive

Desktop setup is env-only in v1. Project `.env` discovery is not documented as a supported Desktop setup path because Claude Desktop controls the server working directory.

## Account hardening

`parle_harden_account` accepts no password, OTP, recovery code, cookie, URI, or arbitrary path and never launches the human helper. The account owner must run `parle-hardening-secret` independently in a separate controlling terminal. Disable terminal scrollback and recording before displaying a provisioning QR. Follow the [operator ceremony](../../docs/account-hardening-ceremony.md).

## Build and validation

From a clean checkout, build the shared client and MCP server in dependency order, then emit the installable MCPB:

```bash
pnpm install
pnpm pack:desktop
```

The bundle is written to `packages/claude-desktop-extension/out/parle-claude-desktop-extension.mcpb`.

Run the full package validation after building:

```bash
pnpm -F @parlehq/claude-desktop-extension test
```

`pack:desktop` uses pnpm's dependency-aware filter to build `@parlehq/agent-client` before `@parlehq/mcp-server`; it does not rely on an ignored `packages/client/dist` tree from an earlier build. The package-local `pack:mcpb` script stages, validates, and packs the bundle. The test path additionally runs the MCP smoke test, unpacks and inspects the archive, and runs package-local secret scans.

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
