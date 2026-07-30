#!/bin/sh
# Public Claude watcher entrypoint. Configuration is resolved afresh on every
# invocation by the bundled Node resolver, including manual re-arms. After a
# live MCP switch, `--profile NAME` selects that profile explicitly; the Node
# launcher freezes its concrete binding for the worker. The room agent token is
# passed only in the worker child environment.
# Usage: parle-watch.sh [--profile <name>] <since_seq> [my_agent_session_id]
set -u
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 2
artifact="$script_dir/../../../dist/parle-mcp.js"
if [ ! -f "$artifact" ]; then
  echo "Parle stopped: bundled watcher resolver is missing; reinstall or rebuild the Claude plugin." >&2
  exit 2
fi
exec node "$artifact" --parle-watch "$@"
