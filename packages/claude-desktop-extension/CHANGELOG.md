# Changelog

## 0.5.18 (2026-07-20)

Bundled MCP refresh with handle-first registered-principal invitation minting and optional immutable target pinning.

## 0.5.17 (2026-07-19)

Bundled MCP refresh with secret-safe `parle_harden_account` and separate human-only helper guidance.

## 0.5.16 (2026-07-19)

Bundled MCP refresh with structured human invitation-mint denial reasons and safe next actions.

## 0.5.15 (2026-07-19)

Bundled MCP refresh with link-first registered-principal invitation acceptance and resumable exact-agent connection tools.

## 0.5.14 (2026-07-19)

Bundled MCP refresh with identity-bound principal invitation mint, private handoff, preview, and claim tools.

## 0.5.13 (2026-07-19)

Bundled MCP refresh with authenticated dedicated watcher sessions for shared-room projection reads. Desktop remains tools-only and does not launch the Claude Code watcher.

## 0.5.12 (2026-07-19)

Bundled MCP refresh for canonical room-handle capture and ephemeral named-profile switching. Desktop has no sibling watcher, so callers may attest `watcherStopped: true` directly.

## 0.5.10 (2026-07-11)

Bundled MCP refresh clarifying agent-session expiry recovery.

- `rebootstrap` now states that expiry ends only the current session incarnation. `parle_connect` creates a replacement with the still-valid agent token; `reauthorize` remains reserved for invalid or revoked agent tokens.

## 0.5.9 (2026-07-10)

Bundled MCP refresh: `.parle/credentials` removed, `PARLE_PROFILES_PATH` catalog override.

- The shared client no longer reads a project `.parle/credentials` file; profiles resolve from exactly one catalog (`~/.parle/profiles` or the `PARLE_PROFILES_PATH` override), with a warn-only guard when the catalog sits unignored inside a git work tree. Desktop setup remains env-only.

## 0.5.8 (2026-07-10)

Bundled MCP refresh for shared credential-profile resolution. Desktop's documented env-only setup remains unchanged.

## 0.5.7 (2026-07-08)

Bundled MCP refresh: `parle_status` carries the compact card.

- `parle_status` returns `compactText` (connect card plus unread line when live, short not-connected/not-configured cards otherwise) and its description says to render it verbatim. Diagnostic JSON unchanged.

## 0.5.6 (2026-07-08)

Bundled MCP refresh: no spurious PARLE_VERSION override warning.

- The "overriding the adapter default" warning is suppressed when the process-env value equals the adapter default; provenance stays source env. Genuine overrides keep the warning.

## 0.5.5 (2026-07-08)

Bundled MCP refresh so the compact connection card announces itself.

- The `parle_connect` tool description now names `compactText` as the standard card to render verbatim, and the connect result's `next` hint leads with rendering it before the responsive-delivery steps. Lazy session blocks keep the address-and-expiry wording (they carry no card).

## 0.5.4 (2026-07-08)

Bundled MCP refresh for compact connection card frame.

- Refreshes the bundled MCP server so compact connection cards include plain CLI-safe rule lines.

## 0.5.3 (2026-07-08)

Bundled MCP refresh for compact connection card support.

- Refreshes the bundled MCP server so `parle_connect` structured output includes `compactText` for simple operator-facing connection summaries.

## 0.5.2 (2026-07-08)

Bundled MCP refresh for terminal-error-aware client behavior.

- Includes canonical error envelope parsing, single-flight rebootstrap episodes, and refreshed watcher error handling from the shared client and MCP server.

## 0.3.2 (2026-07-07)

Session credential bootstrap fix from the bundled MCP server refresh.

- Agent client session bootstrap preserves the raw `session_credential` only for the create-session response so room entry presents the real `parle_ses_` credential.
- Surfaced errors, status output, and tool results remain redacted.

## 0.3.1 (2026-07-07)

Stale-credential diagnostics (bundled `@parlehq/agent-client` refresh):

- 401 errors append a hint when PARLE_ROOM_AGENT_TOKEN on disk differs from the value the process loaded at startup (token likely rotated; restart the host process to reload it).
- `parle_setup` reports `ok: false` with a `warning` on a stale-vs-disk token; `parle_status` carries the same warning in `warnings`.

## 0.3.0 (2026-07-07)

Wire protocol hard cut (parlehq/parle #436/#437; bundled artifact refresh; behavior shipped in adapters commit 207c8cc without a version bump - this release corrects that):

- Parle-Version 2026-07-07 required; prior version rejected. Pre-cutover sessions invalid; reconnect with parle_connect.
- Secret parle_ses_ session credential selects sessions. Optional PARLE_SESSION_ALIAS claims a durable named route with generation fencing, but should stay unset for ordinary sessions.
- parle_ses_ added to redaction.

## 0.2.0 (2026-07-07)

MCP tool contract change (bundled `@parlehq/mcp-server` artifact refresh):

- New `parle_connect` tool: establishes or reuses the room agent session and returns a redaction-safe connection summary. Idempotent while the session is live.
- Reads and sends that lazily establish a session now include a `session` block identifying the session they created.
- `parle_status` exposes `agentSessionId` (room-visible operational metadata; classification tracked in parlehq/parle#48). `sessionHandle` stays redacted. Optional config values are marked `optional`.
- `parle_setup` reports connection posture (`connected`) and points at `parle_connect`.

Upstream API-first counterparts: parlehq/parle#47, #48, #49.

## 0.1.0

Pre-changelog release; see git history.
