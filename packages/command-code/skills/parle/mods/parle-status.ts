import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const EXPIRY_SKEW_MS = 30_000;
const START_TIME_TOLERANCE_MS = 15_000;
const UNREAD_FRESH_MS = 180_000;
const REFRESH_INTERVAL_MS = 5_000;

export default function parleStatus(cmd: any) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: string | null | undefined;
  let sessionBound = false;
  let notifiedConnected = false;

  const refresh = () => {
    const next = renderParleStatus(cmd.cwd, Date.now());
    if (next === current) return;
    current = next;
    cmd.ui.setStatus(next);
    if (sessionBound && !notifiedConnected && next?.includes("✓")) {
      notifiedConnected = true;
      cmd.ui.notify(`Parle ${next}`);
    }
  };

  const start = () => {
    sessionBound = true;
    notifiedConnected = false;
    current = undefined;
    refresh();
    if (timer) return;
    timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    timer.unref?.();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    current = undefined;
    sessionBound = false;
    notifiedConnected = false;
    cmd.ui.setStatus(null);
  };

  cmd.on("session_start", start);
  cmd.on("session_shutdown", stop);
  cmd.on("run_start", refresh);
  cmd.on("run_end", refresh);
  refresh();
}

export function renderParleStatus(cwd: string, now = Date.now()): string | null {
  const live = readLiveSnapshots(cwd, now);
  if (live.length === 1) {
    const snapshot = live[0];
    const unread = unreadInfo(snapshot, now);
    return `${roomLabel(snapshot)} ✓ ${snapshot.sessionAddress || "connected"}${unread?.fresh ? ` · ${unread.count} unread` : ""}`;
  }
  if (live.length > 1) {
    const anyUnread = live.some((snapshot) => unreadInfo(snapshot, now)?.fresh);
    const labels = new Set(live.map(roomLabel));
    const label = labels.size === 1 ? labels.values().next().value : "parle";
    return `${label} ✓ ${live.length} sessions${anyUnread ? " · unread" : ""}`;
  }
  return parleConfiguredHint(cwd) ? "parle · off" : null;
}

function readLiveSnapshots(cwd: string, now: number): any[] {
  const directory = join(cwd, ".parle", "runtime");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  const live = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      const snapshot = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (isLive(snapshot, now)) live.push(snapshot);
    } catch {
      // Malformed or mid-write snapshots do not affect the footer.
    }
  }
  return live;
}

function roomLabel(snapshot: any): string {
  if (typeof snapshot?.roomHandle === "string" && snapshot.roomHandle) return `#${snapshot.roomHandle}`;
  if (typeof snapshot?.roomId === "string" && snapshot.roomId) return `#room-${snapshot.roomId.slice(0, 8)}`;
  return "parle";
}

function parleConfiguredHint(cwd: string): boolean {
  try {
    const envPath = join(cwd, ".env");
    if (!existsSync(envPath)) return false;
    return /^\s*PARLE_(PROFILE|PROFILES_PATH|ROOM_ID|ROOM_AGENT_TOKEN)\s*=/m.test(readFileSync(envPath, "utf8"));
  } catch {
    return false;
  }
}

function unreadInfo(snapshot: any, now: number): { count: number; fresh: boolean } | null {
  if (typeof snapshot?.unreadCount !== "number" || snapshot.unreadCount <= 0) return null;
  const asOf = Date.parse(snapshot.unreadAsOf || "");
  if (!Number.isFinite(asOf)) return null;
  return { count: snapshot.unreadCount, fresh: now - asOf <= UNREAD_FRESH_MS };
}

function isLive(snapshot: any, now: number): boolean {
  if (snapshot?.schemaVersion !== SCHEMA_VERSION || snapshot.state !== "ready") return false;
  if (typeof snapshot.pid !== "number" || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  const expiresAt = Date.parse(snapshot.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now + EXPIRY_SKEW_MS) return false;
  try {
    process.kill(snapshot.pid, 0);
  } catch (error) {
    // Sandboxed hosts can deny signal checks for a live sibling process.
    // EPERM proves the pid exists; expiry still bounds stale snapshots.
    if ((error as { code?: string })?.code !== "EPERM") return false;
  }

  const claimedStart = Date.parse(snapshot.processStartedAt || "");
  if (Number.isFinite(claimedStart)) {
    const actualStart = pidStartMs(snapshot.pid, now);
    if (actualStart !== null && Math.abs(actualStart - claimedStart) > START_TIME_TOLERANCE_MS) return false;
  }
  return true;
}

function pidStartMs(pid: number, now: number): number | null {
  try {
    const elapsed = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!elapsed) return null;
    return now - parseElapsedMs(elapsed);
  } catch {
    return null;
  }
}

function parseElapsedMs(elapsed: string): number {
  const [days, clock] = elapsed.includes("-") ? elapsed.split("-") : [undefined, elapsed];
  let seconds = 0;
  for (const part of clock.split(":")) seconds = seconds * 60 + Number(part);
  if (days !== undefined) seconds += Number(days) * 86_400;
  return seconds * 1000;
}
