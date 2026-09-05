# Changelog

## 0.7.65 (2026-09-05)

- Add a Claude-host idle wake over a loopback WebSocket. When a host manifest declares `PARLE_HOST_IDLE_WAKE=claude-monitor`, the hook bridge owns a `ws` server (now a direct dependency, bundled into the single artifact) bound to `127.0.0.1` on an ephemeral port whose only path is a per-process 256-bit random token: upgrades are refused unless the method is `GET`, `Host` is exactly `127.0.0.1:<port>`, and the path matches the token; non-upgrade requests get 426; peer frames are capped at 1 KiB and ignored except ping and close. One peer at a time, newest wins: a new peer closes the previous one with code 1000 and reason `replaced`, which is never a detach, while any other peer close or error counts as a waiter detach and feeds the #185 suspension latch unchanged. When the hook binding is replaced by another session (a SessionStart with `allowReplace`), the bridge asks the wake to rebind: the current peer is closed with code 1000 and reason `rebound` (also never a detach) and the path token rotates, so the replaced session's address is dead and only the successor's own `take` yields the new one. The suspension latch never withholds a frame from a peer that is attached anyway, matching the Unix waiter. The bridge reports an attached peer as `waiterAttached`, so `parle_status`, the statusline, and the hook keep their contract. When work is pending with no live lease the wake sends one text frame, `parle: responsive delivery queued`, on readiness or on attach; one frame is outstanding per peer until a hook `take` consumes it, and a frame is a hint only, never an acknowledgement. The wake URL (`ws://127.0.0.1:<port>/<token>`) is returned only as `idleWakeUrl` in the owner-only `take` response and never appears in `status()`, runtime descriptors, evidence, or logs. Because Claude Code sends no MCP thread metadata, this wake arms on the hook binding alone (`threadTarget: "bound"`); the Codex queue wake still requires metadata agreement. `codex-queue` still constructs only `CodexQueueWake`; `none` or an absent literal constructs neither. The Claude plugin manifest, hook, and skill adopt the mode separately (#196). The Unix-socket `wait` action and `--parle-watch` remain in place (#195).

## 0.7.64 (2026-08-28)

- Quiet the watcher re-arm loop: the hook bridge counts waiter detaches it did not end (bounded ring, 60-minute window), latches `idleWakeSuspended` at three, and resets on a `UserPromptSubmit` bind. The one announcement per episode is claimed through `announce-suspension` with `claim: true` and becomes final only on `commit-suspension` after the hook wrote its output; an expired claim is owed again, a live claim fences `SessionStart` binding replacement like a live delivery lease, and an older hook that omits `claim` gets the one-step announcement it can handle. The bundled hook commits the suspension claim and the delivery lease independently after output, reporting either failure without skipping the other. `take` now returns a fresh `status` snapshot so the hook decides on current state, the bundled Stop hook stops re-arming while suspended, and status reports `idle_wake_suspended` as the observation (the watcher keeps detaching), not a diagnosis. The suspension deliberately trades repeated re-arm noise for no idle wake at all until the next human prompt (#185).

## 0.7.63 (2026-08-27)

- Add Codex idle wake through the owning process's queue. When a host manifest declares `PARLE_HOST_IDLE_WAKE=codex-queue` together with `PARLE_HOOK_BRIDGE_HOST_PROCESS=direct-parent`, the hook bridge resolves its direct parent's executable (`/proc/<ppid>/exe` on Linux; `/bin/ps -o comm=` with an `lsof` text-mapping fallback on macOS), canonicalizes it and accepts only a regular executable owned by the current user or by root, writable by neither group nor world, neither setuid nor setgid (`wrong-uid` / `unsafe-executable` otherwise), whose `--version` reports `codex-cli` at or above 0.149.0, re-checking the verified file's device, inode, owner, mode, and mtime immediately before every exec and dropping the cached verification on any drift, refuses a `--remote` topology or a changed parent, and never searches `PATH` or uses a shell. On the transition from zero to pending bridge messages it runs `<parent> queue --thread <bound-thread> --message <fixed trigger>` with a constant trigger text that carries no peer content, route, or credential; the trusted hook still injects the real content when the queued turn starts. One trigger is outstanding per thread: a hook take consumes it and a commit with remaining work asks again. Only a spawn failure (the process never ran) is retried, with bounded jittered backoff (`spawn-failed` after the bound); every outcome of a process that ran without exit 0, including a failure Codex reports (`queue-full`, `invalid-thread`, `permission`, kept as the diagnostic reason) and a timeout or lost exit status, reports `degraded` and is never retried. A busy or empty hook take consumes the outstanding trigger, and an uncommitted lease expires actively and re-arms wake for the work it held. A binding that MCP metadata confirmed and that still holds work cannot be replaced by another thread's SessionStart. `parle_status` and `parle_connect` wait up to 2 s for the host verification to settle before rendering. The wake arms only when the hook-bound thread and the MCP `_meta.threadId` agree (`host-session-conflict` otherwise). `responsiveDelivery.idleWake` reports `queue-only`, `degraded`, or `unavailable` with `idleWakeReason` in the JSON; connect and session-established `next` guidance follow the state. Hosts without the manifest literal are unchanged. The shared hook gains `--shell-launched`: a hook launched through a shell chain walks a bounded process ancestry to the nearest Codex process (absolute path whose canonical file has a codex basename, is owned by the user or root, is not group/world-writable, setuid, or setgid, and is executable, checked at use time) and consults only that process's bridge directory, so a nested Codex can never reach an outer session's bridge; no bridge there means no delivery, so SessionStart context still renders. Claude's `--direct-parent` path is unchanged. Carries client 0.8.54 (#174).

## 0.7.62 (2026-08-27)

- Return a credential-free `identity` checkpoint on `parle_connect` and on connected `parle_status` results: the selected profile (or `null` for direct configuration), principal handle, acting-as agent handle, session address, and the single configured room's handle and id, all values the card or redacted status already show. Unknown fields are omitted, not guessed. A degraded boot whose `PARLE_PROFILE` is not in the catalog now carries `next` guidance saying the requested profile is absent and that no host may connect or send under another profile or the default identity without operator instruction (#172).

## 0.7.61 (2026-08-27)

- Read the host's static idle-wake capability from the manifest literal `PARLE_HOST_IDLE_WAKE` (`none` is the only value; absent keeps today's behavior) and report a generic `responsiveDelivery.idleWake` state from it and the bridge waiter evidence. On a host without an arm action, `parle_status` and `parle_connect` never emit `arm-or-verify-watcher` or the attach-or-verify text; they emit `idle-wake-unavailable` instead, while bridge fault guidance is unchanged. On such a host the shared client's connect `next` and session-established `next` guidance (which tell the model to arm responsive delivery) are replaced with the same next-prompt / attended-wait guidance the card renders, and the `parle_connect` description no longer says the next hint arms anything. Carries client 0.8.53 (#171).

## 0.7.60 (2026-08-27)

- Reword the `waitSeconds` tool guidance on `parle_read` and `parle_inbox`: one server-side bounded wait of 0–30 seconds per call, never an unattended watcher, with the operator-authorized capped attended hold deferred to the host skill; carries the client 0.8.52 connect guidance (#170).

## 0.7.59 (2026-08-27)

- Add opt-in launch-directory configuration: when a host manifest sets `PARLE_CONFIG_CWD_FROM_PWD=1` (the Codex plugin does), resolve configuration from a valid absolute `PWD` before the process directory; report `configCwd` provenance in healthy and degraded status (#169).

## 0.7.58 (2026-08-31)

- Refresh the shared responsive-delivery controller with fallback deadline and stage evidence (#80).

## 0.7.57 (2026-08-23)

- Carry the bounded room reads of client 0.8.50 into the MCP artifact and read guidance (parlehq/parle#927).

## 0.7.56 (2026-08-21)

- Abandon dead exact-session hook leases before rebootstrap without weakening live-session rollover fences (#161).

## 0.7.55 (2026-08-20)

- Keep responsive delivery active after a target-specific send or reply failure (#160).

## 0.7.54 (2026-08-19)

- Log bounded responsive-delivery stages through bridge queue readiness without message content (#880).

## 0.7.53 (2026-08-18)

- Publish acknowledgement-backed `lastAckAt` without mistaking fetch liveness for completed delivery (#157).

## 0.7.52 (2026-08-18)

- Publish the complete #156 room-recovery diagnostic fix under a unique MCP version.

## 0.7.51 (2026-08-18)

- Attribute active hook-bridge diagnostics to bridge, controller, or room state while preserving lifecycle error kinds (#156).

## 0.7.50 (2026-08-18)

- Keep synchronous hook delivery commits within the host's bounded Stop window while tolerating acknowledgements slower than the ordinary local IPC timeout (#151).

## 0.7.49 (2026-08-18)

- Expose socket-derived local waiter attachment, report healthy-but-unarmed idle wake truthfully, and make duplicate watcher attachment a successful no-op (#151).

## 0.7.48 (2026-08-18)

- Share one conservative stale-artifact remover between bounded bridge cleanup and watcher discovery, and stop direct-parent MCP children when host correlation is lost (#149).

## 0.7.47 (2026-08-18)

- Expose first-time onboarding separately from returning login and preserve server-owned privacy guidance without automatic retries.

## 0.7.46 (2026-08-17)

- Keep concurrent candidate removal from aborting watcher discovery and include discovery failures in aggregate diagnostics (#133).

## 0.7.45 (2026-08-17)

- Probe current hook-bridge sockets before legacy candidates, skip per-candidate status failures, reap dead flat sockets, and report aggregate watcher diagnostics (#133).

## 0.7.44 (2026-08-17)

- Add guarded `parle_room_capacity_recovery` preview and completion, and harden roster and exact-session tool guidance against inferred bulk cleanup (#144).

## 0.7.43 (2026-08-17)

- Bundle @parlehq/agent-client 0.8.39 with the sole 2026-08-17 wire version (parlehq/parle#810).

## 0.7.42 (2026-08-17)

- Republish the merged #132 and #140 MCP runtime under a unique version after the concurrent releases shared 0.7.41; runtime behavior is unchanged from main.

## 0.7.41 (2026-08-17)

- Publish terminal evidence when hook-bridge socket startup fails and prevent status or connect cards from reporting an unbound bridge as armed (#132).
- Expose `parle_room_participants` and guarded `parle_end_own_session` tools so operators can inspect stale room sessions and reclaim their participant capacity without connecting an agent (#140).

## 0.7.40 (2026-08-17)

- Keep repeated hook-bridge startup from replacing healthy persisted `watching` evidence with `starting`, restoring truthful plain `parle_status` results (#120).

## 0.7.39 (2026-08-17)

- Expose honest conditional returning-account login start results and stop presenting accepted requests as proof that a code was sent.

## 0.7.38 (2026-08-16)

- Add opt-in direct-parent hook-bridge correlation for Claude, descriptor challenges, safe rebinding, and per-bridge endpoints while preserving legacy Codex discovery (#118).

## 0.7.37 (2026-08-15)

- Preserve redacted typed API error details in MCP tool results and bundle truthful bootstrap-error status projection (#126, #127).

## 0.7.36 (2026-08-15)

- Replace the standalone Claude network watcher with one owner-only local hook-bridge wait. The shared responsive controller remains the sole owner of wake SSE, durable drains, eligibility, and acknowledgement.

## 0.7.35 (2026-08-14)

- Resolve hook-bridge delivery as healthy when the same session also has the expected wake-only standalone watcher.

## 0.7.34 (2026-08-14)

- Expose degraded-safe `parle_delete_profile` through the shared local profile lifecycle and preserve adapter response-contract provenance separately from server error codes (#124, #125).

## 0.7.33 (2026-08-13)

- Expose shared `parle_create_own_agent` and `parle_delete_own_agent` account tools for MCP hosts while keeping the human session confined to fixed shared-client methods (#122).

## 0.7.32 (2026-08-13)

- Bundle exact-seat preflight for returning-login profile bootstrap and describe own-agent seat admission consistently for private and shared rooms (#121, parlehq/parle#800).

## 0.7.31 (2026-08-12)

- Inherit the shared client's in-place durable alias claim for anonymous live sessions (#115, parlehq/parle#797): a first claim now preserves the session, its participants, its wake stream, and outstanding exact-session opaque reply routes.

## 0.7.30 (2026-08-12)

- Bundle complete durable-alias validation from the shared client, including reserved words and anonymous session-shape exclusion.

## 0.7.29 (2026-08-12)

- Bundle the shared client durable session-alias normalization to 2 to 32 characters.

## 0.7.28 (2026-08-11)

- Expose the target-proof person mint contract with one handle-or-email target and privacy-flat email guidance (#113).

## 0.7.27 (2026-08-11)

- Bundle @parlehq/agent-client 0.8.26: 2026-08-10 wire default and terminal retirement of the bearer capability claim surface (ADR-0100).

## 0.7.26 (2026-08-11)

- Return the shared-client saved-start plan and remove harness-specific missing-start guidance from the bundled runtime.

## 0.7.25 (2026-08-11)

- Surface clearer saved-start not-found guidance from the shared client.

## 0.7.24 (2026-08-11)

- Add `parle_saved_start` local catalog management and `parle_session_alias` so MCP hosts can execute optional profile, alias, and opaque host-instruction steps without shared role parsing (#107).

## 0.7.23 (2026-08-10)

- Export the shared native tool runtime for host adapters and keep `parle_setup` guidance byte-stable across configured and degraded states. Detailed profile diagnostics remain in the `parle_setup` and `parle_status` results.

## 0.7.22 (2026-08-10)

- Keep `parle_connect`, active `parle_status`, and eager bootstrap responsive while optional hook bridge startup continues in the background, and separate the opaque hook queue scope from the runtime evidence directory.

## 0.7.21 (2026-08-10)

- Refresh the bundled runtime for the `2026-08-09` unified exact-seat admission hard cut.

## 0.7.20 (2026-08-09)

- Refresh shared responsive-delivery resolution and bounded runtime evidence cleanup so status never borrows another session's watcher evidence (#103, #104).

## 0.7.19 (2026-08-08)

- Refresh the shared transport with automatic known-address enrollment, add the supported-host context renderer, remove `parle_status.peerContext`, and delete the legacy peer helper and injection path (#96, #93).

## 0.7.18 (2026-08-08)

- Adopt the shared safe-file primitive for hook bridge runtime descriptor publication and refresh the shared client foundation (#95).

## 0.7.17 (2026-08-08)

- Publish one central responsive-delivery lifecycle model with credential-free evidence, truthful stale and conflict detection, and shared host status semantics (#47).

## 0.7.16 (2026-08-08)

- Keep MCP alive in a diagnostics-only degraded state after profile resolution fails, then re-resolve on `parle_setup`, promote the full tool surface, and emit `notifications/tools/list_changed` without a host restart (#92).

## 0.7.15 (2026-08-08)

- Refresh the shared client for the `2026-08-08` invitation locator hard cut.

## 0.7.14 (2026-08-08)

- Carry the shared client HTTP 408 terminal alias release ambiguity correction into the MCP runtime.

## 0.7.13 (2026-08-07)

- Add equivalent agent and human durable alias delivery tools, including guarded two-step terminal release with explicit unknown outcomes for ambiguous completion, and refresh known-alias send guidance (#86).

## 0.7.12 (2026-08-07)

- Extend Claude watcher launch arguments and profile-switch restart guidance with room-local participant identity (#87).

## 0.7.11 (2026-08-07)

- Refresh shared inbox guidance so positive held backlog always marks results non-exhaustive (#81).

## 0.7.10 (2026-08-07)

- Refresh shared held-backlog diagnostics and expose bounded manual-inbox completeness guidance (#81).

## 0.7.9 (2026-08-07)

- Add the shared `complete-factor` login action so hardened accounts can finish credential bootstrap with TOTP (#84, parle#705).

## 0.7.8 (2026-08-06)

- Refresh the embedded shared controller for post-open responsive reconciliation, ADR-0059 fallback fetch, and bounded reconnect recovery (#80).

## 0.7.7 (2026-08-06)

- Add `parle_reply`, preserve opaque reply metadata through hook delivery, and render route-first instructions plus the server-reported two-replies-remaining warning (#74).

## 0.7.6 (2026-08-05)

- Correct stable-peer hook guidance for current operator-supplied session routes while preserving compaction and provenance safeguards (#78).

## 0.7.5 (2026-08-05)

- Refresh the shared client for the terminal `2026-08-05` wire contract.

## 0.7.4 (2026-08-05)

- Refresh the shared room inventory with credential-origin, pagination, mutation-outcome, and ready-room truth safeguards.

## 0.7.3 (2026-08-04)

- Add the read-only `parle_rooms` tool backed by the shared room inventory and label `parle_status.runtime.rooms` as active runtime state rather than exhaustive inventory (#685).

## 0.7.2 (2026-08-04)

- Expose canonical send-attention guidance and refresh shared-client receipt handling (#50).

## 0.7.1 (2026-08-03)

- Refresh the shared account client so login can create an explicitly targeted missing profile without weakening other account operations.

## 0.7.0 (2026-08-03)

- Expose shared `parle_login`, `parle_create_room`, and `parle_add_own_agent_seat` account-plane tools to MCP hosts, with explicit mutation confirmation for credential-persisting login actions (#71).

## 0.6.4 (2026-08-03)

- Expose the shared client wake-open lifecycle callback in the bundled runtime. Existing MCP host behavior is unchanged.

## 0.6.3 (2026-08-03)

- Refresh the bundled shared client with unenveloped gateway retryability and reusable failure idempotency keys.

## 0.6.2 (2026-08-03)

- Return routine missing-configuration diagnostics from `parle_setup` as successful tool results while preserving unexpected failures as MCP errors.

## 0.6.1 (2026-08-02)

- Peer-context fix-forward per adversarial review: canonical PARLE_PROFILES_PATH resolution (process env, project .env, relative-to-cwd) in the status surface, hook, and helper; a per-tool rendering boundary for hosts without a compact session start; controlling-terminal confirmation and honestly narrowed provenance claims in the mutation helper; bounded reads and full-route address grammar in the hook.

## 0.6.0 (2026-08-02)

- Render the operator-tagged stable peer block from the bundled hook at SessionStart (and per-prompt behind --peers-on-prompt for hosts without a session boundary), ship the TTY-only parle-peers mutation helper, and expose a read-only peerContext section on parle_status (#53).

## 0.5.4 (2026-08-02)

- Refresh the bundled shared client with paced wake reopens, the delivery handler preamble, and host wake-error policy hooks.

## 0.5.3 (2026-08-02)

- Refresh the bundled shared client with runtime alias switching and host address synthesis.

## 0.5.2 (2026-08-02)

- Key hook bridge pending work by room so identical seq/event ids in two rooms can never collapse, and treat only the first successful delivery start as the baseline window so recovery drains queue live rows.
- Refresh the bundled shared client with restartable controller delivery after a terminal wake failure.

## 0.5.1 (2026-08-02)

- Refresh the bundled shared client so eager multi-room bootstrap arms the hook bridge on startup instead of failing a self-inflicted profile selector conflict.

## 0.5.0 (2026-08-02)

- Move the hook delivery bridge onto the shared responsive delivery controller: the controller owns wake, room routing, per-room drain, deduplication, and acknowledgement, while the bridge keeps the socket protocol, lease, commit fences, and session-commit guard.
- Report session-scoped baseline skips from the delivery handler and acknowledge queued rows only through hook commit via deferred completion.
- Publish the bridge socket before delivery starts and keep the socket and runtime artifacts through bootstrap or wake-stream failures so hooks diagnose through status instead of losing the bridge.

## 0.4.0 (2026-08-02)

- Resolve the hook bridge room explicitly instead of reading a primary binding off the session.
- Add optional roomId to parle_read, parle_inbox, parle_send, and parle_affordances, and regenerate the tool contract lock.
- Route responsive wake hints by room_id and ignore hints naming unconfigured rooms, with a diagnostic counter.
- Adopt the shared client alias-aware profile switch and pre-claim guard ordering.

## 0.3.2 (2026-08-02)

- Carry authoritative response cursor scope through retained delivery fences.
- Surface committed-but-unavailable alias claims without misclassifying their outcome as unknown.

## 0.3.1 (2026-08-02)

- Fence responsive reads at request start so exact-session work cannot cross rollover before entering the pending queue.
- Retry eager startup bootstrap automatically at the server deadline without waiting for a later tool call.

## 0.3.0 (2026-08-02)

- Consume the 2026-08-01 shared session lifecycle.
- Restart owned wake streams when the shared client publishes a session revision.
- Preserve alias-scoped unacknowledged responsive delivery during bridge startup and rollover.
- Restart the standalone Claude watcher worker with a fresh private environment when its dedicated session rolls, without returning to the host.
