import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Local per-process runtime snapshot files: display-safe session state published
// for host UX surfaces (statuslines, footers). Never contains a credential.
// One file per writer pid avoids concurrent hosts in the same cwd clobbering
// each other; expiresAt plus pid liveness makes files self-invalidating so
// crash cleanup is best-effort, not load-bearing.

export const RUNTIME_SCHEMA_VERSION = 1;
export const RUNTIME_DIR_SEGMENTS = [".parle", "runtime"] as const;
export const RUNTIME_EXPIRY_SKEW_MS = 30_000;

export type RuntimeFileState = "starting" | "ready" | "failed";

export type RuntimeFileSnapshot = {
  schemaVersion: number;
  pid: number;
  processStartedAt: string;
  clientInstanceId: string;
  state: RuntimeFileState;
  sessionAddress: string | null;
  agentSessionId: string;
  roomId: string;
  roomHandle?: string;
  updatedAt: string;
  expiresAt: string;
  lastError?: string;
  // Additive since 0.5.0: count-only inbound attention observation. Never
  // message content. Readers gate display on unreadAsOf freshness.
  unreadCount?: number;
  unreadAsOf?: string;
  adapter: { name: string; version?: string };
};

export function runtimeDirPath(cwd: string): string {
  return join(cwd, ...RUNTIME_DIR_SEGMENTS);
}

export function runtimeFilePath(cwd: string, pid: number): string {
  return join(runtimeDirPath(cwd), `${pid}.json`);
}

export function processStartedAtIso(now: Date = new Date()): string {
  return new Date(now.getTime() - process.uptime() * 1000).toISOString();
}

export function writeRuntimeFile(cwd: string, snapshot: RuntimeFileSnapshot): void {
  const dir = runtimeDirPath(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${snapshot.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, runtimeFilePath(cwd, snapshot.pid));
}

export function removeRuntimeFile(cwd: string, pid: number): void {
  rmSync(runtimeFilePath(cwd, pid), { force: true });
}

export function readRuntimeFiles(cwd: string): Array<{ path: string; snapshot: RuntimeFileSnapshot }> {
  const dir = runtimeDirPath(cwd);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; snapshot: RuntimeFileSnapshot }> = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const snapshot = JSON.parse(readFileSync(path, "utf8"));
      if (snapshot && typeof snapshot === "object") out.push({ path, snapshot });
    } catch {
      // Malformed or mid-write files are reader noise, never an error.
    }
  }
  return out;
}

export type PidLiveness = "alive" | "dead" | "uncertain";

export function pidLiveness(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error: any) {
    return error?.code === "ESRCH" ? "dead" : "uncertain";
  }
}

// Reader-side liveness gate: schema match, state ready, unexpired (with skew,
// erring toward "not live"), and the writer pid still running. Uncertain pid
// checks read as not live. Cross-pid start-time verification is left to
// display helpers that can afford a ps call; expiry bounds the reuse window.
export function isLiveRuntimeSnapshot(snapshot: RuntimeFileSnapshot, now: Date = new Date()): boolean {
  if (snapshot.schemaVersion !== RUNTIME_SCHEMA_VERSION || snapshot.state !== "ready") return false;
  if (typeof snapshot.pid !== "number" || !Number.isInteger(snapshot.pid) || snapshot.pid <= 0) return false;
  const expiresAt = Date.parse(snapshot.expiresAt || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() + RUNTIME_EXPIRY_SKEW_MS) return false;
  return pidLiveness(snapshot.pid) === "alive";
}

// Writer-side startup prune. Deletes only files that are provably stale:
// unparseable expiry, past expiry, or a definitively dead pid. Uncertain
// liveness keeps the file; expiry self-invalidates it for readers anyway.
export function pruneRuntimeFiles(cwd: string, now: Date = new Date()): void {
  for (const { path, snapshot } of readRuntimeFiles(cwd)) {
    if (snapshot.pid === process.pid) continue;
    const expiresAt = Date.parse(snapshot.expiresAt || "");
    const expired = !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
    if (expired || pidLiveness(snapshot.pid) === "dead") rmSync(path, { force: true });
  }
}
