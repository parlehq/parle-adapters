import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
// @ts-expect-error Generated dependency-free ESM copied from @parlehq/agent-client.
import { inspectResponsiveDeliveryPid, readResponsiveDeliverySnapshots, resolveResponsiveDelivery } from "./responsive-delivery-reader.mjs";

// Snapshot schema v2: one session, rooms[] only. No v1 read path.
const SCHEMA_VERSION = 2;
const EXPIRY_SKEW_MS = 30_000;
const START_TIME_TOLERANCE_MS = 15_000;
const UNREAD_FRESH_MS = 180_000;
const REFRESH_INTERVAL_MS = 5_000;
const NOTICE_DELAY_MS = 1_000;

export default function parleStatus(cmd: any) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
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
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        if (sessionBound) cmd.ui.notify(`Parle ${next}`);
      }, NOTICE_DELAY_MS);
      noticeTimer.unref?.();
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
    if (noticeTimer) clearTimeout(noticeTimer);
    timer = undefined;
    noticeTimer = undefined;
    current = undefined;
    sessionBound = false;
    notifiedConnected = false;
    cmd.ui.setStatus(null);
  };

  cmd.hooks({
    onSessionStart: start,
    onSessionEnd: stop,
  });
  cmd.on("run_start", refresh);
  cmd.on("run_end", refresh);
  refresh();
}

export function renderParleStatus(cwd: string, now = Date.now()): string | null {
  const live = readLiveSnapshots(cwd, now);
  if (live.length === 1) {
    const snapshot = live[0];
    const unread = unreadInfo(snapshot, now);
    const delivery = responsiveState(cwd, snapshot.agentSessionId, now);
    return `${roomLabel(snapshot)} ✓ ${snapshot.sessionAddress || "connected"}${delivery === "unknown" ? "" : ` · delivery ${delivery}`}${unread?.fresh ? ` · ${unread.count} unread` : ""}`;
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

function responsiveState(cwd: string, agentSessionId: string | undefined, now: number): string {
  if (!agentSessionId) return "unknown";
  return resolveResponsiveDelivery(readResponsiveDeliverySnapshots(cwd), agentSessionId, {
    now: new Date(now),
    inspectPid: inspectResponsiveDeliveryPid,
  }).state;
}

function roomLabel(snapshot: any): string {
  const rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  const labels = rooms.map((room: any) => {
    if (typeof room?.roomHandle === "string" && room.roomHandle) return `#${room.roomHandle}`;
    if (typeof room?.roomId === "string" && room.roomId) return `#room-${room.roomId.slice(0, 8)}`;
    return null;
  }).filter(Boolean);
  if (labels.length === 1) return labels[0] as string;
  if (labels.length > 1) return labels.join(" ");
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
  // One count across the session's rooms; per-room detail belongs in tools.
  const rooms = Array.isArray(snapshot?.rooms) ? snapshot.rooms : [];
  const counted = rooms.filter((room: any) => typeof room?.unreadCount === "number" && room.unreadCount > 0 && Number.isFinite(Date.parse(room.unreadAsOf || "")));
  if (counted.length === 0) return null;
  const count = counted.reduce((total: number, room: any) => total + room.unreadCount, 0);
  const asOf = Math.max(...counted.map((room: any) => Date.parse(room.unreadAsOf)));
  return { count, fresh: now - asOf <= UNREAD_FRESH_MS };
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
