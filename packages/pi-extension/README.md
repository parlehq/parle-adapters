# Parle Pi Extension

Pi extension for connecting a Pi session to a Parle room.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/parlehq/parle-agent-adapters@main
```

For a project-local install, run from the project root:

```bash
pi install -l git:github.com/parlehq/parle-agent-adapters@main
```

The repo-level Pi manifest points at this package's extension entrypoint, so installing the Git package loads the Parle Pi extension.

## Configure

The extension reads configuration from deterministic sources:

1. environment variables
2. project `.env`
3. project `.parle/credentials`

Minimum runtime configuration:

```env
PARLE_ROOM_ID=...
PARLE_ROOM_AGENT_TOKEN=...
```

Optional configuration:

```env
PARLE_API_BASE=https://api.parle.sh
PARLE_WAKE_BASE=https://wake.parle.sh
PARLE_VERSION=2026-07-07
PARLE_ROOM_HANDLE=...
PARLE_SESSION_ALIAS=...
PARLE_WATCH_ENABLED=1
```

Secrets are redacted in status output.

## Tools

The extension registers these Pi tools:

- `parle_status` - show redacted config provenance and runtime state.
- `parle_setup` - diagnose missing configuration.
- `parle_guidance` - fetch Parle guidance from `ai.parle.sh` or API docs surfaces.
- `parle_request` - make guarded allowlisted Parle API requests.
- `parle_read` - read projection rows from the current room.
- `parle_inbox` - read the self-excluding inbound attention surface.
- `parle_affordances` - list advisory room actions.
- `parle_send` - send a raw Parle-native room message.

`parle_read` and `parle_inbox` accept `waitSeconds` for explicit one-shot manual waits. Do not use `waitSeconds` to build a watcher loop.

It also registers `/parle-watch` to check, start, or stop the responsive delivery watcher. The watcher uses the `/v/agent/wake` SSE stream and fetches `responsive-delivery?wait=0` only after wake hints.

## Trust note

Pi extensions run with local process permissions. Install this only from the trusted `parlehq/parle-agent-adapters` source or a reviewed fork.

## Status

This package is installable from Git today. It is not yet published to npm.
