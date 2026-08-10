#!/bin/sh
# Public Claude watcher entrypoint. Configuration is resolved afresh on every
# invocation by the bundled Node resolver, including manual re-arms. After a
# live MCP switch, `--profile NAME` selects that profile explicitly; the Node
# launcher freezes its concrete binding for the worker. The room agent token is
# passed only in the worker child environment.
# Usage: parle-watch.sh [--profile <name>] <since_seq> [my_agent_session_id [my_participant_id]]
set -u
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 2
plugin_root=$(CDPATH= cd "$script_dir/../../.." && pwd) || exit 2

# Claude Code records the active plugin roots in an operator-local manifest. If
# that authoritative entry is readable, refuse to launch from an inactive cache
# directory. Unknown or unavailable manifest state is intentionally a silent
# no-op so source checkouts and other hosts retain their existing behavior.
node --input-type=module - "$plugin_root" <<'NODE'
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const pluginName = "parle-claude-plugin";
const launcherRoot = realpathSync(process.argv[2]);
const cachePath = join(homedir(), ".claude", "plugins", "cache");
let cacheRoot;
try {
  cacheRoot = realpathSync(cachePath);
} catch {
  cacheRoot = resolve(cachePath);
}
const fromCache = relative(cacheRoot, launcherRoot);
if (fromCache.startsWith("..") || isAbsolute(fromCache)) process.exit(0);
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8"));
} catch {
  process.exit(0);
}

if (!manifest || typeof manifest !== "object" || !manifest.plugins || typeof manifest.plugins !== "object") process.exit(0);
const matchingValues = Object.entries(manifest.plugins)
  .filter(([key]) => key.startsWith(`${pluginName}@`))
  .map(([, value]) => value);
if (matchingValues.length === 0 || matchingValues.some((value) => !Array.isArray(value))) process.exit(0);
const installs = matchingValues.flat();
if (installs.length === 0 || installs.some((entry) => !entry || typeof entry !== "object" || typeof entry.installPath !== "string" || !isAbsolute(entry.installPath))) process.exit(0);
let activeRoots;
try {
  activeRoots = installs.map((entry) => realpathSync(entry.installPath));
} catch {
  process.exit(0);
}
const containsLauncher = activeRoots.some((root) => {
  const fromRoot = relative(root, launcherRoot);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
});
if (containsLauncher) process.exit(0);

const launchers = activeRoots.map((root) => join(root, "skills", "parle", "scripts", "parle-watch.sh"));
console.error(`Parle stopped: this watcher belongs to an inactive Claude plugin cache. Re-arm through the current parle skill or an active launcher: ${launchers.join(", ")}`);
process.exit(2);
NODE
guard_status=$?
if [ "$guard_status" -ne 0 ]; then
  exit "$guard_status"
fi

artifact="$plugin_root/dist/parle-mcp.js"
if [ ! -f "$artifact" ]; then
  echo "Parle stopped: bundled watcher resolver is missing; reinstall or rebuild the Claude plugin." >&2
  exit 2
fi
exec node "$artifact" --parle-watch "$@"
