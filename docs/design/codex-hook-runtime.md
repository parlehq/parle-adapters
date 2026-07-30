# Codex Hook Runtime

Status: implemented and adversarially approved
Date: 2026-07-30
Owner repo: `parlehq/parle-adapters`
Related: `codex-adapter.md`, `api-first-adapter-foundation.md`

## Problem

Codex executes command hooks through the user login shell with the session working directory. A plugin command that launches `node` therefore inherits shell startup behavior, runtime manager shims, project trust checks, and arbitrary path ordering before plugin code can run.

The Parle Codex plugin currently launches its hook with ambient Node resolution. In a project whose mise configuration is not trusted, all lifecycle hooks exit before the JavaScript handler starts. Changing directory inside the command does not establish a runtime contract and still leaves login shell startup and path resolution outside plugin control.

Two earlier corrections addressed real but incomplete failure modes:

1. Successful no-delivery hooks must emit valid JSON.
2. Hook commands must not assume the session working directory is the plugin root.

Neither establishes which JavaScript runtime executes the hook.

## API-first classification

This is host lifecycle and packaging behavior, not Parle protocol meaning.

1. The HTTP API cannot select a local Codex hook runtime.
2. OpenAPI and discovery guidance cannot prevent a login shell from resolving an unsafe interpreter.
3. ADR-0036 framing and server delivery semantics remain unchanged.
4. The shared hook bridge can publish runtime evidence for every local host that enables it.
5. The runtime handoff is private local state and does not affect third-party HTTP integrations.
6. The fix belongs in the L2 hook bridge and the L3 Codex launcher.

No API interpretation debt is introduced.

## Decision

The running MCP hook bridge publishes the exact executable that started it. The Codex plugin uses one stable, fail-open shell launcher to execute the JavaScript hook with that runtime.

The design has three cooperating artifacts:

1. A diagnostic runtime descriptor named `<pid>.runtime.json`.
2. An executable runtime handle named `<pid>.node`.
3. A stable Codex launcher named `run-parle-hook.sh`.

The descriptor and handle live beside `<pid>.sock` in the existing owner-only hook bridge state directory.

## Invariants

1. A Parle hook never breaks or blocks the Codex host because local runtime discovery failed.
2. The launcher never resolves Node through ambient `PATH`.
3. The launcher command string remains stable across future releases.
4. The JavaScript hook uses the same real Node executable as a running MCP bridge.
5. No bridge means no responsive delivery, so a no-op JSON result is correct.
6. Delivery remains at least once. A failed commit does not acknowledge the leased messages.
7. Runtime state contains no Parle credential, token, cookie, session handle, or room content.
8. State files remain owner-only and are removed on clean bridge shutdown.
9. Windows hooks are an explicit no-op while the bridge depends on Unix sockets.
10. Login-shell output or failure before the launcher starts is a Codex host boundary and must be documented separately.
11. Failure to arm responsive delivery never prevents the MCP server or its normal tools from starting.

## Bridge runtime publication

When the bridge creates `<pid>.sock`, it also creates:

```json
{
  "execPath": "/absolute/path/to/node",
  "pid": 12345,
  "startedAt": "2026-07-30T12:00:00.000Z"
}
```

Publication requirements:

- Reject a non-absolute or non-executable `process.execPath`.
- Write the descriptor through a same-directory temporary file, set mode `0600`, then rename.
- Create a temporary symbolic link to `process.execPath`, then rename it to `<pid>.node`.
- Publish both artifacts only inside the already validated owner-only state directory.
- Remove the socket, descriptor, handle, and abandoned temporary files on clean shutdown.
- Treat publication failure as hook-bridge arming failure only. Record the failure in bridge status, keep `running` false, and let the MCP server and its normal tools continue.
- On platforms or filesystems without symbolic-link support, report responsive delivery as unarmed with the recorded failure. Do not fail MCP startup and do not affect hosts that did not enable hook-bridge delivery.
- On bridge startup, remove dead-process sockets, descriptors, handles, and abandoned temporary files from the same validated scope directory. Permission errors that can mean a process is alive do not authorize cleanup.

The JSON descriptor is for diagnostics and tests. The symbolic link is the machine-executable contract. This split avoids parsing JSON in the shell launcher.

## Stable launcher

The Codex hook command points only at the packaged launcher under `PLUGIN_ROOT`. Future handler changes occur behind this stable path so hook trust does not churn.

The POSIX launcher uses shell builtins only:

1. Resolve the state directory with a build-time-baked key for the fixed `codex-plugin` scope.
2. Iterate runtime handles in that directory.
3. Extract and validate the numeric process id from each filename.
4. Require `kill -0` to confirm a live process.
5. Require the runtime handle to be executable.
6. Execute the JavaScript handler through that absolute runtime handle.
7. On every missing, invalid, or failed discovery path, print `{}` and exit zero.

The launcher guards missing `HOME` and `PLUGIN_ROOT` explicitly and does not enable shell options that could exit before the no-op result. A glob that matches no runtime handle is rejected by the executable check.

Runtime handles are considered in C-locale pathname expansion order. The first live executable handle wins. Any valid handle is sufficient because it selects only the Node runtime; the JavaScript handler independently selects bridge sockets by modification time and session binding.

The launcher does not use `cd`, `env`, `find`, `readlink`, `stat`, `sort`, `node`, `python`, `jq`, `nc`, or any other external command.

The launcher may record one bounded diagnostic reason under `PLUGIN_DATA` only if it can do so without changing the fail-open behavior. Diagnostics are optional for the first release because shell redirection itself can fail.

Codex documents `commandWindows` as the Windows-only command override for command hooks, and Codex 0.146.0 includes the same field in its hook configuration schema. Every hook entry uses that override to run a `cmd` no-op that prints `{}` and exits successfully. Responsive lifecycle delivery on Windows remains unsupported until the bridge has a non-Unix transport design.

Source: <https://developers.openai.com/codex/hooks>

## JavaScript handler contract

The JavaScript handler has one top-level fail-open boundary.

Before hook output is written:

- Parse, input, socket, and bridge errors write a concise diagnostic to standard error.
- The handler writes `{}` to standard output and exits zero.

After valid delivery output is written:

- Commit failure writes a concise diagnostic to standard error and exits zero without writing a second JSON value.
- The lease remains uncommitted and can be delivered again.

Per-event delivery output:

- `UserPromptSubmit`, `PreToolUse`, and `PostToolUse` return only the accepted event name and `additionalContext`.
- `PreToolUse` does not return `permissionDecision` because the hook is adding context, not making an authorization decision.
- `Stop` returns the supported continuation decision with the delivered context.
- Unknown events fail open with `{}` and do not commit a delivery.

The output schema source of truth is the Codex hook documentation for the installed release, cross-checked against Codex 0.146.0 hook wire types and rejection strings. The binary explicitly rejects `PreToolUse permissionDecision:allow`. The documented `additionalContext` and `Stop decision:block` shapes are exercised by per-event golden tests and an installed-plugin delivery smoke test.

The handler does not truncate `additionalContext`. Codex applies the configured `additionalContextLimit` value of 5000 as an approximate token spill threshold. Spilled context reaches the model as a preview with recovery metadata according to the host contract. The bridge already bounds hook batches by bytes and count.

No-delivery invocations return `{}`.

## Delivery and duplicate semantics

The hook writes valid host output before asking the bridge to commit the lease. Commit acknowledges the responsive-delivery messages to Parle.

If commit fails after output:

- the model may already have received the context
- the lease stays uncommitted
- concurrent hooks see the active lease as busy
- the same batch becomes eligible again only after the 30-second lease expires
- a later lifecycle event can inject the same context again

Persistent commit failure therefore permits at most one duplicate batch per lease interval for a bridge, rather than a hot loop on every hook event. Duplicate context is preferred to silent message loss because Parle must not acknowledge a coordination message that the host may never have received. Message sequence and event identifiers remain in the injected context so the model and diagnostics can recognize a repeat.

## Security

The state directory is already validated as:

- a real directory
- not a symbolic link
- owned by the current user where user identifiers are available
- mode `0700`

Runtime artifacts add no new cross-user authority. The handle points to the executable of a process already running under the same user. The launcher still validates liveness and executability before use.

Stale artifacts after a crash are harmless:

- a dead process id is rejected
- a missing executable is rejected
- process id reuse can only select an executable Node runtime previously published by the same user's bridge directory
- the JavaScript handler still selects and authenticates bridge sockets through the existing session binding

## Package and release impact

Runtime publication changes `@parlehq/mcp-server`. Every wrapper carrying the rebuilt artifact must receive a version and changelog decision in the same release:

- `@parlehq/mcp-server`
- `@parlehq/codex-plugin`
- `@parlehq/command-code-adapter`
- Claude Code plugin
- Claude Desktop extension

Only the Codex plugin changes its hook command. Its release notes must require:

1. plugin update
2. new session
3. hook review and trust because the command hash changes

The new launcher command is intended to be the final command-string change.

Hosts that do not enable hook-bridge delivery do not publish runtime artifacts and cannot fail because of their publication. Hook-bridge consumers on unsupported filesystems keep normal MCP tools and report responsive delivery as unarmed.

## Validation

### Bridge lifecycle

- descriptor and runtime handle are published atomically
- modes and targets are correct
- status reports armed only after publication succeeds
- publication failure leaves the MCP server and normal tools available while status reports unarmed with a diagnostic
- clean shutdown removes all runtime artifacts
- startup garbage collection removes only dead-process artifacts in the active scope
- startup records unsafe state directories and invalid executable paths as unarmed bridge failures without failing MCP tools

### Launcher matrix

Run through `/bin/sh` and `dash` when available:

- missing state directory
- no descriptors
- dead process id
- malformed process id
- missing runtime target
- non-executable runtime target
- one valid runtime handle
- multiple live handles select the first handle in C-locale pathname order
- hostile shims-first `PATH`
- session working directory containing an untrusted mise configuration
- baked scope key equals the handler's hash derivation for `codex-plugin`

Every failure leg must return exit zero with exactly one parseable JSON object. The success leg must preserve standard input and arguments.

### Codex launch fidelity

- read the exact command from `hooks.json`
- invoke it through the same login-shell shape Codex uses
- run the fidelity harness through both `zsh -lc` and `bash -lc`
- set `PLUGIN_ROOT` to a path containing spaces
- use fixture shell startup files that alter `PATH` and emit diagnostics only to standard error
- verify all four lifecycle events
- document that startup files writing to standard output remain an upstream host limitation

### Handler output

- golden output for `UserPromptSubmit`
- golden output for `PreToolUse`
- golden output for `PostToolUse`
- golden output for `Stop`
- real delivery-path output for every registered event through a staged plugin installed in a disposable Codex home
- unknown event
- malformed input
- no session id
- no delivery
- commit failure after output

### Package validation

- command literal stability assertion with an explanatory comment
- launcher executable bit
- copied MCP artifact parity
- manifest version parity
- package tests
- workspace typecheck
- full workspace tests
- shell syntax check
- shellcheck when available
- one interactive installed-plugin smoke test after hook trust approval

## Acceptance criteria

The design is ready to implement when an adversarial reviewer explicitly confirms:

1. runtime discovery no longer depends on ambient path or runtime-manager trust
2. every plugin-owned failure path is fail-open
3. output-before-commit preserves at-least-once delivery, limits retry to one batch per lease interval, and never acknowledges before output
4. hook output matches Codex 0.146.0 accepted schemas
5. the stable command minimizes future trust churn
6. tests reproduce the real login-shell launch boundary
7. package version and rollout consequences are complete

Implementation may ship only after the same reviewer gives an explicit LGTM on the final diff and validation evidence.
