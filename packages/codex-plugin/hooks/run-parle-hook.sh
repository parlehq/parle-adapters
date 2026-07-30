#!/bin/sh

parle_hook_noop() {
  printf '%s\n' '{}'
  exit 0
}

[ -n "${HOME:-}" ] || parle_hook_noop
[ -n "${PLUGIN_ROOT:-}" ] || parle_hook_noop

LC_ALL=C
export LC_ALL
parle_hook_state_dir="${HOME}/.local/state/parle/hook-bridge/b52cc0f7fef9d88d"
[ -d "$parle_hook_state_dir" ] || parle_hook_noop

for parle_hook_runtime in "$parle_hook_state_dir"/*.node; do
  [ -x "$parle_hook_runtime" ] || continue
  parle_hook_name=${parle_hook_runtime##*/}
  parle_hook_pid=${parle_hook_name%.node}
  case "$parle_hook_pid" in
    ""|*[!0-9]*) continue ;;
  esac
  kill -0 "$parle_hook_pid" 2>/dev/null || continue
  "$parle_hook_runtime" "${PLUGIN_ROOT}/hooks/parle-hook.mjs" "$@" && exit 0
  printf '%s\n' "Parle hook runtime failed; continuing without responsive delivery." >&2
  parle_hook_noop
done

parle_hook_noop
