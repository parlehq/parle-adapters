#!/usr/bin/env node
// Parle statusline segment for Claude Code. Self-contained: no workspace or
// npm dependencies. Reads the Claude Code statusline JSON payload on stdin,
// scans <cwd>/.parle/runtime/*.json snapshots written by the Parle MCP server,
// and prints one short segment (or nothing). Read/filter/display only: this
// script never writes, prunes, or connects.
//
// Display contract (cwd-scoped, NOT Claude-session-authoritative):
//   exactly one live session  ->  "parle ✓ @principal.agent.session"
//   multiple live sessions    ->  "parle ✓ N sessions" (never a specific
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

const SCHEMA_VERSION = 1;
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
    const address = s.sessionAddress || s.roomHandle || "connected";
    if (FULL) {
      const parts = [`parle ✓ ${address}`];
      if (s.roomHandle && s.sessionAddress) parts.push(s.roomHandle);
      const expiry = relativeExpiry(Date.parse(s.expiresAt || ""), now);
      if (expiry) parts.push(`expires ${expiry}`);
      process.stdout.write(parts.join(" · "));
    } else {
      process.stdout.write(`parle ✓ ${address}`);
    }
    return;
  }
  if (live.length > 1) {
    if (FULL) {
      const addresses = live.map((s) => s.sessionAddress || "connected").join("  ");
      process.stdout.write(`parle ✓ ${live.length} sessions in cwd: ${addresses}`);
    } else {
      process.stdout.write(`parle ✓ ${live.length} sessions`);
    }
    return;
  }
  if (existsSync(join(cwd, ".parle", "credentials"))) process.stdout.write("parle · off");
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
