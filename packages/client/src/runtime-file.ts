import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceOwnerOnlyFile, ensureOwnerOnlyDirectory, readOwnerOnlyTextFile } from "./safe-file.js";

// Local per-process runtime snapshot files: display-safe session state published
// for host UX surfaces (statuslines, footers). Never contains a credential.
// One file per writer pid avoids concurrent hosts in the same cwd clobbering
// each other; expiresAt plus pid liveness makes files self-invalidating so
// crash cleanup is best-effort, not load-bearing.

// v2 is a hard cut: one session, rooms[] only. There is no v1 field on a v2
// snapshot and no v1 read path. Writers and every reader ship together.
export const RUNTIME_SCHEMA_VERSION = 2;
export const RUNTIME_DIR_SEGMENTS = [".parle", "runtime"] as const;
export const RUNTIME_EXPIRY_SKEW_MS = 30_000;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024;

export type RuntimeFileState = "starting" | "ready" | "failed";

export type RuntimeFileRoom = {
  roomId: string;
  roomHandle?: string;
  profile?: string;
  // Room-visible operational identity used by colocated watcher filters.
  // It is not a credential and carries no authority outside this room.
  participantId?: string;
  state: "ready" | "degraded";
  // Count-only inbound attention observation. Never message content. Readers
  // gate display on unreadAsOf freshness.
  unreadCount?: number;
  unreadAsOf?: string;
};

export type RuntimeFileSnapshot = {
  schemaVersion: number;
  pid: number;
  processStartedAt: string;
  clientInstanceId: string;
  state: RuntimeFileState;
  sessionAddress: string | null;
  agentSessionId: string;
  rooms: RuntimeFileRoom[];
  updatedAt: string;
  expiresAt: string;
  lastError?: string;
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
  ensureOwnerOnlyDirectory(dir, { label: "Parle runtime directory", repairMode: true });
  atomicReplaceOwnerOnlyFile(runtimeFilePath(cwd, snapshot.pid), JSON.stringify(snapshot, null, 2) + "\n", {
    label: "Parle runtime snapshot",
    maxBytes: MAX_RUNTIME_FILE_BYTES,
    durability: "none",
  });
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
      const snapshot = JSON.parse(readOwnerOnlyTextFile(path, { label: "Parle runtime snapshot", maxBytes: MAX_RUNTIME_FILE_BYTES }));
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
