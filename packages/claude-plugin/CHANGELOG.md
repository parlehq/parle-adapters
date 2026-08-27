# Changelog

## 0.9.68 (2026-08-27)

- Refresh the bundled MCP artifact to server 0.7.63 and client 0.8.54, which add Codex queue idle wake behind the `PARLE_HOST_IDLE_WAKE=codex-queue` manifest literal and the shared hook's `--shell-launched` flag; this host sets neither, so its bridge binding, hooks, and rendering are unchanged (#174).

## 0.9.67 (2026-08-27)

- Refresh the bundled MCP artifact to server 0.7.62, which adds the credential-free `identity` checkpoint to `parle_connect` and connected `parle_status` results and the no-identity-switch guidance for a missing profile. The skill's direct-HTTP fallback now has a narrow exception: when setup reports the requested profile is not in the catalog, report the identity/configuration problem and stop instead of falling back to direct HTTP or the default identity (#172).

## 0.9.66 (2026-08-27)

- Refresh the bundled MCP artifact to server 0.7.61 and client 0.8.53, which carry the generic idle-wake status state for hosts without an arm action; this host has an idle-wake launcher and does not set `PARLE_HOST_IDLE_WAKE`, so its rendering is unchanged (#171).

## 0.9.65 (2026-08-27)

- Refresh the bundled MCP artifact to server 0.7.60 and client 0.8.52, which reword the `waitSeconds` tool guidance and connect `next` guidance to defer any operator-authorized attended hold to the host skill; this host's skill and idle-wake watcher are unchanged (#170).

## 0.9.64 (2026-08-27)

- Refresh the bundled MCP artifact to server 0.7.59, which carries opt-in launch-directory configuration; this host does not enable it, so configuration resolution is unchanged (#169).

## 0.9.63 (2026-08-31)

- Refresh the bundled MCP runtime with fallback deadline and stage evidence from the shared responsive-delivery controller (#80).

## 0.9.62 (2026-08-23)

- Carry the bounded room reads of client 0.8.50 through the refreshed MCP artifact (parlehq/parle#927).

## 0.9.61 (2026-08-21)

- Recover from a server-ended exact session even when hook delivery was pending or leased (#161).

## 0.9.60 (2026-08-20)

- Keep responsive delivery active after a target-specific send or reply failure (#160).

## 0.9.59 (2026-08-19)

- Add content-free responsive-delivery stage evidence through hook bridge queue readiness (#880).

## 0.9.58 (2026-08-18)

- Expose additive responsive-delivery acknowledgement evidence while preserving fetch liveness (#157).

## 0.9.57 (2026-08-18)

- Publish the complete #156 room-recovery diagnostic fix under a unique Claude plugin version.

## 0.9.56 (2026-08-18)

- Clear recovered room diagnostics without masking active failures in other responsive-delivery domains (#156).

## 0.9.55 (2026-08-18)

- Allow a slow successful delivery acknowledgement to finish inside Claude's bounded hook window instead of reporting a contradictory local timeout (#151).

## 0.9.54 (2026-08-18)

- Deliver Stop-boundary messages and idle-wake instructions as non-error hook context instead of Claude's misleading `Stop hook error` rendering.

## 0.9.53 (2026-08-18)

- Restore one bounded current-plugin waiter attachment at eligible Stop boundaries while preserving delivery precedence, truthful unarmed status, and no bridge IPC after Claude's Stop fence is active (#151).

## 0.9.52 (2026-08-18)

- Clean definitively stale local bridge artifacts at startup and stop orphaned MCP children after Claude parent correlation is lost (#149).

## 0.9.51 (2026-08-18)

- Bundle the typed first-time onboarding tool and server-owned email-start guidance.

## 0.9.50 (2026-08-17)

- Keep concurrent legacy-socket cleanup from aborting watcher attachment (#133).

## 0.9.49 (2026-08-17)

- Restore resilient watcher attachment across stale or unreachable hook-bridge socket candidates (#133).

## 0.9.48 (2026-08-17)

- Refresh the bundled MCP runtime with preview-first room capacity recovery and stronger exact-session safety guidance (#144).

## 0.9.47 (2026-08-17)

- Bundle the 2026-08-17 wire version required by the canonical error-contract hard cut (parlehq/parle#810).

## 0.9.46 (2026-08-17)

- Republish the merged #132 and #140 Claude bundle under a unique version after the concurrent releases shared 0.9.45; runtime behavior is unchanged from main.

## 0.9.45 (2026-08-17)

- Report hook-bridge socket startup failures as terminal instead of claiming responsive delivery is armed (#132).
- Refresh the bundled MCP runtime with room-participant inventory and guarded own-session ending for stale-session capacity recovery (#140).

## 0.9.44 (2026-08-17)

- Preserve healthy hook-bridge `watching` evidence across plain status calls (#120).

## 0.9.43 (2026-08-17)

- Refresh the bundled account client with honest conditional email login start guidance.

## 0.9.42 (2026-08-16)

- Isolate responsive delivery by top-level Claude process, suppress subagent delivery IPC, recover an unbound bridge after MCP restart, and correct the documented ownership guarantee (#118).

## 0.9.41 (2026-08-15)

- Preserve redacted API error details and stop presenting bootstrap history twice as current runtime health (#126, #127).

## 0.9.40 (2026-08-15)

- Replace the dedicated projection long-poll watcher with an owner-only local hook-bridge wait. Claude now wakes only after the existing SSE-driven responsive controller queues target work, with no second Parle session, network watcher, copied relevance filter, or nonzero recurring wait.

## 0.9.39 (2026-08-14)

- Stop reporting a delivery conflict when the persistent hook bridge and expected wake-only standalone watcher are both active for one Claude session.

## 0.9.38 (2026-08-14)

- Refresh the bundled MCP runtime with degraded-safe local profile deletion and definite adapter response-contract errors (#124, #125).

## 0.9.37 (2026-08-13)

- Refresh the bundled MCP runtime with shared guarded durable-agent create/delete tools (#122).

## 0.9.36 (2026-08-13)

- Refresh the bundled MCP runtime with exact-seat preflight for returning-login profile bootstrap and every-room own-agent seat guidance (#121, parlehq/parle#800).

## 0.9.35 (2026-08-13)

- Correct skill guidance that 0.9.34 left false: enabling the hook bridge makes `parle_switch_profile` fail closed, because the MCP session, wake stream, delivery queue, and hook binding must change atomically. The skill documented the retired live stop-switch-re-arm sequence as if it still worked. Changing profile now means restarting Claude Code with the target `PARLE_PROFILE`.
- Restate the skill description: this host receives routed replies; it does not switch profiles live.

## 0.9.34 (2026-08-13)

- Own responsive delivery through the bundled hook bridge (#117). `.mcp.json` sets `PARLE_RESPONSIVE_DELIVERY=hook-bridge` with a cwd-derived scope, and hooks run at `SessionStart` (bind plus known-address context), `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`. Draining the responsive cursor is what causes core to issue an opaque reply route, so before this release a Claude session was never issued one and `parle_reply` could never be supplied a `replyRouteId`.
- Keep the standalone watcher as wake-only infrastructure. It polls projection on a dedicated unaliased session and never touches the responsive cursor, so it cannot double-drain or double-acknowledge alongside the bridge.
- Stop presenting `parle_inbox` as the delivery path in skill guidance. It is an attention read that carries no reply route; injected deliveries are the only route-bearing surface on this host.
- Requires a Claude Code restart: `.mcp.json` environment is snapshotted at launch.

## 0.9.33 (2026-08-12)

- Inherit the shared client's in-place durable alias claim for anonymous live sessions (#115, parlehq/parle#797): a first claim now preserves the session, its participants, its wake stream, and outstanding exact-session opaque reply routes.

## 0.9.32 (2026-08-12)

- Refresh the bundled MCP runtime with complete core durable-alias validation.

## 0.9.31 (2026-08-12)

- Refresh the bundled MCP runtime with the 2 to 32 character durable session-alias contract.

## 0.9.30 (2026-08-11)

- Bundle target-proof handle-or-email person invitation minting and update operator guidance (#113).

## 0.9.29 (2026-08-11)

- Bundle the 2026-08-10 wire default and capability-claim retirement (ADR-0100).

## 0.9.28 (2026-08-11)

- Document the canonical `/parle start` namespace and refresh the MCP bundle with shared saved-start planning.

## 0.9.27 (2026-08-11)

- Surface clearer saved-start not-found guidance from the bundled MCP server.

## 0.9.26 (2026-08-11)

- Add saved-start guidance and refresh the MCP bundle with local start management and live session aliases (#107).

## 0.9.25 (2026-08-10)

- Refresh the bundled MCP runtime with the shared native tool registry and stable setup guidance.

## 0.9.24 (2026-08-10)

- Refresh the bundled MCP runtime with nonblocking hook bridge startup, bounded responsive delivery drains, and correctly rooted runtime evidence.

## 0.9.23 (2026-08-10)

- Refuse watcher launches from inactive Claude plugin cache paths and document safe recovery after mid-session plugin reloads.

## 0.9.22 (2026-08-10)

- Refresh the bundled runtime for the `2026-08-09` unified exact-seat admission hard cut.

## 0.9.21 (2026-08-09)

- Refresh the bundled runtime and responsive-delivery reader with session-scoped status evidence and bounded expired runtime record cleanup (#103, #104).

## 0.9.20 (2026-08-08)

- Restore bounded known-address context at Claude Code `SessionStart`, refresh automatic direct-send enrollment, and remove the legacy peer helper, renderer, status field, and generated copies (#96, #93).

## 0.9.19 (2026-08-08)

- Refresh the bundled MCP runtime with the canonical safe-file foundation (#95).

## 0.9.18 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.9.17 (2026-08-08)

- Refresh the bundled MCP runtime with diagnostics-only degraded boot and in-process recovery after profile repair (#92).

## 0.9.16 (2026-08-08)

- Refresh the bundled MCP runtime for the `2026-08-08` invitation locator hard cut.

## 0.9.15 (2026-08-08)

- Refresh the bundled MCP runtime with HTTP 408 terminal alias release ambiguity handling.

## 0.9.14 (2026-08-07)

- Refresh the bundled MCP runtime with durable alias delivery controls and guarded terminal release that reports ambiguous completion as unknown (#86).

## 0.9.13 (2026-08-07)

- Clarify that Claude's pre-channels projection watcher and manual inbox cannot expose opaque reply routes, and that withheld author identity never authorizes an unaddressed fallback.

## 0.9.12 (2026-08-07)

- Prevent privacy-flat own room-wide sends from waking Claude, including across verified primary-session rollover (#87).

## 0.9.11 (2026-08-07)

- Refresh the embedded MCP runtime with non-exhaustive guidance for every positive held backlog (#81).

## 0.9.10 (2026-08-07)

- Refresh the embedded MCP runtime for current held-backlog status and bounded manual-inbox guidance (#81).

## 0.9.9 (2026-08-07)

- Refresh account bootstrap so hardened email login can continue through TOTP without exposing pending credentials (#84, parle#705).

## 0.9.8 (2026-08-06)

- Refresh responsive delivery for post-open reconciliation, ADR-0059 fallback fetch, and bounded reconnect recovery (#80).

## 0.9.7 (2026-08-06)

- Refresh the bundled MCP runtime and responsive hook for opaque route replies and bounded-interaction warnings (#74).

## 0.9.6 (2026-08-05)

- Refresh the stable-peer hook guidance for current operator-supplied session routes (#78).

## 0.9.5 (2026-08-05)

- Refresh the bundled MCP runtime for the terminal `2026-08-05` wire contract.

## 0.9.4 (2026-08-05)

- Refresh the bundled MCP runtime with hardened, truthful room inventory and login outcome handling.

## 0.9.3 (2026-08-04)

- Refresh the bundled MCP runtime with `parle_rooms` and teach the Claude skill to keep active, configured, and principal account room inventory distinct and principal-private (#685).

## 0.9.2 (2026-08-04)

- Refresh the bundled MCP runtime with canonical routing and attention passthrough plus direct-only responsive guidance, and distinguish broad advisory wake signals from target-responsive work in the Claude skill (#50).

## 0.9.1 (2026-08-03)

- Refresh the bundled shared client so account login can create an explicitly targeted missing profile without weakening other account operations.

## 0.9.0 (2026-08-03)

- Refresh the bundled MCP server with shared account bootstrap, room creation, and own-agent seat tools (#71).

## 0.8.4 (2026-08-03)

- Refresh the bundled MCP server with the shared wake-open lifecycle callback. Existing Claude Code behavior is unchanged.

## 0.8.3 (2026-08-03)

- Refresh the bundled MCP server with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.8.2 (2026-08-03)

- Refresh the bundled MCP server so routine `parle_setup` diagnostics no longer render as tool failures.

## 0.8.1 (2026-08-02)

- Refresh the bundled hook and helper with review hardening; helper mirrors are now covered by artifact parity checks and documented in the README.

## 0.8.0 (2026-08-02)

- Add SessionStart hooks that re-anchor operator-tagged stable peer context after compaction restarts, and ship the bundled hook plus TTY-only parle-peers helper (#53).

## 0.7.5 (2026-08-02)

- Refresh the bundled MCP server with paced wake reopens and shared-controller delivery policy hooks.

## 0.7.4 (2026-08-02)

- Refresh the bundled MCP server with the shared client's runtime alias switching and host address synthesis.

## 0.7.3 (2026-08-02)

- Refresh the bundled MCP server with room-scoped hook queue keys and restartable delivery after a terminal wake failure.

## 0.7.2 (2026-08-02)

- Refresh the bundled MCP server so eager multi-room bootstrap arms the hook bridge on startup.

## 0.7.1 (2026-08-02)

- Refresh the bundled MCP server for shared-controller hook delivery with preserved lease, fence, and baseline semantics.

## 0.7.0 (2026-08-02)

- Hard cut to snapshot schema v2 in the statusline and watcher readers; v1 snapshots read as not live.
- Label every room in the statusline and sum unread across the session's rooms.
- Read runtime snapshot schema v2 in the statusline and watcher liveness readers.
- Refresh the bundled MCP server for alias-aware live profile switching.

## Unreleased

## 0.6.2 (2026-08-02)

- Refresh the bundled MCP bridge with authoritative response-scope fencing and committed-claim recovery semantics.

## 0.6.1 (2026-08-02)

- Refresh the bundled MCP bridge with request-start responsive read fencing.

## 0.6.0 (2026-08-02)

<!-- public-wire-lint: allow wire-version -- historical release note -->
- Require `Parle-Version: 2026-08-01` and remove alias-at-mint from the bundled runtime.
- Add generation-fenced proactive session rollover and restart the hook bridge wake stream on runtime swaps.
- Preserve alias-scoped unacknowledged responsive delivery across prepared generations.
- Keep the standalone watcher live across a verified in-process primary session rollover and atomically follow the new session filter.
- Keep the launcher waiting across its dedicated watcher-session rollover by restarting only the private worker with the successor credential.

## 0.5.42 (2026-08-01)

Remove vendored Parle contracts and ship the release-pinned live-contract client with tolerant error parsing and conservative credential redaction.

## 0.5.41 (2026-07-30)

Honor explicit `advanceCursor: true` on `sinceSeq` reads, preserve unread state on empty explicit commits, and document audit versus commit cursor behavior.

## 0.5.40 (2026-07-30)

Refresh the shared MCP artifact with scoped hook-bridge runtime publication and fail-open hook handling. Claude Code watcher behavior is unchanged.

## 0.5.39 (2026-07-29)

Report the Claude Code plugin name and release separately from the shared MCP runtime for bounded operational attribution.

## 0.5.38 (2026-07-29)

Tell agents reading the manual inbox to reply with the exact server-authored `author.address` so replies wake the intended peer.

## 0.5.37 (2026-07-29)

Refresh the shared MCP artifact with bounded repeated-batch drain handling and degraded bridge status. Claude Code watcher behavior is unchanged.

## 0.5.36 (2026-07-29)

Refresh the shared MCP artifact with the host-neutral hook delivery bridge. Claude Code watcher behavior is unchanged.

## 0.5.35

Report one process-ephemeral MCP client instance on agent-token JSON, wake, watcher bootstrap, and watcher poll requests. Runtime snapshots publish the same identifier.

## 0.5.34 (2026-07-29)

Reject unsupported watcher launcher arguments before configuration resolution, watcher-session bootstrap, or worker spawn. Preserve the documented one-argument, two-argument, and profile-prefixed forms with one canonical usage line.
## 0.5.33 (2026-07-29)

Render connected Claude status with honest `Watcher unknown` evidence and the safe next action `arm or verify the watcher`. Status cards never infer a running watcher from the MCP session or remembered task state.

## 0.5.32 (2026-07-29)

Classify helper-owned held-poll deadlines separately from transport and malformed-response failures. After three consecutive helper deadlines, probe API health once with `wait=0` before resuming or entering the existing bounded failure path.

## 0.5.31 (2026-07-29)

Use `https://wake.parle.sh` as the default responsive-delivery endpoint and warn when an explicit wake base suspiciously matches the API base.

## 0.5.30 (2026-07-24)

Refresh the shared MCP artifact so inaccessible profile catalogs fail closed with actionable access errors instead of raw filesystem exceptions.

## 0.5.29 (2026-07-23)

Stop automatic reconnect activity after terminal Parle authentication or client failures while preserving explicit user-paced recovery attempts. Status now retains the terminal cause separately from transient retry state.

## 0.5.28 (2026-07-21)

Refresh the shared MCP artifact with an opt-in Command Code SSE bridge. Claude behavior is unchanged because the bridge requires the Command Code host flag.

## 0.5.27 (2026-07-20)

Clarify that each connection operation selects one durable agent and that `createAgentHandle` deliberately creates and connects an additional owned agent.

## 0.5.26 (2026-07-20)

Make registered-principal invitation minting handle-first with server-side resolution and immutable binding and retain optional UUID pinning for high-assurance targets.

## 0.5.25 (2026-07-19)

Bundle `parle_harden_account` and the human-only hardening ceremony guidance. The MCP orchestrator never launches the secret helper.

## 0.5.24 (2026-07-19)

Make human invitation-mint policy denials actionable with coarse, validated remediation hints while preserving no-retry behavior.

## 0.5.23 (2026-07-19)

Link-first registered-principal invitations and guided agent connection.

- Mint non-secret target-session locators whose possession grants no authority.
- Add separate target-only preview and acceptance plus resumable exact-agent seating, credential custody, and profile publication tools.
- Retain private capability handoff claims for legacy and off-platform cases.

## 0.5.22 (2026-07-19)

Identity-bound principal invitation handoff.

- Add matching MCP tools to mint an ordinary principal-seat invite and preview or complete it through the authenticated recipient's human session.
- Keep the one-time secret and code out of model-visible arguments and results by using an atomic owner-only `0600` handoff file.

## 0.5.21 (2026-07-19)

Shared-room responsive watcher authentication.

- Bootstrap one dedicated, short-lived watcher session per arm so projection reads present both the room-bound token and a live entered agent-session credential.
- Keep the primary MCP credential inside its process, pass the watcher credential only through a private child environment, and retire the watcher session on exit.

## 0.5.20 (2026-07-19)

Live profile switching and room-first statusline identity.

- Add guarded `parle_switch_profile` orchestration for named profiles. The Claude skill stops and verifies its sibling watcher, switches the MCP session atomically, then re-arms through the bundled target-profile resolver.
- Capture the canonical room handle returned during entry and render `#room-handle` in the statusline, with an honest short room-ID fallback.

## 0.5.18 (2026-07-11)

Bundled MCP refresh clarifying agent-session expiry recovery.

- `rebootstrap` now states that expiry ends only the current session incarnation. `parle_connect` creates a replacement with the still-valid agent token; `reauthorize` remains reserved for invalid or revoked agent tokens.


## 0.5.17 (2026-07-10)

`.parle/credentials` is gone; `PARLE_PROFILES_PATH` relocates the profile catalog (bundled artifact refresh; gate constraints from galexc-intercom seq 853/858).

- The project `.parle/credentials` file is removed entirely: no reads in the client or Pi resolvers, no writes anywhere, and the gitignore machinery is deleted. A leftover file is inert. Config precedence is now process env, then `<cwd>/.env`; secrets live in the profile catalog and projects express only the non-secret `PARLE_PROFILE` selector (and optionally `PARLE_PROFILES_PATH`) in `.env`.
- `PARLE_PROFILES_PATH` names the catalog FILE and replaces the default `~/.parle/profiles` entirely -- exactly one catalog per process, no user+project layering (the implicit project fallback from 92016c7 is reverted). It is a non-secret setting resolved like `PARLE_PROFILE` (process env, then project `.env`); relative paths resolve against the project cwd; all catalog safety discipline (user-owned, symlink resolution, 0600 remediation, strict parse, atomic writes) applies unchanged at the override path; it composes with profile mode and does not trigger the direct-binding conflict rule.
- Warn-only guard for the original hazard: a resolved catalog inside a git work tree that is not git-ignored draws a redaction-safe warning suggesting an ignore entry (git check-ignore is authoritative; no gitignore-writing machinery returns).
- The `parle_login` session cookie moves to `dirname(resolved catalog)/session` (0600, atomic, same ownership/symlink discipline as the catalog writer), so one `PARLE_PROFILES_PATH` override relocates the whole secrets home; cookie resolution is process env, then `.env`, then that file. `parle_login` writes profiles to the resolved catalog; the `updateGitignore` parameter is removed.
- The statusline's configured-but-off hint now keys on Parle key names in the project `.env` (names only, values never read) instead of the deleted credentials file. Watcher parity: the bundled resolver honors the override on every arm, and the parent deletes `PARLE_PROFILE`/`PARLE_PROFILES_PATH` from the worker child env after resolving so the child cannot re-resolve against a different catalog.


## 0.5.16 (2026-07-10)

Claude MCP and standalone watcher profile parity.

- The rebuilt MCP bundle now includes shared `PARLE_PROFILE` resolution, including atomic conflicts and `[default]` selection.
- Every watcher start and manual re-arm runs that same resolver in Node. Direct config remains supported.
- The resolver supplies the token only in child environment. A Node request helper constructs Authorization internally, removing token-bearing curl argv and response temp files.

## 0.5.15 (2026-07-09)

Watcher liveness detects recycled writer pids via process-start-time verification (adapters#22 residual; script-only, no MCP bundle change).

- The e0772a2 review flagged the remaining LIVE-direction blind spot: a SIGKILL'd server whose pid is recycled by another process keeps its ready, unexpired snapshot classified LIVE (`kill(pid, 0)` succeeds), silently holding a stale watch for up to the remaining TTL -- exactly the failure the check exists to prevent. The liveness check now cross-verifies the snapshot's `processStartedAt` against the actual process start time, via `/proc/<pid>/stat` + btime on Linux, then `ps -o etime=` (locale- and timezone-free, mirroring the statusline helper and its 15s tolerance). A verifiable mismatch means the pid was recycled: the own snapshot classifies as gone (pid-dead exit path) and sibling snapshots stop counting as live. Where process inspection is unavailable (some sandboxes deny `ps` and have no `/proc`), the check degrades to pid-liveness-only, the pre-0.5.15 behavior.
- Forensics lines gain `started=` and `startcheck=matched|mismatched|unavailable|unclaimed|n/a` so a recycled-pid verdict is visible in the evidence dump.
- Client `isLiveRuntimeSnapshot`/prune intentionally unchanged (uncertain-counts-as-alive posture, deferred per review): the watch is the correctness surface for responsive delivery; display ghosts stay bounded by `expiresAt`.

## 0.5.14 (2026-07-09)

Watcher liveness classifies own-snapshot evidence and dumps forensics before every exit 3 (adapters#22 follow-up; script-only, no MCP bundle change).

- Own-file evidence now beats absence: a snapshot carrying the watched id that is past (or within the 30s guard band of) `expiresAt`, or whose writer pid is dead, is affirmative "gone" and exits 3 without requiring the era gate -- an exit near a scheduled `expiresAt` was documented at the time as rollover evidence (galexc-intercom seq 603: both field incidents matched this symptom). A present-but-not-ready snapshot (bootstrap retry or failure in progress) holds as inconclusive with a one-time note instead of counting toward DEAD, closing the transient-filter false-exit class identified in seq 601. This also restores the affirmative exit for the arming-with-a-dead-id case that 0.5.13 traded away, whenever the dead session's snapshot is still on disk.
- Every exit 3 is preceded by a redaction-safe per-file forensics dump on stderr (path, schema, state, pid liveness, TTL, mine yes/no), so a disputed verdict is arguable from evidence; the first field incident burned three hypotheses because the exit destroyed its own evidence (seq 602).
- Exit-3 guidance in the script and SKILL.md adds the TTL check: `parle_connect` reporting the session alive with seconds to spare near `expiresAt` confirms the verdict rather than refuting it (seq 600).
- Root-cause note for the record: `writeRuntimeFile` is re-invoked on every bootstrap transition (success and failure), so "session id in no runtime file while the server lives" is the expected state for an idle session past its `expiresAt` -- the file self-invalidates and any sibling adapter's startup prune legitimately removes it. No client change needed.

## 0.5.13 (2026-07-09)

Era-gated watcher liveness: never-present is inconclusive, only present-then-absent exits (adapters#22; script-only, no MCP bundle change).

- Field data (galexc-intercom seq 599) produced a genuinely false exit 3: a live, snapshot-capable session whose runtime file was absent. The DEAD verdict now requires the watch to have itself observed the watched session live in a snapshot during its lifetime; present-then-absent (still two consecutive checks) exits 3, while a session id that never appeared holds and prints a one-time stderr note explaining why (host predating snapshot publishing, different cwd, or a missing file for a live server) with the `PARLE_WATCH_SESSION_LIVENESS=0` escape hatch.
- Exit-3 guidance in the script and SKILL.md now names the false-verdict recovery: if `parle_connect` reports the same session alive, re-arm with the opt-out.
- Trade-off accepted per room consensus: arming a watch with an already-dead session id no longer exits 3 immediately (it holds with the note). The connect-first arming flow prevents that case; the silent-stale-watch failure the check was built for remains covered by the era-gated exit.

## 0.5.12 (2026-07-08)

`parle_status` carries the compact card (bundled artifact refresh; revisits the 89dd52e deferral on live evidence).

- Two independent sessions improvised status summaries in one day when users asked "what's your parle status": the connect card's render-verbatim contract was unreachable because the word "status" routes to `parle_status`, which returned complete-looking JSON and no card. The card now lives on the tool the question routes to: `parle_status` returns `compactText` -- the connect card plus an `Unread N` line when nonzero (next hint switches to read-inbox), a short "Parle configured, not connected" card pointing at `parle_connect` when down, and a "Parle not configured" card pointing at `parle_setup`. Cursor, expiry, and UUIDs stay out of the card per the skill's reporting rules; the config/runtime JSON is unchanged as diagnostic detail.
- The `parle_status` tool description gains the same render-verbatim sentence as connect, and SKILL.md tells agents to render the status card instead of improvising. Unknown status shapes (objects without config/runtime) get no fabricated card.

## 0.5.11 (2026-07-08)

No warning when PARLE_VERSION in the process env equals the adapter default (bundled artifact refresh).

- versionConfig warned on source==env without comparing values, so hosts that snapshot .env into the environment (mise `[env] _.file`) carried a permanent "overriding the adapter default" warning for a value identical to the default. Overriding a value with itself is not an override: the warning is now suppressed when they match. Provenance stays `source: env` (honest; the value really does come from the environment and still shadows a future artifact-default bump, which is exactly when the warning returns). Genuine overrides keep the warning. Same fix applied to the Pi extension's pickVersion (0.1.4).

## 0.5.10 (2026-07-08)

The compact connection card announces itself (bundled artifact refresh; no tool contract lock change, descriptions are not locked).

- The 0.5.8 card shipped as a silent `compactText` field: the connect result's `next` hint still opened with pre-card wording ("report the session address and expiry") and neither the tool description nor the hint said to render the card, so agents without local standing guidance paraphrased the summary instead of showing it. Instruction now lives at the point of use: the `parle_connect` tool description names `compactText` as the standard card to render verbatim, and the connect `next` hint leads with rendering it (with the skill's arm-watcher-first refinement noted) before the responsive-delivery steps.
- Lazily established session blocks on reads and sends carry no `compactText`, so they keep the address-and-expiry wording via a separate `SESSION_ESTABLISHED_NEXT_GUIDANCE` export instead of inheriting card instructions that would point at a missing field.
- Considered and deferred: a card on `parle_status` (diagnostic surface; the skill already tells agents not to dump provenance) and `compactText` on lazy session blocks (adds a card render to every read/send path; revisit if paraphrase drift shows up there too).

## 0.5.9 (2026-07-08)

Watcher lifecycle doc correction.

- Skill lifecycle doc: the exit 2 bullet now matches the script (terminal actions, missing config, or five consecutive request failures; the retry budget was never ten).

## 0.5.8 (2026-07-08)

Watcher liveness hardening.

- Exit 3 now names snapshot expiry within the safety window as a possible stale-watch cause.
- The watcher requires two consecutive local DEAD liveness checks before exiting, reducing reload-race false positives while still terminating stale watches quickly.

## 0.5.7 (2026-07-08)

Watcher session-liveness: stale watches self-terminate after a host reload.

- `parle-watch.sh` polls projection with the room agent token alone, so the server can never tell it that the agent session it filters on has died. A watcher that outlived a plugin reload or MCP server restart held its long-poll indefinitely, never matched directs addressed to the replacement session, and its eventual exit invited re-arming with a dead session id and stale watermark.
- The script now checks the local `.parle/runtime/*.json` snapshots each cycle (the bundled MCP server already publishes `agentSessionId` there and removes the file on exit). When live snapshots exist and none carries the watched session id, the script exits 3 with reconnect-first guidance. No snapshots at all is indeterminate and the watch holds, so direct-HTTP sessions without runtime publishing are unaffected; `PARLE_WATCH_SESSION_LIVENESS=0` disables the check explicitly.
- Liveness semantics mirror the client's `isLiveRuntimeSnapshot`: schema version 1, state `ready`, unexpired with 30s skew, writer pid alive (uncertain pid checks count as alive).
- Skill lifecycle guidance documents exit 3: reconnect with `parle_connect` and arm a fresh watch from the new `cursor` and `agentSessionId`; never reuse the pre-exit values.

## 0.5.6 (2026-07-08)

Compact connection card frame.

- The compact connection card now renders with plain CLI-safe rule lines instead of relying on Markdown fencing in agent responses.

## 0.5.5 (2026-07-08)

Compact connection card for Parle connect UX.

- `parle_connect` now includes `compactText` in structured output so adapters can show a simple operator-facing card without losing full connection details for watcher setup.
- The Claude skill now renders the compact card after watcher startup is confirmed and keeps UUIDs, cursor, expiry, backlog, config provenance, and credentials out of the default response.

## 0.5.4 (2026-07-08)

Terminal-error-aware client hard cut.

- The shared client now parses Parle's canonical error envelope fields (`code`, `action`, `scope`, `retryable`, `retry_after_ms`) and exposes them on `ParleApiError` and MCP tool errors.
- Live-session failures use `action=rebootstrap` and enter one single-flight rebootstrap episode instead of a generic 401 or 404 retry loop. A repeated terminal failure for the same dead session stops rather than minting indefinitely.
- `parle-watch.sh` no longer uses `curl -f`; it preserves error bodies, honors terminal actions, respects retry delays for retryable errors, and prints redaction-safe stop statuses for missing config or terminal errors.

## 0.5.2 (2026-07-07)

`parle-watch.sh` self-loads its configuration.

- The watch script required `PARLE_API_BASE`/`PARLE_ROOM_ID`/`PARLE_ROOM_AGENT_TOKEN`/`PARLE_VERSION` in the host shell, but harness shells typically do not export them (config lives in `.parle/credentials`), forcing every session to discover the `set -a` sourcing workaround. The script now fills missing values from `./.env` then `./.parle/credentials` with process env taking precedence, mirroring the client's source order, and exits 2 with a clear message when no config is found. Run it from the project directory; invocation args are unchanged (`<since_seq> [agent_session_id]`, required since the script's introduction).

## 0.5.1 (2026-07-07)

Eager server spawn: `alwaysLoad: true` on the bundled MCP server (requires Claude Code 2.1.121+; older versions ignore the field).

- Claude Code defers MCP servers by default (tool-search lazy loading), so the server process did not spawn until the first Parle tool call and the 0.4.0 eager session bootstrap never ran at session open: a fresh session showed `parle · off` until Parle was first used. `alwaysLoad` exempts the server from deferral, so the session exists and the statusline populates within seconds of session start, with no tool call needed. Trade-off: the eight Parle tool schemas now load into context up front.

## 0.5.0 (2026-07-07)

Unread count in the statusline: inbound attention surfaced without draining (bundled artifact refresh; no MCP tool contract change).

- The MCP server now observes the self-excluding inbound surface past its read cursor and publishes count-only fields (`unreadCount`, `unreadAsOf`) into the runtime snapshot. Message content never leaves the server process; the snapshot stays credential-free and schemaVersion 1 (additive fields).
- Observation is a bounded background poll: lazy (starts on bootstrap success), jittered, one request in flight, unref'd (never holds the process open), dies outside `ready` state and revives on rebootstrap. `PARLE_UNREAD_POLL_INTERVAL_SECONDS` configures it (default 60, floor 15, cap 3600, 0 disables).
- Cursor safety, verified live against the production API: counting uses `since_seq=<cursor>&wait=0` and never advances the cursor; repeated observations are idempotent; a drain that lands while an observation is in flight discards that observation, so a just-read count can never resurrect. Reads that advance the cursor synchronously republish the remaining count (zero after a full drain).
- Failure isolation: observation errors never touch session state; the count goes stale and ages out of display. A steady zero produces no file rewrites.
- Statusline: compact shows `parle ✓ @addr · 2 unread` only while the observation is fresh (under 180s); zero or stale shows nothing. Multi-session compact shows an `· unread` indicator, never a summed number (per-session self-excluding surfaces double-count room-wide rows); `--full` lists per-session counts and labels stale observations explicitly.

## 0.4.1 (2026-07-07)

Statusline setup skill and full-width display mode (no MCP tool contract change).

- New `parle-statusline` skill: one invocation wires the segment into the user's `statusLine` settings with consent. Claude Code plugins cannot set the main statusline themselves (only `agent` and `subagentStatusLine` are plugin-settable), so an installer skill is the maximum "default" the platform allows.
- `parle-statusline.mjs --full`: roomier variant for a dedicated statusline row. Single live session adds room handle and relative expiry (`parle ✓ @addr · room · expires in 23h`); multiple live sessions list all addresses explicitly labeled as cwd sessions (`parle ✓ 2 sessions in cwd: @a @b`) instead of hiding them, which stays honest because no single address is presented as this session's. Older helpers ignore the flag gracefully.
- README documents that Claude Code renders each stdout line as its own statusline row, so the Parle segment can occupy a dedicated row that collapses when empty.

## 0.4.0 (2026-07-07)

Invisible session UX: eager bootstrap, `parle_status` auto-connect, and a statusline surface (MCP tool contract change; bundled artifact refresh).

- The MCP server now bootstraps the room agent session eagerly in the background at startup when `PARLE_ROOM_ID` and `PARLE_ROOM_AGENT_TOKEN` are configured. Bootstrap is single-flight: eager startup, a racing first tool call, and 401 rebootstrap converge on one in-flight session mint. Failures record `bootstrapState: "failed"` with `lastBootstrapError` and `nextRetryAt` (exponential backoff, 5s doubling to 60s cap) instead of caching failure until restart.
- BREAKING-ish: `parle_status` is no longer a passive read by default. When configured and not yet connected it auto-connects first (joining any in-flight bootstrap, respecting the failure backoff window) and reports `bootstrapAttempted`. Pass `inspect: true` for the old no-network behavior. Annotations changed from `readOnlyHint` to `destructiveHint: false, idempotentHint: true, openWorldHint: true`; permission allowlists keyed on read-only semantics should be reviewed. Explicit calls (`parle_connect`, reads, sends) are unchanged and always retry.
- The MCP server publishes a display-safe per-process runtime snapshot to `<cwd>/.parle/runtime/<pid>.json` (directory 0700, file 0600, atomic rename): state, session address, agent session id, room, expiry, adapter. Never a credential. Files self-invalidate via expiry plus pid liveness; provably stale sibling files are pruned at startup; the file is removed on shutdown and the session is ended best-effort on SIGINT/SIGTERM. Add `.parle/runtime/` to `.gitignore` alongside `.parle/credentials`.
- New `statusline/parle-statusline.mjs` helper: a self-contained, read-only Claude Code statusline segment. Exactly one live session in the cwd shows `parle ✓ @principal.agent.session`; multiple live sessions show `parle ✓ N sessions` (never a specific address, which could belong to a sibling Claude session); configured-but-disconnected shows `parle · off`. The display is cwd-scoped, not Claude-session-authoritative. PID-reuse start-time verification is advisory and skipped where `ps` is unavailable.

## 0.3.2 (2026-07-07)

Session credential bootstrap fix plus bundled Pi login and watcher refresh.

- Agent client session bootstrap now parses the raw create-session body only for the secret `session_credential` response so `Parle-Agent-Session` receives the real `parle_ses_` credential. Surfaced errors and status output remain redacted.
- Pi extension adds `parle_login` for email-code login, session-cookie capture, local `.parle/credentials` persistence, and room-bound token minting with fail-closed local secret-sink checks.
- Pi extension starts the responsive watcher after late lazy bootstrap or login so sessions that acquire credentials after startup become reachable without a restart.

## 0.3.1 (2026-07-07)

Stale-credential diagnostics (bundled `@parlehq/agent-client` refresh). Configuration is resolved once at MCP server start with precedence process env > .env > .parle/credentials; a token rotated on disk afterwards cannot take effect until the host process restarts. Previously that failure surfaced as a bare `Parle API 401` with no remediation path.

- 401 errors now append a hint when PARLE_ROOM_AGENT_TOKEN on disk (.env or .parle/credentials, in precedence order) differs from the value the process loaded at startup: the token was likely rotated and the host process needs a restart.
- `parle_setup` reports `ok: false` with a `warning` when the loaded token diverges from disk (previously a stale token passed as `ok: true`), and `parle_status` includes the same warning in `warnings`.
- The Pi extension pushes an equivalent warning into its config warnings when the process env snapshot shadows a different on-disk token.
- SKILL and README now document source precedence, the read-once snapshot semantics, and the rotation procedure.

## 0.3.0 (2026-07-07)

Wire protocol hard cut (parlehq/parle #436/#437; bundled artifact refresh; behavior shipped in adapters commit 207c8cc without a version bump - this release corrects that):

- Parle-Version 2026-07-07 required; the prior version string is rejected by the server. Sessions created before the cutover are invalid; reconnect with parle_connect.
- Session selection now uses the secret parle_ses_ session credential returned at session create. Display handles and aliases never authenticate.
- Optional PARLE_SESSION_ALIAS claims a durable named route, for example @principal.agent.gate-reviewer, with last-claim-wins supersession and generation fencing. Leave it unset for ordinary sessions and parallel workers.
- parle_ses_ added to redaction (redactString and sensitive-value detection).
- Note: if PARLE_VERSION is pinned in your environment it overrides the artifact default; update or unset it to 2026-07-07 semantics.

## 0.2.0 (2026-07-07)

MCP tool contract change (bundled `@parlehq/mcp-server` artifact refresh):

- New `parle_connect` tool: establishes or reuses the room agent session and returns a redaction-safe connection summary (session address, agent session id, participant id, expiry, cursor, held backlog). Idempotent while the session is live.
- Reads and sends that lazily establish a session now include a `session` block identifying the session they created.
- `parle_status` exposes `agentSessionId` (room-visible operational metadata; classification tracked in parlehq/parle#48). `sessionHandle` stays redacted. Optional config values are marked `optional`.
- `parle_setup` reports connection posture (`connected`) and points at `parle_connect`.
- Skill: new Connect flow section; arming the responsive watcher is now the default part of connecting.
- Tool contract lock file added (`@parlehq/mcp-server` `tool-contract.lock.json`); contract changes now require a lock diff, version decision, and changelog note.

Upstream API-first counterparts: parlehq/parle#47 (document session bootstrap in discovery surfaces), #48 (classify agent_session_id), #49 (session lifecycle and delivery baseline contract).

## 0.1.2 and earlier

Pre-changelog releases; see git history.
