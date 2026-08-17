# Changelog

## 0.7.19 (2026-08-17)

- Expose first-time onboarding separately from returning login and preserve server-owned privacy guidance without automatic retries.

## 0.7.18 (2026-08-17)

- Present email login starts as privacy-flat accepted requests, preserve the server status as data, and distinguish returning login from first-time onboarding.

## 0.7.17 (2026-08-16)

- Refresh the bundled MCP runtime with opt-in direct-parent hook-bridge correlation for Claude (#118).

## 0.7.16 (2026-08-15)

- Refresh the native runtime with redacted API error details and deduplicated bootstrap-error status reporting (#126, #127).

## 0.7.15 (2026-08-14)

- Refresh the shared responsive-delivery resolver so wake-only helpers do not create false owner conflicts.

## 0.7.14 (2026-08-14)

- Refresh the native Parle runtime with typed local profile deletion and definite adapter response-contract errors (#124, #125).

## 0.7.13 (2026-08-13)

- Refresh the native runtime with shared guarded durable-agent create/delete tools (#122).

## 0.7.12 (2026-08-13)

- Refresh the native runtime with exact-seat preflight for returning-login profile bootstrap and every-room own-agent seat guidance (#121, parlehq/parle#800).

## 0.7.11 (2026-08-12)

- Inherit the shared client's in-place durable alias claim for anonymous live sessions (#115, parlehq/parle#797): a first claim now preserves the session, its participants, its wake stream, and outstanding exact-session opaque reply routes.

## 0.7.10 (2026-08-12)

- Enforce complete core durable-alias validation and refresh the native runtime.

## 0.7.9 (2026-08-12)

- Normalize durable session aliases to the core 2 to 32 character contract and refresh the native runtime.

## 0.7.8 (2026-08-11)

- Bundle target-proof handle-or-email person invitation minting (#113).

## 0.7.7 (2026-08-11)

- Bundle the 2026-08-10 wire default and capability-claim retirement (ADR-0100).

## 0.7.6 (2026-08-11)

- Refresh the native bundle with shared saved-start planning and harness-neutral missing-start errors.

## 0.7.5 (2026-08-11)

- Recover responsive-delivery status after wake-stream disruption: a successful wake reopen now clears the stale error and republishes healthy `watching` evidence instead of retaining the most recent failure.
- Latch terminal wake failures (`reauthorize`, `fix_client`, `stop`) once with a visible host notice naming the recovery action (`parle_setup` / `parle_connect`), so a settled wake loop can never stall silently.
- Recreate the delivery controller when a host `start()` follows `stop()`: a stopped controller is permanently aborted, and reusing it left delivery silently dead; ordinary reconnects and terminal restarts keep the same controller and its dedupe memory, so recovery never opens a duplicate wake loop.

## 0.7.4 (2026-08-11)

- Surface clearer saved-start not-found guidance from the shared client.

## 0.7.3 (2026-08-11)

- Register saved-start and session-alias tools through the native mod and guide ordered opaque next-instruction handling (#107).

## 0.7.2 (2026-08-10)

- Normalize native tool JSON Schemas with an explicit empty `required` list so Command Code can execute tools whose inputs are entirely optional.

## 0.7.1 (2026-08-10)

- Keep headless native tools callable when Command Code has not populated its active-tool list at session startup.

## 0.7.0 (2026-08-10)

- Replace the Command Code skill, MCP registration, settings hooks, helper process, and socket bridge with one native ModApi package.
- Register the shared Parle tool contract directly with `cmd.addTool`, add byte-stable safety guidance, and render native footer status.
- Preserve exact-session baseline skipping and durable alias delivery, keep appended rows deferred through the folded turn commit, and retain unacknowledged work across Command Code session replacement.
- Recover degraded configuration through native active-tool controls, filter unsupported live profile switching, and fail visibly when required ModApi capabilities are absent.

## 0.6.22 (2026-08-10)

- Refresh the bundled MCP runtime with nonblocking hook bridge startup, bounded responsive delivery drains, and correctly rooted runtime evidence.

## 0.6.21 (2026-08-10)

- Refresh the bundled runtime for the `2026-08-09` unified exact-seat admission hard cut.

## 0.6.20 (2026-08-09)

- Refresh the bundled runtime and responsive-delivery reader with session-scoped status evidence and bounded expired runtime record cleanup (#103, #104).

## 0.6.19 (2026-08-08)

- Refresh automatic direct-send enrollment while explicitly leaving context restoration unsupported, and remove the legacy peer helper, startup renderer, status field, and generated copies (#96, #93).

## 0.6.18 (2026-08-08)

- Refresh the bundled MCP runtime with the canonical safe-file foundation (#95).

## 0.6.17 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.6.16 (2026-08-08)

- Refresh the bundled MCP runtime with diagnostics-only degraded boot and in-process recovery after profile repair (#92).

## 0.6.15 (2026-08-08)

- Refresh the bundled MCP runtime for the `2026-08-08` invitation locator hard cut.

## 0.6.14 (2026-08-08)

- Refresh the bundled MCP runtime with HTTP 408 terminal alias release ambiguity handling.

## 0.6.13 (2026-08-07)

- Refresh the bundled MCP runtime with durable alias delivery controls and guarded terminal release that reports ambiguous completion as unknown (#86).

## 0.6.12 (2026-08-07)

- Refresh the shared MCP runtime with credential-free participant snapshot metadata and watcher launch support (#87).

## 0.6.11 (2026-08-07)

- Refresh the embedded MCP runtime with non-exhaustive guidance for every positive held backlog (#81).

## 0.6.10 (2026-08-07)

- Refresh the embedded MCP runtime for current held-backlog status and bounded manual-inbox guidance (#81).

## 0.6.9 (2026-08-07)

- Refresh account bootstrap so hardened email login can continue through TOTP without exposing pending credentials (#84, parle#705).

## 0.6.8 (2026-08-06)

- Refresh responsive delivery for post-open reconciliation, ADR-0059 fallback fetch, and bounded reconnect recovery (#80).

## 0.6.7 (2026-08-06)

- Refresh the bundled MCP runtime and responsive hook for opaque route replies and bounded-interaction warnings (#74).

## 0.6.6 (2026-08-05)

- Refresh the stable-peer hook guidance for current operator-supplied session routes (#78).

## 0.6.5 (2026-08-05)

- Refresh the bundled MCP runtime for the terminal `2026-08-05` wire contract.

## 0.6.4 (2026-08-05)

- Refresh the bundled MCP runtime with hardened, truthful room inventory and login outcome handling.

## 0.6.3 (2026-08-04)

- Refresh the bundled MCP runtime with `parle_rooms` and teach the Command Code skill to keep room inventory sources distinct and principal-private (#685).

## 0.6.2 (2026-08-04)

- Refresh the bundled MCP runtime with canonical routing and attention passthrough plus direct-only responsive guidance (#50).

## 0.6.1 (2026-08-03)

- Refresh the bundled shared client so account login can create an explicitly targeted missing profile without weakening other account operations.

## 0.6.0 (2026-08-03)

- Refresh the bundled MCP server with shared account bootstrap, room creation, and own-agent seat tools (#71).

## 0.5.6 (2026-08-03)

- Refresh the bundled MCP server with the shared wake-open lifecycle callback. Existing Command Code behavior is unchanged.

## 0.5.5 (2026-08-03)

- Refresh the bundled MCP server with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.5.4 (2026-08-03)

- Refresh the bundled MCP server so routine `parle_setup` diagnostics no longer render as tool failures.

## 0.5.3 (2026-08-02)

- Restore parle-peers helper usage docs, clearly labeled as not providing compaction retention on this host.

## 0.5.2 (2026-08-02)

- Explicitly remove #53 stable-peer retention support: shipped Command Code 1.5.0 has no always-before-model or compact boundary, so the per-tool peers flag is dropped from the managed hook command and the capability stays blocked on an upstream host API. SessionStart rendering and the TTY helper remain.

## 0.5.1 (2026-08-02)

- Render peer context on the per-tool boundary as well: shipped Command Code 1.5.0 has no compact-source SessionStart, so PreToolUse re-anchors the first post-compaction tool call, with the residual no-tool-turn gap documented.

## 0.5.0 (2026-08-02)

- Re-anchor operator-tagged stable peer context through the managed SessionStart hook and ship the TTY-only parle-peers helper (#53).

## 0.4.5 (2026-08-02)

- Refresh the bundled MCP server with paced wake reopens and shared-controller delivery policy hooks.

## 0.4.4 (2026-08-02)

- Refresh the bundled MCP server with the shared client's runtime alias switching and host address synthesis.

## 0.4.3 (2026-08-02)

- Refresh the bundled MCP server with room-scoped hook queue keys and restartable delivery after a terminal wake failure.

## 0.4.2 (2026-08-02)

- Refresh the bundled MCP server so eager multi-room bootstrap arms the hook bridge on startup.

## 0.4.1 (2026-08-02)

- Refresh the bundled MCP server for shared-controller hook delivery with preserved lease, fence, and baseline semantics.

## 0.4.0 (2026-08-02)

- Hard cut to snapshot schema v2 in the footer reader; v1 snapshots read as not live.
- Read runtime snapshot schema v2 in the footer reader.
- Refresh the bundled MCP server for alias-aware live profile switching.

## 0.3.2 (2026-08-02)

- Refresh the bundled MCP bridge with authoritative response-scope fencing and committed-claim recovery semantics.

## 0.3.1 (2026-08-02)

- Refresh the bundled MCP bridge with request-start responsive read fencing.

## 0.3.0 (2026-08-02)

- Refresh the bundled MCP runtime for the mandatory 2026-08-01 session lifecycle.
- Follow shared-client session revisions in the responsive hook bridge and preserve alias-scoped redelivery.

## 0.2.7 (2026-08-01)

- Remove vendored Parle contracts and refresh the canonical live-contract MCP artifact.

## 0.2.6 (2026-07-30)

- Honor explicit `advanceCursor: true` on `sinceSeq` reads and preserve unread state on empty explicit commits.
- Explain audit versus commit cursor behavior in MCP and Command Code skill guidance.

## 0.2.5 (2026-07-30)

- Refresh the shared hook bridge with owner-only runtime publication, stale-artifact cleanup, and fail-open hook handling.

## 0.2.4 (2026-07-30)

- Return valid JSON when no responsive delivery is queued so lifecycle hooks complete cleanly.

## 0.2.3 (2026-07-29)

- Report the Command Code adapter name and release separately from the shared MCP runtime for bounded operational attribution.

## 0.2.2 (2026-07-29)

- Tell agents reading the manual inbox to reply with the exact server-authored `author.address` so replies wake the intended peer.

## 0.2.1 (2026-07-29)

- Stop responsive delivery drain after the server repeats the same unacknowledged batch.
- Report active hook bridge errors as `Watcher degraded` in status cards.

## 0.2.0 (2026-07-29)

- Replace the host-name switch with the host-neutral `PARLE_RESPONSIVE_DELIVERY=hook-bridge` capability.
- Consume the shared hook bridge client and owner-only hook-bridge socket namespace.
- Require Command Code alpha installations to update their MCP registration to the new capability contract.

## 0.1.21

- Refresh the shared MCP artifact with stable process request attribution on agent-token JSON and wake traffic.

## 0.1.20

- Refresh the shared MCP artifact with fail-fast Claude watcher launcher argument validation. Command Code runtime behavior is unchanged.
## 0.1.19

- Refresh the shared MCP artifact with honest unknown watcher status and the safe next action `arm or verify the watcher`. Command Code bridge behavior is unchanged.

## 0.1.18

- Register the visible Parle startup notice through the typed mod `onSessionStart` hook so it runs after the Command Code harness binds.
- Delay the notice until the interactive feed is mounted instead of letting startup rendering clear it.
- Clear status polling and pending notices through the matching `onSessionEnd` hook.

## 0.1.17

- Refresh the shared MCP artifact with credential-free Claude watcher request outcome classification. Command Code runtime behavior is unchanged.

## 0.1.16

- Use `https://wake.parle.sh` as the default responsive-delivery endpoint.
- Warn when an explicit wake base suspiciously matches the API base.

## 0.1.15

- Refresh the shared MCP artifact so inaccessible profile catalogs fail closed with actionable access errors instead of raw filesystem exceptions.

## 0.1.14

- Correct the host capability claim: Command Code 1.3.1 exposes footer status APIs but does not render them in the interactive TUI yet.
- Emit one connected-status notice after session start as a visible fallback without repeating it on refresh.
- Keep calling `cmd.ui.setStatus` so native footer rendering activates when Command Code wires the existing contract.

## 0.1.13

- Stop automatic reconnect activity after terminal Parle authentication or client failures while preserving explicit user-paced recovery attempts.
- Keep the terminal cause separate from transient retry state in the bundled shared client.

## 0.1.12

- Keep unexpired runtime snapshots visible when Command Code's sandbox returns `EPERM` for a sibling-process liveness check.
- Continue rejecting missing pids and rely on snapshot expiry when process inspection is permission-blocked.

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
