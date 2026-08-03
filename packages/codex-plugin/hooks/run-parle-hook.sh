#!/bin/sh

parle_hook_noop() {
  printf '%s\n' '{}'
  exit 0
}

[ -n "${HOME:-}" ] || parle_hook_noop
[ -n "${PLUGIN_ROOT:-}" ] || parle_hook_noop

LC_ALL=C
export LC_ALL
# Trusted runtime discovery order: an explicit absolute override, the live
# hook-bridge runtime handles, then fixed absolute system paths. PATH is
# never consulted, so a hostile PATH cannot substitute the runtime, and peer
# context still renders when no responsive-delivery bridge is armed.
parle_hook_state_dir="${HOME}/.local/state/parle/hook-bridge/b52cc0f7fef9d88d"

if [ -n "${PARLE_HOOK_RUNTIME:-}" ]; then
  case "$PARLE_HOOK_RUNTIME" in
    /*)
      if [ -x "$PARLE_HOOK_RUNTIME" ] && [ -f "$PARLE_HOOK_RUNTIME" ]; then
        "$PARLE_HOOK_RUNTIME" "${PLUGIN_ROOT}/hooks/parle-hook.mjs" "$@" && exit 0
        printf '%s\n' "Parle hook runtime failed; continuing without responsive delivery." >&2
        parle_hook_noop
      fi
      ;;
  esac
fi

if [ ! -d "$parle_hook_state_dir" ]; then
  for parle_hook_fallback in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    if [ -x "$parle_hook_fallback" ] && [ -f "$parle_hook_fallback" ]; then
      "$parle_hook_fallback" "${PLUGIN_ROOT}/hooks/parle-hook.mjs" "$@" && exit 0
      printf '%s\n' "Parle hook runtime failed; continuing without responsive delivery." >&2
      parle_hook_noop
    fi
  done
  parle_hook_noop
fi

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

for parle_hook_fallback in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
  if [ -x "$parle_hook_fallback" ] && [ -f "$parle_hook_fallback" ]; then
    "$parle_hook_fallback" "${PLUGIN_ROOT}/hooks/parle-hook.mjs" "$@" && exit 0
    printf '%s\n' "Parle hook runtime failed; continuing without responsive delivery." >&2
    parle_hook_noop
  fi
done

parle_hook_noop
