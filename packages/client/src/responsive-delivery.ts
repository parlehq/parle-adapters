import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Credential-free local evidence for a responsive-delivery owner. */
export const RESPONSIVE_DELIVERY_SCHEMA_VERSION = 1;
export const RESPONSIVE_DELIVERY_SKEW_MS = 30_000;
export const RESPONSIVE_DELIVERY_MAX_LEASE_MS = 10 * 60_000;
export const RESPONSIVE_DELIVERY_TOMBSTONE_MS = 5 * 60_000;
export const RESPONSIVE_DELIVERY_MAX_FILE_BYTES = 64 * 1024;
export const RESPONSIVE_DELIVERY_MAX_DIAGNOSTIC_CHARS = 512;

export type ResponsiveDeliveryPublishedState = "starting" | "watching" | "backoff" | "stopped" | "terminal";
export type ResponsiveDeliveryState = ResponsiveDeliveryPublishedState | "stale" | "unknown" | "conflict";
export type ResponsiveDeliverySnapshot = {
  schemaVersion: 1;
  pid: number;
  processStartedAt: string;
  publisher: { name: string; version?: string; clientInstanceId: string };
  target: { agentSessionId: string; participantId?: string; roomId?: string };
  state: ResponsiveDeliveryPublishedState;
  updatedAt: string;
  expiresAt: string;
  lastSuccessAt?: string;
  lastWakeAt?: string;
  retryAt?: string;
  lastError?: { message: string; at: string };
  reason?: string;
};
export type ResponsiveDeliveryResult = {
  state: ResponsiveDeliveryState;
  updatedAt?: string;
  lastSuccessAt?: string;
  lastWakeAt?: string;
  retryAt?: string;
  lastError?: { message: string; at: string };
  reason?: string;
  evidenceAgeMs?: number;
  publisher?: { name: string; version?: string };
};
export type ResponsivePidInspection = "alive" | "dead" | "unknown" | { status: "alive" | "dead" | "unknown"; processStartedAt?: string };
export type ResponsiveDeliveryResolveOptions = {
  now?: Date;
  inspectPid?: (pid: number) => ResponsivePidInspection;
};
export type ResponsiveDeliveryEvent = {
  expectedProgressMs?: number;
  lastSuccessAt?: string;
  lastWakeAt?: string;
  retryAt?: string;
  lastError?: { message: string; at?: string } | string;
  reason?: string;
};
export type ResponsiveDeliveryRecorderOptions = {
  cwd?: string;
  pid?: number;
  processStartedAt: string;
  publisher: ResponsiveDeliverySnapshot["publisher"];
  target: ResponsiveDeliverySnapshot["target"];
  now?: () => Date;
  persist?: boolean;
};

const ACTIVE = new Set<ResponsiveDeliveryPublishedState>(["starting", "watching", "backoff"]);
const PUBLISHED = new Set<ResponsiveDeliveryPublishedState>(["starting", "watching", "backoff", "stopped", "terminal"]);
const ISO = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const string = (value: unknown, max = 256): string | undefined => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

/** Removes common credentials and bounds text before it can enter local evidence. */
export function redactResponsiveDeliveryDiagnostic(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, RESPONSIVE_DELIVERY_MAX_DIAGNOSTIC_CHARS)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bparle_[a-z]+_[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
    .replace(/\b(parle_(?:ses|tok|secret)[A-Za-z0-9_\-.]*)\b/gi, "[REDACTED]")
    .replace(/\b(authorization|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  return text || undefined;
}

function cleanSnapshot(input: ResponsiveDeliverySnapshot): ResponsiveDeliverySnapshot {
  const lastError = input.lastError
    ? { message: redactResponsiveDeliveryDiagnostic(input.lastError.message) || "[REDACTED]", at: input.lastError.at }
    : undefined;
  return {
    ...input,
    publisher: { ...input.publisher, ...(input.publisher.version ? { version: input.publisher.version.slice(0, 128) } : {}) },
    target: { ...input.target },
    ...(lastError ? { lastError } : {}),
    ...(redactResponsiveDeliveryDiagnostic(input.reason) ? { reason: redactResponsiveDeliveryDiagnostic(input.reason) } : {}),
  };
}

/** Builds one owner-reported event. It deliberately does not validate transitions. */
export function buildResponsiveDeliverySnapshot(
  base: Omit<ResponsiveDeliverySnapshot, "schemaVersion" | "state" | "updatedAt" | "expiresAt">,
  state: ResponsiveDeliveryPublishedState,
  event: ResponsiveDeliveryEvent = {},
  now: Date = new Date(),
): ResponsiveDeliverySnapshot {
  const updatedAt = now.toISOString();
  const expected = Math.max(0, Math.min(RESPONSIVE_DELIVERY_MAX_LEASE_MS - RESPONSIVE_DELIVERY_SKEW_MS, Math.trunc(event.expectedProgressMs ?? 0)));
  const expiresAt = new Date(now.getTime() + (ACTIVE.has(state) ? expected + RESPONSIVE_DELIVERY_SKEW_MS : RESPONSIVE_DELIVERY_TOMBSTONE_MS)).toISOString();
  const message = typeof event.lastError === "string" ? event.lastError : event.lastError?.message;
  const errorAt = typeof event.lastError === "string" ? updatedAt : event.lastError?.at || updatedAt;
  return cleanSnapshot({
    ...base, schemaVersion: 1, state, updatedAt, expiresAt,
    ...(event.lastSuccessAt ? { lastSuccessAt: event.lastSuccessAt } : {}),
    ...(event.lastWakeAt ? { lastWakeAt: event.lastWakeAt } : {}),
    ...(event.retryAt ? { retryAt: event.retryAt } : {}),
    ...(message ? { lastError: { message, at: errorAt } } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
  });
}

export function responsiveDeliveryRuntimeDirPath(cwd: string): string { return join(cwd, ".parle", "runtime", "responsive"); }
export function responsiveDeliveryRuntimeFilePath(cwd: string, pid: number): string { return join(responsiveDeliveryRuntimeDirPath(cwd), `${pid}.json`); }

export function writeResponsiveDeliverySnapshot(cwd: string, snapshot: ResponsiveDeliverySnapshot): void {
  const dir = responsiveDeliveryRuntimeDirPath(cwd);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.tmp-${snapshot.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, JSON.stringify(cleanSnapshot(snapshot), null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, responsiveDeliveryRuntimeFilePath(cwd, snapshot.pid));
}
export function removeResponsiveDeliverySnapshot(cwd: string, pid: number): void { rmSync(responsiveDeliveryRuntimeFilePath(cwd, pid), { force: true }); }

/** Parses only the published schema and discards malformed or future data. */
export function parseResponsiveDeliverySnapshot(value: unknown): ResponsiveDeliverySnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row: any = value;
  if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !PUBLISHED.has(row.state) || !ISO(row.processStartedAt) || !ISO(row.updatedAt) || !ISO(row.expiresAt)) return undefined;
  const name = string(row.publisher?.name); const instance = string(row.publisher?.clientInstanceId);
  const agentSessionId = string(row.target?.agentSessionId);
  if (!name || !instance || !agentSessionId) return undefined;
  const snapshot: ResponsiveDeliverySnapshot = {
    schemaVersion: 1, pid: row.pid, processStartedAt: row.processStartedAt,
    publisher: { name, clientInstanceId: instance, ...(string(row.publisher.version, 128) ? { version: string(row.publisher.version, 128) } : {}) },
    target: { agentSessionId, ...(string(row.target.participantId) ? { participantId: string(row.target.participantId) } : {}), ...(string(row.target.roomId) ? { roomId: string(row.target.roomId) } : {}) },
    state: row.state, updatedAt: row.updatedAt, expiresAt: row.expiresAt,
  };
  for (const key of ["lastSuccessAt", "lastWakeAt", "retryAt"] as const) if (ISO(row[key])) snapshot[key] = row[key];
  if (row.lastError && ISO(row.lastError.at) && typeof row.lastError.message === "string") snapshot.lastError = { message: redactResponsiveDeliveryDiagnostic(row.lastError.message) || "[REDACTED]", at: row.lastError.at };
  const reason = redactResponsiveDeliveryDiagnostic(row.reason); if (reason) snapshot.reason = reason;
  return snapshot;
}

export function readResponsiveDeliverySnapshots(cwd: string): ResponsiveDeliverySnapshot[] {
  let names: string[]; try { names = readdirSync(responsiveDeliveryRuntimeDirPath(cwd)); } catch { return []; }
  const result: ResponsiveDeliverySnapshot[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const raw = readFileSync(join(responsiveDeliveryRuntimeDirPath(cwd), name), "utf8");
      if (Buffer.byteLength(raw) > RESPONSIVE_DELIVERY_MAX_FILE_BYTES) continue;
      const snapshot = parseResponsiveDeliverySnapshot(JSON.parse(raw)); if (snapshot) result.push(snapshot);
    } catch { /* fail closed */ }
  }
  return result;
}

/** Node liveness probe for callers that can inspect local processes. */
export function inspectResponsiveDeliveryPid(pid: number): ResponsivePidInspection {
  try { process.kill(pid, 0); return "alive"; } catch (error: any) { return error?.code === "ESRCH" ? "dead" : "unknown"; }
}
function inspection(pid: number, inspectPid?: ResponsiveDeliveryResolveOptions["inspectPid"]): ResponsivePidInspection {
  if (!inspectPid) return "unknown";
  try { return inspectPid(pid); } catch { return "unknown"; }
}
function isFresh(snapshot: ResponsiveDeliverySnapshot, now: Date): boolean { return Date.parse(snapshot.expiresAt) >= now.getTime() && Date.parse(snapshot.updatedAt) <= now.getTime() + RESPONSIVE_DELIVERY_SKEW_MS; }
function isActiveLive(snapshot: ResponsiveDeliverySnapshot, now: Date, inspectPid?: ResponsiveDeliveryResolveOptions["inspectPid"]): boolean {
  if (!isFresh(snapshot, now)) return false;
  const checked = inspection(snapshot.pid, inspectPid);
  if (checked === "dead" || (typeof checked === "object" && (checked.status === "dead" || (checked.processStartedAt && checked.processStartedAt !== snapshot.processStartedAt)))) return false;
  return true;
}
function result(state: ResponsiveDeliveryState, snapshot?: ResponsiveDeliverySnapshot, now = new Date()): ResponsiveDeliveryResult {
  if (!snapshot) return { state };
  return { state, updatedAt: snapshot.updatedAt, ...(snapshot.lastSuccessAt ? { lastSuccessAt: snapshot.lastSuccessAt } : {}), ...(snapshot.lastWakeAt ? { lastWakeAt: snapshot.lastWakeAt } : {}), ...(snapshot.retryAt ? { retryAt: snapshot.retryAt } : {}), ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}), ...(snapshot.reason ? { reason: snapshot.reason } : {}), evidenceAgeMs: Math.max(0, now.getTime() - Date.parse(snapshot.updatedAt)), publisher: { name: snapshot.publisher.name, ...(snapshot.publisher.version ? { version: snapshot.publisher.version } : {}) } };
}

/** Pure selection: target identity is agentSessionId, never clientInstanceId. */
export function resolveResponsiveDelivery(snapshots: readonly ResponsiveDeliverySnapshot[], agentSessionId: string, options: ResponsiveDeliveryResolveOptions = {}): ResponsiveDeliveryResult {
  const now = options.now || new Date();
  const exact = snapshots.filter((snapshot) => snapshot.target.agentSessionId === agentSessionId);
  const mismatched = snapshots.filter((snapshot) => snapshot.target.agentSessionId !== agentSessionId);
  const active = exact.filter((snapshot) => ACTIVE.has(snapshot.state) && isActiveLive(snapshot, now, options.inspectPid));
  if (active.length > 1) return result("conflict", active.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0], now);
  if (active.length === 1) return result(active[0].state, active[0], now);
  const tombstones = exact.filter((snapshot) => !ACTIVE.has(snapshot.state) && isFresh(snapshot, now));
  if (tombstones.length) {
    const newest = tombstones.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    return result(newest.state, newest, now);
  }
  const stale = [...exact.filter((snapshot) => ACTIVE.has(snapshot.state)), ...mismatched].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return stale.length ? result("stale", stale[0], now) : { state: "unknown" };
}

export function pruneResponsiveDeliverySnapshots(cwd: string, options: ResponsiveDeliveryResolveOptions = {}): void {
  const now = options.now || new Date();
  for (const snapshot of readResponsiveDeliverySnapshots(cwd)) {
    const stale = ACTIVE.has(snapshot.state) ? !isActiveLive(snapshot, now, options.inspectPid) : !isFresh(snapshot, now);
    if (stale) removeResponsiveDeliverySnapshot(cwd, snapshot.pid);
  }
}

export class ResponsiveDeliveryRecorder {
  private target: ResponsiveDeliverySnapshot["target"];
  private latest?: ResponsiveDeliverySnapshot;
  constructor(private readonly options: ResponsiveDeliveryRecorderOptions) { this.target = { ...options.target }; }
  record(state: ResponsiveDeliveryPublishedState, event: ResponsiveDeliveryEvent = {}): ResponsiveDeliverySnapshot {
    const snapshot = buildResponsiveDeliverySnapshot({ pid: this.options.pid ?? process.pid, processStartedAt: this.options.processStartedAt, publisher: this.options.publisher, target: this.target }, state, event, this.options.now?.() || new Date());
    this.latest = snapshot; if (this.options.persist && this.options.cwd) writeResponsiveDeliverySnapshot(this.options.cwd, snapshot); return snapshot;
  }
  starting(event?: ResponsiveDeliveryEvent) { return this.record("starting", event); }
  watching(event?: ResponsiveDeliveryEvent) { return this.record("watching", event); }
  backoff(event?: ResponsiveDeliveryEvent) { return this.record("backoff", event); }
  stopped(event?: ResponsiveDeliveryEvent) { return this.record("stopped", event); }
  terminal(event?: ResponsiveDeliveryEvent) { return this.record("terminal", event); }
  retarget(target: ResponsiveDeliverySnapshot["target"]): void { this.target = { ...target }; }
  snapshot(): ResponsiveDeliverySnapshot | undefined { return this.latest && { ...this.latest, publisher: { ...this.latest.publisher }, target: { ...this.latest.target } }; }
}
