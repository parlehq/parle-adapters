#!/bin/sh
# parle-watch.sh -- exit 0 when relevant room activity lands past SINCE_SEQ.
#
# Run in the background from a Claude Code session; the exit re-wakes the
# session, which then drains parle_inbox and restarts the watch. One held
# long-poll connection, no tight loops.
#
# Usage: parle-watch.sh <since_seq> [my_agent_session_id]
#
# With my_agent_session_id set, rows you authored and directs addressed to
# other sessions are skipped instead of waking you, so busy multi-session
# rooms stay quiet and the own-send restart caveat disappears. Your id is
# the addressing.target_agent_session_id on any direct you received, or
# author.agent_session_id on rows you authored in parle_read. Without it,
# any new room row wakes you (v1 behavior).
#
# Needs: PARLE_API_BASE, PARLE_ROOM_ID, PARLE_ROOM_AGENT_TOKEN, PARLE_VERSION
# Exit:  0 = relevant activity past since_seq, 2 = terminal or repeated failures
#
# Config self-loads from the same sources and precedence as the adapters
# client: process env first, then ./.env, then ./.parle/credentials (relative
# to the cwd). Run it from the project directory and no env injection or
# wrapper is needed.
set -u
since="${1:?usage: parle-watch.sh <since_seq> [my_agent_session_id]}"
me="${2:-}"

load_missing() {
  key="$1"
  eval "current=\${$key:-}"
  [ -n "$current" ] && return 0
  for f in ./.env ./.parle/credentials; do
    [ -f "$f" ] || continue
    val=$(sed -n "s/^[[:space:]]*${key}=//p" "$f" | head -1 | tr -d '\r')
    # strip one layer of matching quotes
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    if [ -n "$val" ]; then
      export "$key=$val"
      return 0
    fi
  done
}
load_missing PARLE_API_BASE
load_missing PARLE_ROOM_ID
load_missing PARLE_ROOM_AGENT_TOKEN
load_missing PARLE_VERSION
: "${PARLE_API_BASE:=https://api.parle.sh}"
: "${PARLE_VERSION:=2026-07-07}"
if [ -z "${PARLE_ROOM_ID:-}" ] || [ -z "${PARLE_ROOM_AGENT_TOKEN:-}" ]; then
  echo "Parle stopped: required host configuration is missing. PARLE_ROOM_ID / PARLE_ROOM_AGENT_TOKEN not found in env, ./.env, or ./.parle/credentials (run from the project directory)" >&2
  exit 2
fi

fails=0
while :; do
  tmp=$(mktemp "${TMPDIR:-/tmp}/parle-watch.XXXXXX") || exit 2
  status=$(curl -sS --max-time 40 -o "$tmp" -w '%{http_code}' \
    "$PARLE_API_BASE/v/rooms/$PARLE_ROOM_ID/projection?since_seq=$since&wait=25" \
    -H "Authorization: Bearer $PARLE_ROOM_AGENT_TOKEN" \
    -H "Parle-Version: $PARLE_VERSION") || status="000"
  resp=$(cat "$tmp")
  rm -f "$tmp"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    action=$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    err = (json.load(sys.stdin).get("error") or {})
except Exception:
    err = {}
print(err.get("action") or "network")
print(err.get("code") or "")
print(err.get("retry_after_ms") or "")
')
    err_action=$(printf '%s\n' "$action" | sed -n '1p')
    err_code=$(printf '%s\n' "$action" | sed -n '2p')
    retry_after_ms=$(printf '%s\n' "$action" | sed -n '3p')
    case "$err_action" in
      fix_client)
        echo "Parle stopped: client request is invalid; upgrade or repair the adapter. ${err_code}" >&2
        exit 2
        ;;
      reauthorize)
        echo "Parle stopped: agent token is invalid or revoked; reauthorize the agent. ${err_code}" >&2
        exit 2
        ;;
      rebootstrap)
        echo "Parle stopped: agent session is dead; reconnect with parle_connect and re-arm. ${err_code}" >&2
        exit 2
        ;;
      stop)
        echo "Parle stopped: agent session could not be rebootstrapped; reauthorize or restart. ${err_code}" >&2
        exit 2
        ;;
      backoff|retry_with_backoff|retry)
        fails=$((fails + 1))
        [ -n "$retry_after_ms" ] && sleep_secs=$(( (retry_after_ms + 999) / 1000 )) || sleep_secs=$((fails * 5))
        if [ "$fails" -ge 5 ]; then
          echo "parle-watch: retry budget exhausted after $fails failures" >&2
          exit 2
        fi
        echo "Parle paused: retrying after ${sleep_secs}s (${err_code:-$err_action})." >&2
        sleep "$sleep_secs"
        continue
        ;;
      *)
        fails=$((fails + 1))
        if [ "$fails" -ge 5 ]; then
          echo "parle-watch: $fails consecutive network failures, giving up" >&2
          exit 2
        fi
        sleep $((fails * 5))
        continue
        ;;
    esac
  fi
  fails=0
  out=$(printf '%s' "$resp" | python3 -c '
import json, sys
me = sys.argv[1]
d = json.load(sys.stdin)
rows = d.get("messages") or []
top = max([r.get("seq", 0) for r in rows] + [int(d.get("watermark") or 0)])
def relevant(r):
    author = (r.get("author") or {}).get("agent_session_id") or ""
    addr = r.get("addressing") or {}
    if me and author == me:
        return False
    if me and addr.get("kind") == "direct" and addr.get("target_agent_session_id") != me:
        return False
    return True
print("HIT" if any(relevant(r) for r in rows) else "PASS", top)
' "$me") || out="PASS $since"
  state=${out%% *}
  top=${out##* }
  if [ "$state" = "HIT" ]; then
    echo "parle-watch: relevant activity, seq $since -> $top"
    exit 0
  fi
  if [ "$top" -gt "$since" ] 2>/dev/null; then
    since=$top
  fi
done
