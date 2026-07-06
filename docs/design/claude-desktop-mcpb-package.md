# Claude Desktop MCPB Package Design

Status: implementation-ready design, current MCPB schema verified
Date: 2026-07-06
Issues: #10, #11
Depends on: #6, #7, #8, #9
Related docs: `claude-adapter-update-plan.md`, `claude-operational-adapter.md`, `package-architecture.md`

## Objective

Add a Claude Desktop Extension package that installs Parle room tools into Claude Desktop through the same bundled MCP server artifact used by the Claude Code plugin.

The Desktop package should be safe to share, easy to inspect, and independent of npm publication. It should validate and pack as an MCPB archive, expose only explicit user configuration fields, mark agent credentials as sensitive, and prove local Desktop behavior with `parle_status` and `parle_setup` before release.

## Non-goals

- Do not add new Parle MCP tools for Desktop.
- Do not implement a Desktop background watcher or responsive delivery loop.
- Do not publish npm packages as part of Desktop work.
- Do not add an all-in-one adapter package.
- Do not store persistent cursor state in project files or user config.
- Do not include development workspace state, local credentials, or unrelated dependency trees in the MCPB archive.

## Package shape

Add a new workspace package only after MCP server smoke tests and Claude Code local plugin validation are green:

```text
packages/claude-desktop-extension/
  manifest.json
  README.md
  package.json
  scripts/
    copy-mcp-artifact.mjs
    check-mcp-artifact.mjs
    inspect-pack.mjs
    secret-scan.mjs
  server/
    parle-mcp.js
```

`server/parle-mcp.js` is a copied artifact from `packages/mcp-server/dist/parle-mcp.js`. The Desktop package does not import `@parlehq/agent-client` and does not rebuild protocol code. It packages and launches the existing MCP server.

The package should stay narrow:

- `packages/mcp-server` owns MCP tool behavior.
- `packages/claude-plugin` owns Claude Code plugin packaging.
- `packages/claude-desktop-extension` owns MCPB manifest, user config, archive checks, and Desktop validation notes.

## Runtime shape

Claude Desktop launches a local Node MCP server from inside the MCPB bundle.

Proposed runtime contract:

- Server type: Node local server.
- Entrypoint: bundled `server/parle-mcp.js`.
- Runtime requirement: Node 20 or newer. The MCPB `compatibility.runtimes.node` field supports this directly, so the manifest should declare `">=20"`. Keep the README requirement as backup for hosts that ignore compatibility metadata.
- Transport: stdio MCP.
- Tool surface: exactly the seven v1 MCP tools already exposed by `@parlehq/mcp-server`.

Desktop remains pull-only in v1. Users check `parle_inbox` at natural turn boundaries. Responsive delivery rows may accumulate for a bootstrapped Desktop session until a read surface drains visible room state. A Desktop watcher or companion app is separate follow-up work and must use the Parle wake stream, not polling loops.

## Manifest shape

Use the current MCPB schema supported by the selected CLI. Confirm the exact field names before implementation with the CLI validation command and upstream manifest reference.

The manifest should express this schema-verified shape, based on MCPB manifest version `0.3`:

```json
{
  "manifest_version": "0.3",
  "name": "parle-claude-desktop-extension",
  "display_name": "Parle",
  "version": "0.1.0",
  "description": "Claude Desktop extension for Parle room tools through a bundled local MCP server",
  "author": {
    "name": "Parle"
  },
  "compatibility": {
    "runtimes": {
      "node": ">=20"
    }
  },
  "server": {
    "type": "node",
    "entry_point": "server/parle-mcp.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/parle-mcp.js"],
      "env": {
        "PARLE_API_BASE": "${user_config.parle_api_base}",
        "PARLE_ROOM_ID": "${user_config.parle_room_id}",
        "PARLE_ROOM_AGENT_TOKEN": "${user_config.parle_agent_token}"
      }
    }
  },
  "tools_generated": true,
  "user_config": {
    "parle_api_base": {
      "type": "string",
      "title": "Parle API base",
      "description": "Parle API base URL. Keep the default unless using an approved local development setup.",
      "default": "https://api.parle.sh",
      "required": true
    },
    "parle_room_id": {
      "type": "string",
      "title": "Parle room id",
      "description": "Room id from the Parle room settings or setup flow. V1 requires a room id rather than a room handle.",
      "required": true
    },
    "parle_agent_token": {
      "type": "string",
      "title": "Parle agent token",
      "description": "Agent-scoped Parle room token. Claude Desktop should store this sensitive value securely.",
      "required": true,
      "sensitive": true
    }
  }
}
```

This example is implementation-ready for the verified MCPB `0.3` schema. During implementation, keep `mcp_config` nested under `server`, keep `author.name`, and validate the exact file with the pinned MCPB CLI before packing.

## Sensitive config fields

Required user fields:

- `parle_api_base`: default `https://api.parle.sh`; passed through the shared safe host policy.
- `parle_room_id`: required for v1. Use room id instead of handle unless handle resolution is proven available without human session auth.
- `parle_agent_token`: required and marked `sensitive: true`.

Optional user fields:

- `parle_room_handle`: defer unless the client can resolve handles safely with agent-token auth.

Do not add a Desktop-only default read limit. The MCP server already owns per-call `limitMessages` handling and caps; Desktop should not introduce unsupported env configuration.

Do not expose config for arbitrary remote hosts. Local development hosts remain behind the existing `PARLE_ALLOW_INSECURE_LOCAL=1` opt-in and should not appear in the default Desktop manifest.

Desktop configuration is env-only in v1. Although the shared client can also resolve `.env` and `.parle/credentials`, a Desktop-launched server has an unpredictable working directory, so project-file discovery is not a supported Desktop setup path and should not appear in Desktop docs.

Sensitive handling rules:

- Never hardcode a token or room id in `manifest.json`, README examples, tests, or validation notes.
- Validation notes may include redacted values only.
- `parle_status` and `parle_setup` must redact token provenance and must work without leaking raw user config.
- Scripts must scan both manifest and packed archive contents before any artifact is shared.

## Bundled MCP artifact strategy

Reuse the existing MCP server artifact pipeline rather than building a second bundle.

Proposed scripts:

- `copy-mcp-artifact.mjs`: copy `packages/mcp-server/dist/parle-mcp.js` to `packages/claude-desktop-extension/server/parle-mcp.js` after verifying source exists and is non-empty.
- `check-mcp-artifact.mjs`: byte-compare the Desktop copy against `packages/mcp-server/dist/parle-mcp.js` and fail if stale.
- `inspect-pack.mjs`: inspect a packed MCPB archive against allowlist and denylist rules.
- `secret-scan.mjs`: run a local secret scan over package inputs and the packed archive extraction directory.

`server/parle-mcp.js` should be tracked like the Claude Code plugin artifact, then byte-checked against `packages/mcp-server/dist/parle-mcp.js`. The MCPB spec says Node extensions bundle dependencies in `node_modules` and typically include `package.json`; Parle intentionally ships a single esbuild output with no external runtime dependencies, so staging must not add `node_modules` or package manager files just to mirror generic examples. Packing should happen from a clean staging directory, not directly from the workspace package directory. The staging step copies exactly the validated manifest, README, `server/parle-mcp.js`, and any required license notices into a temporary package-local directory before running MCPB pack. This avoids pnpm workspace symlinks, local `node_modules`, and package-directory spillover by construction.

## Build and validation gates

Desktop work should add package-local gates and wire them into the root gate after review:

```text
pnpm -F @parlehq/mcp-server build
pnpm -F @parlehq/claude-desktop-extension build
pnpm -F @parlehq/claude-desktop-extension typecheck
pnpm -F @parlehq/claude-desktop-extension test
```

Package-local scripts should cover:

- MCP artifact exists and is byte-identical to the MCP server build output.
- MCPB manifest validates with the selected CLI.
- MCPB pack produces an archive.
- Archive inspection passes.
- Secret scan passes across package inputs, staging contents, extracted archive contents, and the bundled server artifact.

Do not make the root build depend on Desktop MCPB packing until the MCPB CLI command and runtime behavior are stable enough for CI.

## MCPB validate and pack gates

Implementation should pin or document the selected MCPB CLI invocation in package scripts. The exact command is a pre-implementation confirmation item because MCPB CLI shape has changed over time.

Required behavior:

1. Validate `manifest.json` before packing.
2. Pack only from an explicit clean staging directory built from allowlisted inputs.
3. Write staging and packed artifacts under gitignored package-local output directories such as `packages/claude-desktop-extension/out/`.
4. Fail if the packed archive includes anything outside the allowlist.
5. Fail if a secret scan finds high-confidence credentials.

The package should not pack from the repository root or directly from the workspace package directory.

## Archive inspection design

Use an allowlist first, then denylist checks as defense in depth.

Expected archive contents:

- `manifest.json`
- `README.md` if MCPB packaging supports bundled docs
- `server/parle-mcp.js`
- Any license or notices file required by bundled dependencies

Explicitly forbidden contents:

- `.env`
- `.parle` or `.parle/credentials`
- `.galexc`
- `.claude`
- `.pi`
- `.agents`
- `.git`
- `node_modules`
- root workspace caches
- package manager stores
- lockfiles unless the MCPB spec requires one
- local Desktop or Claude config files
- test credentials
- any file outside `packages/claude-desktop-extension`

Inspection should also verify:

- archive is deterministic enough for review, or at least stable in content list
- `server/parle-mcp.js` exists and is non-empty
- no source maps reference local filesystem paths if source maps are ever included
- no package scripts or config files can cause Desktop to execute unrelated workspace commands

## Secret scanning design

Use two layers:

1. Static denylist and pattern scan in a small repo script for package-specific forbidden names and obvious credential formats.
2. A standard scanner such as `gitleaks` if available in CI or developer environments.

The package-specific scan should cover:

- source package directory before packing
- staging directory
- extracted packed archive
- manifest JSON
- README and validation notes
- bundled `server/parle-mcp.js` artifact

High-confidence findings fail the gate. Lower-confidence findings should be printed with file path and redacted excerpt for manual review.

## Local Claude Desktop validation plan

Use test credentials or a disposable room. Do not use a personal production room for first validation.

Manual validation checklist:

1. Build the MCP server artifact.
2. Copy the artifact into the Desktop package.
3. Validate the manifest with the selected MCPB CLI.
4. Pack the MCPB archive from the staging directory.
5. Run archive inspection and secret scan, including the bundled `server/parle-mcp.js` artifact.
6. Install the MCPB archive in Claude Desktop.
7. Fill user config through Desktop prompts, with an agent token marked sensitive.
8. Confirm unset or empty optional user config fields do not arrive as literal `${user_config...}` placeholders. They should arrive as absent or empty values only.
9. Start a new Claude Desktop chat.
10. Confirm the Parle server appears in Desktop MCP settings.
11. Call `parle_status` with configured test credentials and confirm raw token is not shown.
12. Call `parle_setup` with missing or intentionally incomplete config and confirm diagnostics are useful and redacted.
13. If using a disposable live room, call `parle_inbox` and `parle_send` with an idempotency key and direct addressing to a test target, and assert `deliveryStatus` appears in the send result.
14. Restart Claude Desktop and confirm that process-local cursor reset behavior is understandable from tool output.
15. Remove the test extension and confirm no credentials were written into repo files or the MCPB archive.

Capture validation notes in the package README or a dedicated package-local validation note before release. Use redacted excerpts only.

## Implementation sequence

1. Confirm MCPB CLI install and current manifest schema.
2. Confirm Node runtime compatibility fields for Claude Desktop MCPB.
3. Wait for #6 and #7 MCP server completion to merge, then build Desktop against that refreshed artifact once.
4. Add `packages/claude-desktop-extension` workspace package.
5. Add manifest and package scripts.
6. Add artifact copy and stale-check scripts.
7. Add staging-directory MCPB validate and pack scripts.
8. Add archive inspection script with allowlist and denylist checks.
9. Add secret scan script and optional `gitleaks` integration.
10. Add README with Desktop install, setup, status check, and troubleshooting.
11. Run local Desktop validation with disposable credentials.
12. Update root README and release gates after validation succeeds.

## Acceptance criteria

Issue #10 is ready when:

- `packages/claude-desktop-extension` exists and is independently packageable.
- MCPB manifest validates with the selected CLI.
- MCPB pack creates an archive from a clean staging directory populated with allowlisted package-local inputs.
- The bundle launches the same `parle-mcp.js` artifact as the generic MCP and Claude Code surfaces.
- Agent token config is marked sensitive.
- Desktop package does not depend on npm publication.

Issue #11 is ready when:

- Pack inspection is automated enough to fail on forbidden files.
- Secret scanning runs before a Desktop artifact is shared.
- Local Desktop validation notes prove `parle_status` and `parle_setup` work without manual JSON editing.
- Validation notes contain no raw credentials.
- Release docs distinguish Desktop from Claude Code plugin and generic MCP host usage.

## Open decisions before implementation

1. Exact pinned MCPB CLI package/version to use in package scripts.
2. Whether room handle support is agent-token compatible. If not, v1 should require room id only.
3. Which secret scanner should be mandatory in CI versus optional locally.

## Review Summary

Mode: converge
Artifact: Claude Desktop MCPB package design for #10 and #11

### Consensus

- Desktop should package, not reimplement, the existing MCP server artifact.
- The Desktop manifest must pass `PARLE_ROOM_AGENT_TOKEN`, not an unsupported token env var.
- Room id plus sensitive agent token is the safe v1 configuration baseline.
- Desktop should not expose a default read limit env var because the MCP server owns per-call read limits.
- Validation and pack inspection are part of the product surface, not release cleanup.
- Desktop should remain pull-only in v1 and inherit the MCP server tool behavior.
- Pack from a clean staging directory, while tracking and byte-checking `server/parle-mcp.js` like the Claude Code plugin artifact.

### Divergence

- None after adversarial review edits. The artifact tracking versus staging-only concern is resolved as tracked artifact plus staging-directory packing.

### Blockers

- Resolved: MCPB manifest schema uses `manifest_version: "0.3"`, requires `author.name`, and nests `mcp_config` under `server`.
- Resolved: Node compatibility belongs in `compatibility.runtimes.node`, so the manifest should declare `>=20`.
- Medium: Room handle resolution may require human auth. Require room id in v1 unless agent-token handle resolution is proven.

### Stability Assessment

Converging after adversarial review. Remaining blockers are pre-implementation validation items, not architecture changes.

### Verdict

Implementation-ready. Current MCPB schema and Node compatibility field have been confirmed; remaining open items are implementation choices and live Desktop validation.

### Recommended Next Step

Implement the package scaffold and validation scripts using a pinned `@anthropic-ai/mcpb` CLI invocation. Before any push, request a separate LGTM gate from the collaborator.
