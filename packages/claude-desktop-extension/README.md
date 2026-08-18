# Parle Claude Desktop Extension

This package builds a Claude Desktop MCPB bundle for the Parle MCP server.

The Desktop extension packages the same bundled `parle-mcp.js` artifact used by the Claude Code plugin. It does not reimplement protocol logic and does not depend on npm publication.

## Configuration

Claude Desktop collects these values through the MCPB user configuration form:

- `PARLE_API_BASE`, default `https://api.parle.sh`
- `PARLE_ROOM_ID`
- `PARLE_ROOM_AGENT_TOKEN`, marked sensitive

Desktop connection bootstrap is env-only in v1. Project `.env` discovery is not documented as a supported Desktop setup path because Claude Desktop controls the server working directory. The sensitive room token injected by Desktop remains authoritative for that MCP server process and may be stored by the host in the operating-system credential store.

## Account tools and credential locations

The shared Desktop bundle intentionally exposes the `parle_login`, `parle_create_room`, `parle_create_own_agent`, `parle_delete_own_agent`, `parle_room_participants`, `parle_end_own_session`, and `parle_add_own_agent_seat` account-plane operations plus the local-only `parle_delete_profile` lifecycle tool. These are separate from Desktop connection bootstrap. Credential-persisting `parle_login` operations require `confirmMutation: true` plus a nonempty reason before they can write a protected human-session record and room-bound profile under the resolved `~/.parle` account-state root. They do not replace Desktop's injected room token or change the live Desktop connection automatically.

Desktop therefore has two explicit credential custody locations: host-managed sensitive configuration for the active MCP process, and `~/.parle` only when a user deliberately invokes an account tool that persists credentials. The profile and session files remain available to CLI and coding-harness adapters. See [the accepted storage decision](../../docs/design/storage-layout.md).

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

## Automatic known-address context

Claude Desktop has no supported hook or compaction boundary, so it does not
restore the local known-address registry. The bundled transport may record a
successful direct send for supported coding hosts that share the profile
catalog, but Desktop never injects that registry into model context. Raw MCP
layouts have the same explicit limitation.

No peer-memory commands or status fields are shipped. Existing legacy peer
files are unreferenced and remain untouched. Desktop architecture remains
tracked by issue #97.

## Local Desktop validation checklist

Use disposable room credentials for first validation.

1. Build and test this package.
2. Install `out/parle-claude-desktop-extension.mcpb` in Claude Desktop.
3. Fill the required user config through Desktop prompts using a disposable room token.
4. In Keychain Access, record the item name and service without revealing the credential.
5. Confirm the disposable token is absent from plaintext under `~/Library/Application Support/Claude/`.
6. Confirm the disposable token is absent from `~/Library/Logs/Claude/mcp-server-*.log`.
7. Confirm `parle_status` redacts the token.
8. Confirm `parle_setup` reports useful diagnostics with missing or incomplete config.
9. With a disposable live room, confirm `parle_inbox` works, `parle_send` returns `deliveryStatus` when moderation state is present, and `parle_reply` accepts only a server-issued opaque route.
10. Install an upgraded package and record whether Desktop prompts for the sensitive value again.
11. Rotate the disposable token through the Desktop UI, restart Desktop, and confirm the new process uses the replacement while the revoked token fails.
12. Repeat with `~/.parle/profiles` present and confirm Desktop's injected process environment remains authoritative for that Desktop process.
13. With disposable account credentials, confirm `parle_login` refuses complete and mint operations without `confirmMutation: true` plus a reason, then confirm an explicitly authorized call writes only the expected protected files under `~/.parle`, returns no secrets, and does not replace the live Desktop connection token.
14. Restart Claude Desktop and confirm process-local cursor reset behavior is understandable from tool output.
15. Remove the extension and confirm credentials were not written into repo files or the MCPB archive. Account credentials deliberately persisted under `~/.parle` are independent user state and are not removed with the extension.
16. On Windows, repeat the credential-store checks against Credential Manager. If no Windows host is available, track that validation explicitly rather than claiming coverage.

Never print or paste the disposable token into an issue, log, shell history, or validation transcript. Record only pass or fail evidence and credential-store metadata.
