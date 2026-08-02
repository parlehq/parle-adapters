#!/bin/sh
# parle-watch.sh -- exit 0 when relevant room activity lands past SINCE_SEQ.
#
# Run in the background from a Claude Code session; the exit re-wakes the
# session, which then drains parle_inbox and restarts the watch. One held
# long-poll connection, no tight loops.
#
# Public usage: Usage: parle-watch.sh [--profile <name>] <since_seq> [my_agent_session_id]
# Private worker argv: <since_seq> [my_agent_session_id]
#
# With my_agent_session_id set, rows you authored and directs addressed to
# other sessions are skipped instead of waking you, so busy multi-session
# rooms stay quiet and the own-send restart caveat disappears. Your id is
# the addressing.target_agent_session_id on any direct you received, or
# author.agent_session_id on rows you authored in parle_read. Without it,
# any new room row wakes you (v1 behavior).
#
# Session liveness: the projection poll authenticates with the room agent
# token plus a dedicated watcher-session credential owned by the Node launcher.
# That credential is distinct from the primary session this script filters on,
# so the server still cannot tell this script that the filtered session has
# died (host reload, session end). When my_agent_session_id
# is set, each cycle also checks the local .parle/runtime/*.json snapshots
# the adapters publish. After observing the primary session live, the watcher
# binds it to that exact runtime file and live writer identity. If that file is
# atomically rewritten by the same pid, with a matching validated process
# start and clientInstanceId, to a new live agentSessionId, the watcher follows the
# transition and updates its local filter before the next projection request.
# Unrelated sibling snapshots can never trigger that transition.
#
# Own-snapshot evidence is classified before absence counts for anything: a
# snapshot carrying this id that is expired (or within the 30s guard band) or
# whose writer pid is dead or verifiably recycled (process start time
# mismatches processStartedAt, checked via /proc then ps etime where available)
# is AFFIRMATIVE evidence the session is gone and exits 3 regardless of
# history; one that is present but not ready (bootstrap retry or failure in
# progress) holds as inconclusive. Plain absence is era-gated: only after this
# watch has itself seen the session live in a snapshot does present-then-absent
# (for two consecutive checks) exit 3. A session id that was NEVER present is
# inconclusive -- the host may predate snapshot publishing, use another cwd,
# or lack a runtime file for a live server (observed in the field,
# adapters#22) -- so the watch notes it once
# on stderr and keeps holding. No snapshots at all is likewise indeterminate
# (direct-HTTP sessions publish none). Every exit 3 is preceded by a
# redaction-safe per-file forensics dump on stderr so a disputed verdict is
# arguable from evidence. Set PARLE_WATCH_SESSION_LIVENESS=0 to disable the
# check entirely.
#
# Needs: PARLE_API_BASE, PARLE_ROOM_ID, PARLE_ROOM_AGENT_TOKEN
# Exit:  0 = relevant activity past since_seq, 2 = terminal or repeated
#        failures, 3 = my_agent_session_id is gone from this host (reconnect
#        with parle_connect and arm a fresh watch; do not re-arm with the old
#        id or watermark). If the same observed snapshot reaches its expiry
#        guard band without a verified in-process rewrite, exit 3 is failed
#        rollover evidence, not expected proactive rollover. If parle_connect
#        says the same session is alive with plenty of TTL, re-arm with
#        PARLE_WATCH_SESSION_LIVENESS=0 while investigating the false verdict.
#
# The public parle-watch.sh entrypoint always launches this private worker
# through the bundled Node resolver. It applies the shared client precedence
# and profile semantics on every arm, then supplies the resolved binding only
# through this child's environment. Do not invoke this worker directly.
set -u
since="${1:?usage: parle-watch.sh <since_seq> [my_agent_session_id]}"
me="${2:-}"
: "${PARLE_API_BASE:?resolved watcher configuration missing}"
: "${PARLE_ROOM_ID:?resolved watcher configuration missing}"
: "${PARLE_ROOM_AGENT_TOKEN:?resolved watcher configuration missing}"
: "${PARLE_WATCH_AGENT_SESSION:?dedicated watcher session missing}"
: "${PARLE_VERSION:?resolved watcher configuration missing}"
: "${PARLE_WATCH_CLIENT_INSTANCE_ID:?watch launcher client identity missing}"
: "${PARLE_WATCH_REQUEST_HELPER:?bundled watch request helper missing}"
: "${PARLE_WATCH_PARENT_PID:?watch launcher pid missing}"

# LIVE = a runtime snapshot for $me is live. MINE_EXPIRED = $me's snapshot is
# past (or within the 30s guard band of) its expiresAt -- affirmative
# scheduled expiry. MINE_PIDDEAD = $me's snapshot names a dead writer pid --
# the host process exited. MINE_UNREADY = $me's snapshot exists but is not
# ready (bootstrap retry or failure in progress) -- inconclusive, hold.
# DEAD = live sibling snapshots exist and none carries $me. UNKNOWN = no
# parseable snapshots (indeterminate, keep watching). Mirrors
# isLiveRuntimeSnapshot in @parlehq/agent-client (schemaVersion 1 or 2, state
# ready, unexpired with 30s skew, writer pid alive; uncertain pid checks
# count as alive, matching the client's prune posture).
session_liveness() {
  [ -n "$me" ] || { echo LIVE; return; }
  [ "${PARLE_WATCH_SESSION_LIVENESS:-1}" = "0" ] && { echo LIVE; return; }
  [ -d ./.parle/runtime ] || { echo UNKNOWN; return; }
  python3 - "$me" "$bound_pid" "$bound_started" "$bound_client" "$bound_path" <<'PY' 2>/dev/null || echo UNKNOWN
import calendar, glob, json, os, re, subprocess, sys, time

me = sys.argv[1]
bound_pid = sys.argv[2]
bound_started = sys.argv[3]
bound_client = sys.argv[4]
bound_path = sys.argv[5]
has_bound = bool(bound_pid and bound_started and bound_client and bound_path)
now = time.time()
sibling_live = 0
mine = []
transition = None
initial_live = None
# ISO-8601 UTC as written by JS toISOString(); parsed portably because the
# host python3 can be as old as 3.6 (no datetime.fromisoformat).
ISO_UTC = re.compile(r"^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$")
# Matches the statusline helper's START_TIME_TOLERANCE_MS.
START_TOLERANCE = 15

def iso_epoch(raw):
    match = ISO_UTC.match(str(raw))
    if not match:
        return None
    return calendar.timegm(time.strptime(match.group(1) + " " + match.group(2), "%Y-%m-%d %H:%M:%S"))

def pid_start_epoch(pid):
    # PID-reuse hardening: best-effort epoch the process started, or None when
    # process inspection is unavailable (some sandboxes deny ps and have no
    # /proc; the check degrades to pid-liveness-only there). Linux /proc first,
    # then ps etime -- locale- and timezone-free, mirroring parle-statusline.
    try:
        with open("/proc/%d/stat" % pid) as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2:].split()
        ticks = float(fields[19])
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1]) + ticks / os.sysconf("SC_CLK_TCK")
    except Exception:
        pass
    try:
        out = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        text = out.stdout.decode("utf-8", "replace").strip()
        if out.returncode != 0 or not text:
            return None
        # etime format: [[dd-]hh:]mm:ss
        if "-" in text:
            days, clock = text.split("-", 1)
        else:
            days, clock = "0", text
        seconds = 0
        for part in clock.split(":"):
            seconds = seconds * 60 + int(part)
        return now - (seconds + int(days) * 86400)
    except Exception:
        return None

def pid_alive(snap):
    pid = snap.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        pass
    # A verifiable start-time mismatch means the pid was recycled: the writer
    # is gone even though something answers kill(pid, 0).
    claimed = iso_epoch(snap.get("processStartedAt", ""))
    if claimed is not None:
        actual = pid_start_epoch(pid)
        if actual is not None and abs(actual - claimed) > START_TOLERANCE:
            return False
    return True

def same_bound_writer(path, snap):
    if not has_bound or path != bound_path or str(snap.get("pid", "")) != bound_pid:
        return False
    prior_start = iso_epoch(bound_started)
    next_start = iso_epoch(snap.get("processStartedAt", ""))
    if prior_start is None or next_start is None or abs(next_start - prior_start) > START_TOLERANCE:
        return False
    if str(snap.get("clientInstanceId", "")) != bound_client:
        return False
    return True

def live_wire(state, path, snap):
    print("%s|%s|%s|%s|%s|%s" % (
        state, snap.get("agentSessionId", ""), snap.get("pid", ""),
        snap.get("processStartedAt", ""), snap.get("clientInstanceId", ""), path))

for path in sorted(glob.glob("./.parle/runtime/*.json")):
    try:
        with open(path) as f:
            snap = json.load(f)
    except Exception:
        continue
    if not isinstance(snap, dict) or snap.get("schemaVersion") not in (1, 2):
        continue
    expires = iso_epoch(snap.get("expiresAt", ""))
    alive = pid_alive(snap)
    live = snap.get("state") == "ready" and expires is not None and expires > now + 30 and alive is True
    exact_bound = same_bound_writer(path, snap)
    if snap.get("agentSessionId") == me and (not has_bound or exact_bound):
        # Once bound, only the exact observed runtime can provide own-file
        # evidence. A same-id sibling remains unrelated.
        if expires is not None and expires <= now + 30:
            mine.append("MINE_EXPIRED")
        elif alive is False:
            mine.append("MINE_PIDDEAD")
        elif live:
            initial_live = (path, snap)
        else:
            mine.append("MINE_UNREADY")
        continue
    if live and exact_bound:
        candidate_id = snap.get("agentSessionId")
        if isinstance(candidate_id, str) and candidate_id and candidate_id != me:
            transition = (path, snap)
            continue
    if live:
        sibling_live += 1

if initial_live is not None:
    live_wire("LIVE", initial_live[0], initial_live[1])
    sys.exit(0)
for state in ("MINE_UNREADY", "MINE_EXPIRED", "MINE_PIDDEAD"):
    if state in mine:
        print(state)
        sys.exit(0)
if transition is not None:
    live_wire("ROLLED", transition[0], transition[1])
    sys.exit(0)
print("DEAD" if sibling_live else "UNKNOWN")
PY
}

# Redaction-safe per-file diagnostics on stderr before any exit 3, so a
# disputed verdict is arguable from evidence instead of reconstruction
# (adapters#22: the first field incident spent three hypotheses because the
# exit destroyed its own evidence). Session ids are room-visible operational
# metadata, never credentials.
liveness_forensics() {
  echo "parle-watch forensics: watched=$me verdict=$1" >&2
  python3 - "$me" <<'PY' >&2 2>/dev/null || echo "parle-watch forensics: unavailable (python3 failed)" >&2
import calendar, glob, json, os, re, subprocess, sys, time

me = sys.argv[1]
now = time.time()
ISO_UTC = re.compile(r"^(\d{4}-\d{2}-\d{2})[Tt](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:[Zz]|\+00:00)$")
START_TOLERANCE = 15

def iso_epoch(raw):
    match = ISO_UTC.match(str(raw))
    if not match:
        return None
    return calendar.timegm(time.strptime(match.group(1) + " " + match.group(2), "%Y-%m-%d %H:%M:%S"))

def pid_start_epoch(pid):
    try:
        with open("/proc/%d/stat" % pid) as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2:].split()
        ticks = float(fields[19])
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1]) + ticks / os.sysconf("SC_CLK_TCK")
    except Exception:
        pass
    try:
        out = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        text = out.stdout.decode("utf-8", "replace").strip()
        if out.returncode != 0 or not text:
            return None
        if "-" in text:
            days, clock = text.split("-", 1)
        else:
            days, clock = "0", text
        seconds = 0
        for part in clock.split(":"):
            seconds = seconds * 60 + int(part)
        return now - (seconds + int(days) * 86400)
    except Exception:
        return None

files = sorted(glob.glob("./.parle/runtime/*.json"))
if not files:
    print("  (no files in ./.parle/runtime)")
for path in files:
    try:
        with open(path) as f:
            snap = json.load(f)
    except Exception as e:
        print("  %s unparseable (%s)" % (path, type(e).__name__))
        continue
    if not isinstance(snap, dict):
        print("  %s not an object" % path)
        continue
    pid = snap.get("pid")
    try:
        os.kill(pid, 0)
        alive = "alive"
    except ProcessLookupError:
        alive = "dead"
    except Exception:
        alive = "uncertain"
    raw = str(snap.get("expiresAt", ""))
    expires = iso_epoch(raw)
    ttl = int(expires - now) if expires is not None else None
    started = str(snap.get("processStartedAt", "")) or "?"
    claimed = iso_epoch(started)
    if claimed is None:
        startcheck = "unclaimed"
    elif alive != "alive":
        startcheck = "n/a"
    else:
        actual = pid_start_epoch(pid) if isinstance(pid, int) and pid > 0 else None
        if actual is None:
            startcheck = "unavailable"
        elif abs(actual - claimed) > START_TOLERANCE:
            startcheck = "mismatched"
        else:
            startcheck = "matched"
    print("  %s schema=%s state=%s pid=%s(%s) expiresAt=%s ttl=%s started=%s startcheck=%s mine=%s" % (
        path, snap.get("schemaVersion"), snap.get("state"), pid, alive,
        raw or "?", "%ds" % ttl if ttl is not None else "?", started, startcheck,
        "yes" if snap.get("agentSessionId") == me else "no"))
PY
}

fails=0
helper_deadlines=0
dead_liveness=0
gone_liveness=0
unready_liveness=0
# Era gate: only trust an absence-based DEAD verdict after this watch has
# itself observed the session live in the snapshots (present-then-absent).
# A session id that was NEVER present is inconclusive -- the host may predate
# snapshot publishing, run in another cwd, or its live server's file may be
# missing (observed in the field, adapters#22) -- so the watch holds and says
# why once. Affirmative own-file evidence (MINE_EXPIRED, MINE_PIDDEAD) is not
# gated: the snapshot itself proves the session is gone.
seen_live=0
noted_never_present=0
noted_unready=0
# Identity of the primary runtime snapshot observed by this watch. A proactive
# session-id transition is accepted only from this same verified live writer.
bound_pid=""
bound_started=""
bound_client=""
bound_path=""
parse_wire() {
  status=${wire%%
*}
  resp=${wire#*
}
  parsed=$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
except Exception:
    body = {}
if not isinstance(body, dict):
    body = {}
local = body.get("watcher_local") or {}
err = body.get("error") or {}
if not isinstance(local, dict):
    local = {}
if not isinstance(err, dict):
    err = {}
print(local.get("outcome") or "")
print(err.get("action") or "network")
print(err.get("code") or "")
print(err.get("retry_after_ms") or "")
')
  local_outcome=$(printf '%s\n' "$parsed" | sed -n '1p')
  err_action=$(printf '%s\n' "$parsed" | sed -n '2p')
  err_code=$(printf '%s\n' "$parsed" | sed -n '3p')
  retry_after_ms=$(printf '%s\n' "$parsed" | sed -n '4p')
}
while :; do
  # Do not outlive a launcher terminated with SIGKILL. The request helper also
  # monitors this pid so an in-flight long poll aborts promptly.
  kill -0 "$PARLE_WATCH_PARENT_PID" 2>/dev/null || exit 2
  liveness_result=$(session_liveness)
  liveness_state=${liveness_result%%|*}
  case "$liveness_state" in
    LIVE|ROLLED)
      case "$liveness_result" in
        *'|'*)
          live_fields=${liveness_result#*|}
          observed_me=${live_fields%%|*}; live_fields=${live_fields#*|}
          observed_pid=${live_fields%%|*}; live_fields=${live_fields#*|}
          observed_started=${live_fields%%|*}; live_fields=${live_fields#*|}
          observed_client=${live_fields%%|*}; observed_path=${live_fields#*|}
          if [ -n "$observed_started" ] && [ -n "$observed_client" ]; then
            bound_pid=$observed_pid
            bound_started=$observed_started
            bound_client=$observed_client
            bound_path=$observed_path
          fi
          if [ "$liveness_state" = "ROLLED" ]; then
            old_me=$me
            # One shell assignment changes the filter before any subsequent
            # projection request or row classification.
            me=$observed_me
            echo "Parle note: followed primary runtime rollover from $old_me to $me on verified live writer pid $bound_pid." >&2
          fi
          ;;
      esac
      [ -n "$me" ] && seen_live=1
      dead_liveness=0; gone_liveness=0; unready_liveness=0
      ;;
    MINE_UNREADY)
      # Own snapshot present but not ready: a bootstrap retry or failure in
      # progress, not evidence of death. Hold; say so once if it persists.
      dead_liveness=0; gone_liveness=0
      unready_liveness=$((unready_liveness + 1))
      if [ "$unready_liveness" -ge 2 ] && [ "$noted_unready" = "0" ]; then
        noted_unready=1
        echo "Parle note: agent session $me has a runtime snapshot that is not in the ready state, so this watch keeps holding while the host retries. If it never recovers, check the host session and reconnect with parle_connect." >&2
      fi
      ;;
    MINE_EXPIRED|MINE_PIDDEAD)
      dead_liveness=0; unready_liveness=0
      gone_liveness=$((gone_liveness + 1))
      if [ "$gone_liveness" -ge 2 ]; then
        liveness_forensics "$liveness_state"
        if [ "$liveness_state" = "MINE_EXPIRED" ]; then
          echo "Parle stopped: agent session $me reached the 30-second guard band of (or passed) its scheduled expiresAt without a verified same-process runtime rewrite. This is failed proactive rollover evidence. Reconnect with parle_connect, then arm a fresh watch with the returned cursor and agentSessionId; do not re-arm with this session id or watermark." >&2
        else
          echo "Parle stopped: the host process that published agent session $me's runtime snapshot is no longer running. Reconnect with parle_connect, then arm a fresh watch with the returned cursor and agentSessionId; do not re-arm with this session id or watermark." >&2
        fi
        exit 3
      fi
      sleep 1
      continue
      ;;
    DEAD)
      gone_liveness=0; unready_liveness=0
      if [ "$seen_live" != "1" ]; then
        if [ "$noted_never_present" = "0" ]; then
          noted_never_present=1
          echo "Parle note: agent session $me has never appeared in ./.parle/runtime snapshots, so its absence is inconclusive and this watch keeps holding. If parle_connect reports a different live session id, re-arm with that id and cursor; if it reports this session alive, the snapshot is missing and PARLE_WATCH_SESSION_LIVENESS=0 silences this check until the host reloads." >&2
        fi
        dead_liveness=0
      else
        dead_liveness=$((dead_liveness + 1))
        if [ "$dead_liveness" -ge 2 ]; then
          liveness_forensics DEAD
          echo "Parle stopped: agent session $me was live in this host's runtime snapshots and is now gone (host process reloaded, session ended, or expired). Reconnect with parle_connect, then arm a fresh watch with the returned cursor and agentSessionId. Do not re-arm with this session id or watermark. If parle_connect reports this same session alive, check the remaining TTL before suspecting the heuristic: alive with seconds to spare near expiresAt confirms a scheduled rollover, while alive with plenty of TTL means a false verdict -- re-arm with PARLE_WATCH_SESSION_LIVENESS=0." >&2
          exit 3
        fi
        sleep 1
        continue
      fi
      ;;
    *)
      dead_liveness=0; gone_liveness=0; unready_liveness=0
      ;;
  esac
  # The helper owns abort provenance and emits credential-free local outcomes
  # inside the existing two-line private wire. The shell never guesses a
  # deadline from status 000 or synthesizes canonical API error meaning.
  wire=$(node "$PARLE_WATCH_REQUEST_HELPER" --parle-watch-request "$since" hold) || wire='000
{"watcher_local":{"outcome":"network_failure"}}'
  parse_wire

  if [ "$local_outcome" = "held_deadline" ]; then
    helper_deadlines=$((helper_deadlines + 1))
    if [ "$helper_deadlines" -lt 3 ]; then
      continue
    fi
    # Replace the held result with one immediate health probe, then fall
    # through the ordinary HTTP/action/success path. A successful probe may
    # contain a relevant row and must not be discarded.
    wire=$(node "$PARLE_WATCH_REQUEST_HELPER" --parle-watch-request "$since" probe) || wire='000
{"watcher_local":{"outcome":"network_failure"}}'
    parse_wire
    helper_deadlines=0
  else
    helper_deadlines=0
  fi

  if [ "$local_outcome" = "parent_gone" ]; then
    exit 2
  fi
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
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

  # The verified primary runtime may roll while the held projection request is
  # in flight. Recheck after the response and before classifying rows or
  # advancing since. A same-writer transition changes the filter for this exact
  # returned batch, so a successor direct cannot be skipped behind the watermark.
  post_liveness=$(session_liveness)
  post_state=${post_liveness%%|*}
  if [ "$post_state" = "ROLLED" ]; then
    post_fields=${post_liveness#*|}
    post_me=${post_fields%%|*}; post_fields=${post_fields#*|}
    post_pid=${post_fields%%|*}; post_fields=${post_fields#*|}
    post_started=${post_fields%%|*}; post_fields=${post_fields#*|}
    post_client=${post_fields%%|*}; post_path=${post_fields#*|}
    if [ -n "$post_me" ] && [ -n "$post_started" ] && [ -n "$post_client" ]; then
      old_me=$me
      bound_pid=$post_pid
      bound_started=$post_started
      bound_client=$post_client
      bound_path=$post_path
      me=$post_me
      echo "Parle note: followed primary runtime rollover from $old_me to $me on verified live writer pid $bound_pid after an in-flight projection." >&2
    fi
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
