# Changelog

## Unreleased

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

- Own-file evidence now beats absence: a snapshot carrying the watched id that is past (or within the 30s guard band of) `expiresAt`, or whose writer pid is dead, is affirmative "gone" and exits 3 without requiring the era gate -- an exit near a scheduled `expiresAt` is documented as expected pre-expiry rollover (galexc-intercom seq 603: both field incidents were exactly this). A present-but-not-ready snapshot (bootstrap retry or failure in progress) holds as inconclusive with a one-time note instead of counting toward DEAD, closing the transient-filter false-exit class identified in seq 601. This also restores the affirmative exit for the arming-with-a-dead-id case that 0.5.13 traded away, whenever the dead session's snapshot is still on disk.
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
