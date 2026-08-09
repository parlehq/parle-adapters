import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceOwnerOnlyFile, ensureOwnerOnlyDirectory, readOwnerOnlyTextFile, removeOwnerOnlyFileIf } from "./safe-file.js";

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
export const RUNTIME_PRUNE_LIMIT = 32;
export const RUNTIME_PRUNE_INSPECTION_LIMIT = 64;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024;
const pruneCursor = new Map<string, number>();

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
  try {
    pruneRuntimeFiles(cwd, new Date(snapshot.updatedAt), { excludePid: snapshot.pid });
  } catch { /* cleanup is best effort after the snapshot is committed */ }
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

export type RuntimePruneOptions = {
  excludePid?: number;
  maxInspections?: number;
  maxRemovals?: number;
  inspectPid?: (pid: number) => PidLiveness;
};

function boundedLimit(value: number | undefined, fallback: number): number {
  const parsed = Math.trunc(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function rotatedCandidates(dir: string, names: string[], limit: number): string[] {
  if (!names.length || limit === 0) return [];
  names.sort();
  const start = (pruneCursor.get(dir) ?? 0) % names.length;
  const count = Math.min(limit, names.length);
  const selected = Array.from({ length: count }, (_, offset) => names[(start + offset) % names.length]);
  pruneCursor.set(dir, (start + count) % names.length);
  return selected;
}

// Writer-side bounded prune. Deletes only records that are both expired and
// owned by a definitively dead pid. The quarantine primitive revalidates the
// exact file generation so a concurrent replacement cannot be deleted.
export function pruneRuntimeFiles(cwd: string, now: Date = new Date(), options: RuntimePruneOptions = {}): void {
  const dir = runtimeDirPath(cwd);
  let names: string[];
  try { names = readdirSync(dir).filter((name) => !name.startsWith(".") && name.endsWith(".json")); } catch { return; }
  const maxInspections = boundedLimit(options.maxInspections, RUNTIME_PRUNE_INSPECTION_LIMIT);
  const maxRemovals = boundedLimit(options.maxRemovals, RUNTIME_PRUNE_LIMIT);
  const inspectPid = options.inspectPid ?? pidLiveness;
  let removed = 0;
  for (const name of rotatedCandidates(dir, names, maxInspections)) {
    if (removed >= maxRemovals) break;
    const path = join(dir, name);
    if (removeOwnerOnlyFileIf(path, {
      label: "Parle runtime snapshot",
      maxBytes: MAX_RUNTIME_FILE_BYTES,
      shouldRemove: (raw) => {
        let snapshot: any;
        try { snapshot = JSON.parse(raw); } catch { return false; }
        if (!snapshot || !Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0 || snapshot.pid === process.pid || snapshot.pid === options.excludePid) return false;
        const expiresAt = Date.parse(snapshot.expiresAt || "");
        return Number.isFinite(expiresAt) && expiresAt <= now.getTime() && inspectPid(snapshot.pid) === "dead";
      },
    })) removed += 1;
  }
}
