#!/usr/bin/env node
// Parle statusline segment for Claude Code. Self-contained: no workspace or
// npm dependencies. Reads the Claude Code statusline JSON payload on stdin,
// scans <cwd>/.parle/runtime/*.json snapshots written by the Parle MCP server,
// and prints one short segment (or nothing). Read/filter/display only: this
// script never writes, prunes, or connects.
//
// Display contract (cwd-scoped, NOT Claude-session-authoritative):
//   exactly one live session  ->  "#room-handle ✓ @principal.agent.session"
//   multiple live sessions    ->  "#room-handle ✓ N sessions" when every
//                                 session is in that room, otherwise
//                                 "parle ✓ N sessions" (never a specific
//                                 address presented as yours: it could be a
//                                 sibling session's)
//   none live but configured  ->  "parle · off"
//   not configured            ->  no output
//
// Pass --full for a roomier single-line variant (suited to a dedicated
// statusline row): adds room handle and relative expiry, and for multiple
// live sessions lists all addresses explicitly labeled as cwd sessions
// (a labeled list is honest; a single bare address would read as yours).
//
// Wire it into your own statusline command, e.g. in settings.json:
//   "statusLine": { "type": "command", "command": "my-statusline.sh" }
// and inside my-statusline.sh:
//   parle=$(node /path/to/parle-statusline.mjs <<< "$input")

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Snapshot schema v2: one session, rooms[] only. No v1 read path.
const SCHEMA_VERSION = 2;
const EXPIRY_SKEW_MS = 30_000;
const START_TIME_TOLERANCE_MS = 15_000;

const FULL = process.argv.includes("--full");

function main() {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    cwd = input?.workspace?.current_dir || input?.cwd || cwd;
  } catch {
    // No/invalid stdin payload: fall back to process cwd.
  }
  const dir = join(cwd, ".parle", "runtime");
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const now = Date.now();
  const live = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      const snapshot = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (isLive(snapshot, now)) live.push(snapshot);
    } catch {
      // Malformed or mid-write files are never an error.
    }
  }
  if (live.length === 1) {
    const s = live[0];
    const label = roomLabel(s);
    const address = s.sessionAddress || "connected";
    const unread = unreadInfo(s, now);
    if (FULL) {
      const parts = [`${label} ✓ ${address}`];
      const expiry = relativeExpiry(Date.parse(s.expiresAt || ""), now);
      if (expiry) parts.push(`expires ${expiry}`);
      if (unread?.fresh) parts.push(`${unread.count} unread`);
      else if (unread) parts.push(`unread stale ${Math.round(unread.ageMs / 60_000)}m`);
      process.stdout.write(parts.join(" · "));
    } else {
      process.stdout.write(`${label} ✓ ${address}${unread?.fresh ? ` · ${unread.count} unread` : ""}`);
    }
    return;
  }
  if (live.length > 1) {
    // Per-session self-excluding surfaces double-count room-wide rows, so
    // multi-session display never sums and compact shows an indicator only.
    const anyUnread = live.some((s) => unreadInfo(s, now)?.fresh);
    const labels = new Set(live.map(roomLabel));
    const sharedLabel = labels.size === 1 ? labels.values().next().value : "parle";
    if (FULL) {
      const addresses = live.map((s) => {
        const unread = unreadInfo(s, now);
        return `${roomLabel(s)} ${s.sessionAddress || "connected"}${unread?.fresh ? ` (${unread.count} unread)` : ""}`;
      }).join("  ");
      process.stdout.write(`${sharedLabel} ✓ ${live.length} sessions in cwd: ${addresses}`);
    } else {
      process.stdout.write(`${sharedLabel} ✓ ${live.length} sessions${anyUnread ? " · unread" : ""}`);
    }
    return;
  }
  if (parleConfiguredHint(cwd)) process.stdout.write("parle · off");
}

function roomLabel(snapshot) {
  const rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  const labels = rooms.map((room) => {
    if (typeof room?.roomHandle === "string" && room.roomHandle) return `#${room.roomHandle}`;
    if (typeof room?.roomId === "string" && room.roomId) return `#room-${room.roomId.slice(0, 8)}`;
    return null;
  }).filter(Boolean);
  if (labels.length === 1) return labels[0];
  if (labels.length > 1) return labels.join(" ");
  return "parle";
}

// "Configured but disconnected" heuristic: the project .env names a Parle
// binding (selector, catalog override, or direct room binding). Key names
// only; values are never read past the match. A user-level catalog alone is
// deliberately not a hint: it would flag every repo on the machine.
function parleConfiguredHint(cwd) {
  try {
    const envPath = join(cwd, ".env");
    if (!existsSync(envPath)) return false;
    return /^\s*PARLE_(PROFILE|PROFILES_PATH|ROOM_ID|ROOM_AGENT_TOKEN)\s*=/m.test(readFileSync(envPath, "utf8"));
  } catch {
    return false;
  }
}

// Freshness gate: a count is asserted only while recent (about 2.5 producer
// intervals); after that it is suppressed in compact and labeled stale in full.
const UNREAD_FRESH_MS = 180_000;

function unreadInfo(snapshot, now) {
  // One count across the session's rooms: the statusline answers "does
  // anything want me", and per-room detail belongs in the tool output.
  const rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  const counted = rooms.filter((room) => typeof room?.unreadCount === "number" && room.unreadCount > 0 && Number.isFinite(Date.parse(room.unreadAsOf || "")));
  if (counted.length === 0) return null;
  const count = counted.reduce((total, room) => total + room.unreadCount, 0);
  const ageMs = now - Math.max(...counted.map((room) => Date.parse(room.unreadAsOf)));
  return { count, ageMs, fresh: ageMs <= UNREAD_FRESH_MS };
}

function relativeExpiry(expiresAtMs, now) {
  if (!Number.isFinite(expiresAtMs)) return null;
  const minutes = Math.round((expiresAtMs - now) / 60_000);
  if (minutes < 120) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}

// Skeptical reader gate: schema match, state ready, unexpired with skew, and
// pid alive. Start-time verification (PID-reuse hardening) is advisory: a
// verifiable mismatch reads as not live, but an unavailable/blocked ps (some
// sandboxes and hardened hosts deny process inspection) skips the check
// rather than bricking the display; expiry bounds the reuse window either way.
function isLive(snapshot, now) {
  if (snapshot?.schemaVersion !== SCHEMA_VERSION || snapshot.state !== "ready") return false;
  if (typeof snapshot.pid !== "number" || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  const expiresAt = Date.parse(snapshot.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now + EXPIRY_SKEW_MS) return false;
  try {
    process.kill(snapshot.pid, 0);
  } catch {
    return false;
  }
  const claimedStart = Date.parse(snapshot.processStartedAt || "");
  if (Number.isFinite(claimedStart)) {
    const actualStart = pidStartMs(snapshot.pid, now);
    if (actualStart !== null && Math.abs(actualStart - claimedStart) > START_TIME_TOLERANCE_MS) return false;
  }
  return true;
}

function pidStartMs(pid, now) {
  try {
    const etime = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!etime) return null;
    return now - parseEtimeMs(etime);
  } catch {
    return null;
  }
}

// ps etime format: [[dd-]hh:]mm:ss
function parseEtimeMs(etime) {
  const [days, clock] = etime.includes("-") ? etime.split("-") : [null, etime];
  let seconds = 0;
  for (const part of clock.split(":")) seconds = seconds * 60 + Number(part);
  if (days !== null) seconds += Number(days) * 86_400;
  return seconds * 1000;
}

try {
  main();
} catch {
  // A statusline segment must never surface an error or block the UI.
}
