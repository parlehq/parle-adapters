---
name: parle-statusline
description: Wire the Parle session segment into the user's Claude Code status line (install, upgrade to a dedicated full-width row, or troubleshoot the display).
---

# Parle Statusline Setup

Use this skill when the user asks to install, enable, or fix the Parle statusline. Claude Code plugins cannot set the main `statusLine` setting themselves, so this skill performs the wiring with the user's consent: the user invoking this skill is that consent.

The segment script ships with this plugin at `statusline/parle-statusline.mjs`. It is read-only, dependency-free, and prints one of: `parle ✓ @principal.agent.session` (one live session in the cwd), `parle ✓ N sessions` (several; no specific address, since it could belong to a sibling Claude session), `parle · off` (configured, no live session), or nothing (unconfigured cwd). Pass `--full` for a roomier variant with room handle, relative expiry, and an explicit address list when several sessions are live. The display is cwd-scoped, not Claude-session-authoritative.

## Install steps

1. Resolve the installed plugin directory, newest version wins so plugin updates keep working:

```sh
plugin_dir=$(ls -d "$HOME/.claude/plugins/cache/parlehq/parle-claude-plugin"/*/ 2>/dev/null | sort -V | tail -1)
```

Verify `${plugin_dir}statusline/parle-statusline.mjs` exists before proceeding. If the cache layout differs (marketplace paths can change), locate `parle-statusline.mjs` under `$HOME/.claude/plugins` and use that path instead.

2. Read `~/.claude/settings.json` and check for an existing `statusLine` entry.

3. If there is NO existing statusLine: write `~/.claude/statusline.sh` (mode 0755) with the template below, then set in settings.json:

```json
"statusLine": { "type": "command", "command": "/absolute/path/to/.claude/statusline.sh", "refreshInterval": 30 }
```

Template (two rows: cwd, then a dedicated full-width Parle row that disappears when there is nothing to show):

```sh
#!/bin/sh
input=$(cat)
plugin_dir=$(ls -d "$HOME/.claude/plugins/cache/parlehq/parle-claude-plugin"/*/ 2>/dev/null | sort -V | tail -1)
parle=""
if [ -n "$plugin_dir" ] && [ -f "${plugin_dir}statusline/parle-statusline.mjs" ]; then
  parle=$(printf '%s' "$input" | node "${plugin_dir}statusline/parle-statusline.mjs" --full 2>/dev/null)
fi
pwd
[ -n "$parle" ] && printf '%s\n' "$parle"
```

4. If a statusLine command ALREADY exists: read the user's script first, show them what you intend to change, and append the Parle segment without disturbing their existing output. Two options, pick with the user: append `$parle` to their existing row (compact), or emit it as an additional row via a trailing `printf` (roomy, uses `--full`). Never replace their script wholesale.

5. Tell the user the statusline updates on the settings refresh interval and that Claude Code renders each stdout line as its own row, so the Parle row only occupies space when a session exists.

## Troubleshooting

- Empty segment in a configured repo: the MCP server writes `.parle/runtime/<pid>.json` at bootstrap; check the directory exists and a snapshot has `state: "ready"` with a future `expiresAt`. `parle_status` with `inspect: true` shows the same state without side effects.
- Segment shows `parle · off` while tools work: the runtime file may be missing (plugin older than 0.4.0) or the session expired; run `parle_status` to reconnect.
- Start-time verification is best-effort hardening, not a liveness prerequisite: where process inspection is unavailable (hosts that deny `ps`), the check is skipped and session expiry bounds the pid-reuse window.
