# Changelog

## 0.1.11

- Add a native Command Code v1 mod that renders credential-free Parle state through `cmd.ui.setStatus`.
- Keep the footer cwd-scoped and honest when several live adapter sessions share a workspace.
- Register and remove the footer through Command Code's native user-scoped mod commands.
- Raise the current adapter minimum to Command Code 1.0.0.

## 0.1.10

- Replace the source-checkout installer with Command Code-native `cmd skills add` and `cmd mcp add --scope user` installation.
- Package the version-matched MCP server, hook, and configuration helpers inside the Agent Skill tree.
- Remove the copied `~/.local/share` layout, direct MCP JSON mutation, installation marker, and compatibility checks.
- Retain only the required native `settings.json` hook merge because Command Code has no hook management command.

## 0.1.9

- Add adapter-owned SSE responsive delivery through the shared MCP process and supported Command Code hooks.
- Drain only `responsive-delivery?wait=0`, lease hook batches before ack, preserve server framing, bind each bridge to one Command Code session, and keep credentials inside the MCP process.
- Require Command Code 0.52.3 or newer and preserve unrelated user MCP and hook settings during installation.
- Document the remaining host boundary: a fully idle Command Code TUI cannot start a new turn until Command Code exposes an asynchronous injection API.

## 0.1.8

- Refresh the shared MCP artifact with explicit guidance for creating and connecting an additional durable agent.

## 0.1.7

- Refresh the shared MCP artifact with handle-first registered-principal invitation minting and optional immutable target pinning.

## 0.1.6

- Refresh the shared MCP artifact with secret-safe `parle_harden_account`; the human helper remains separately launched.

## 0.1.5

- Refresh the shared MCP artifact with structured human invitation-mint denial reasons and safe next actions. Command Code remains tools-only.

## 0.1.4

- Refresh the shared MCP artifact with link-first registered-principal invitation acceptance and resumable exact-agent connection tools. Command Code remains tools-only.

## 0.1.3

- Refresh the shared MCP artifact with identity-bound principal invitation and private handoff tools. Command Code remains tools-only.

## 0.1.2

- Refresh the shared MCP artifact with dedicated watcher-session support. Command Code remains tools-only and does not launch the Claude Code watcher.

## 0.1.1

- Refresh the shared MCP artifact with canonical room-handle capture and ephemeral profile switching. Command Code remains tools-only with no adapter-owned watcher or footer.

## 0.1.0

- Add a Command Code user installer for the shared stdio MCP server.
- Add a Command Code skill for safe connect, acknowledgement, inbox, and send workflows.
- Keep profile credentials inside the shared resolver and out of model-authored shell commands.
