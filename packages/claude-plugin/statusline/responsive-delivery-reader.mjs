import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Credential-free local evidence for a responsive-delivery owner. */
export const RESPONSIVE_DELIVERY_SCHEMA_VERSION = 1;
export const RESPONSIVE_DELIVERY_SKEW_MS = 30_000;
export const RESPONSIVE_DELIVERY_MAX_LEASE_MS = 10 * 60_000;
export const RESPONSIVE_DELIVERY_TOMBSTONE_MS = 5 * 60_000;
export const RESPONSIVE_DELIVERY_MAX_FILE_BYTES = 64 * 1024;
export const RESPONSIVE_DELIVERY_MAX_DIAGNOSTIC_CHARS = 512;
const ACTIVE = new Set(["starting", "watching", "backoff"]);
const PUBLISHED = new Set(["starting", "watching", "backoff", "stopped", "terminal"]);
const ISO = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const string = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
/** Removes common credentials and bounds text before it can enter local evidence. */
export function redactResponsiveDeliveryDiagnostic(value) {
    if (typeof value !== "string")
        return undefined;
    const text = value.slice(0, RESPONSIVE_DELIVERY_MAX_DIAGNOSTIC_CHARS)
        .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
        .replace(/\bparle_[a-z]+_[A-Za-z0-9_-]{20,}\b/gi, "[REDACTED]")
        .replace(/\b(parle_(?:ses|tok|secret)[A-Za-z0-9_\-.]*)\b/gi, "[REDACTED]")
        .replace(/\b(authorization|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
    return text || undefined;
}
function cleanSnapshot(input) {
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
export function buildResponsiveDeliverySnapshot(base, state, event = {}, now = new Date()) {
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
export function responsiveDeliveryRuntimeDirPath(cwd) { return join(cwd, ".parle", "runtime", "responsive"); }
export function responsiveDeliveryRuntimeFilePath(cwd, pid) { return join(responsiveDeliveryRuntimeDirPath(cwd), `${pid}.json`); }
export function writeResponsiveDeliverySnapshot(cwd, snapshot) {
    const dir = responsiveDeliveryRuntimeDirPath(cwd);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = join(dir, `.tmp-${snapshot.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, JSON.stringify(cleanSnapshot(snapshot), null, 2) + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, responsiveDeliveryRuntimeFilePath(cwd, snapshot.pid));
}
export function removeResponsiveDeliverySnapshot(cwd, pid) { rmSync(responsiveDeliveryRuntimeFilePath(cwd, pid), { force: true }); }
/** Parses only the published schema and discards malformed or future data. */
export function parseResponsiveDeliverySnapshot(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const row = value;
    if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !PUBLISHED.has(row.state) || !ISO(row.processStartedAt) || !ISO(row.updatedAt) || !ISO(row.expiresAt))
        return undefined;
    const name = string(row.publisher?.name);
    const instance = string(row.publisher?.clientInstanceId);
    const agentSessionId = string(row.target?.agentSessionId);
    if (!name || !instance || !agentSessionId)
        return undefined;
    const snapshot = {
        schemaVersion: 1, pid: row.pid, processStartedAt: row.processStartedAt,
        publisher: { name, clientInstanceId: instance, ...(string(row.publisher.version, 128) ? { version: string(row.publisher.version, 128) } : {}) },
        target: { agentSessionId, ...(string(row.target.participantId) ? { participantId: string(row.target.participantId) } : {}), ...(string(row.target.roomId) ? { roomId: string(row.target.roomId) } : {}) },
        state: row.state, updatedAt: row.updatedAt, expiresAt: row.expiresAt,
    };
    for (const key of ["lastSuccessAt", "lastWakeAt", "retryAt"])
        if (ISO(row[key]))
            snapshot[key] = row[key];
    if (row.lastError && ISO(row.lastError.at) && typeof row.lastError.message === "string")
        snapshot.lastError = { message: redactResponsiveDeliveryDiagnostic(row.lastError.message) || "[REDACTED]", at: row.lastError.at };
    const reason = redactResponsiveDeliveryDiagnostic(row.reason);
    if (reason)
        snapshot.reason = reason;
    return snapshot;
}
export function readResponsiveDeliverySnapshots(cwd) {
    let names;
    try {
        names = readdirSync(responsiveDeliveryRuntimeDirPath(cwd));
    }
    catch {
        return [];
    }
    const result = [];
    for (const name of names) {
        if (!/^\d+\.json$/.test(name))
            continue;
        try {
            const raw = readFileSync(join(responsiveDeliveryRuntimeDirPath(cwd), name), "utf8");
            if (Buffer.byteLength(raw) > RESPONSIVE_DELIVERY_MAX_FILE_BYTES)
                continue;
            const snapshot = parseResponsiveDeliverySnapshot(JSON.parse(raw));
            if (snapshot)
                result.push(snapshot);
        }
        catch { /* fail closed */ }
    }
    return result;
}
/** Node liveness probe for callers that can inspect local processes. */
export function inspectResponsiveDeliveryPid(pid) {
    try {
        process.kill(pid, 0);
        return "alive";
    }
    catch (error) {
        return error?.code === "ESRCH" ? "dead" : "unknown";
    }
}
function inspection(pid, inspectPid) {
    if (!inspectPid)
        return "unknown";
    try {
        return inspectPid(pid);
    }
    catch {
        return "unknown";
    }
}
function isFresh(snapshot, now) { return Date.parse(snapshot.expiresAt) >= now.getTime() && Date.parse(snapshot.updatedAt) <= now.getTime() + RESPONSIVE_DELIVERY_SKEW_MS; }
function isActiveLive(snapshot, now, inspectPid) {
    if (!isFresh(snapshot, now))
        return false;
    const checked = inspection(snapshot.pid, inspectPid);
    if (checked === "dead" || (typeof checked === "object" && (checked.status === "dead" || (checked.processStartedAt && checked.processStartedAt !== snapshot.processStartedAt))))
        return false;
    return true;
}
function result(state, snapshot, now = new Date()) {
    if (!snapshot)
        return { state };
    return { state, updatedAt: snapshot.updatedAt, ...(snapshot.lastSuccessAt ? { lastSuccessAt: snapshot.lastSuccessAt } : {}), ...(snapshot.lastWakeAt ? { lastWakeAt: snapshot.lastWakeAt } : {}), ...(snapshot.retryAt ? { retryAt: snapshot.retryAt } : {}), ...(snapshot.lastError ? { lastError: snapshot.lastError } : {}), ...(snapshot.reason ? { reason: snapshot.reason } : {}), evidenceAgeMs: Math.max(0, now.getTime() - Date.parse(snapshot.updatedAt)), publisher: { name: snapshot.publisher.name, ...(snapshot.publisher.version ? { version: snapshot.publisher.version } : {}) } };
}
/** Pure selection: target identity is agentSessionId, never clientInstanceId. */
export function resolveResponsiveDelivery(snapshots, agentSessionId, options = {}) {
    const now = options.now || new Date();
    const exact = snapshots.filter((snapshot) => snapshot.target.agentSessionId === agentSessionId);
    const mismatched = snapshots.filter((snapshot) => snapshot.target.agentSessionId !== agentSessionId);
    const active = exact.filter((snapshot) => ACTIVE.has(snapshot.state) && isActiveLive(snapshot, now, options.inspectPid));
    if (active.length > 1)
        return result("conflict", active.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0], now);
    if (active.length === 1)
        return result(active[0].state, active[0], now);
    const tombstones = exact.filter((snapshot) => !ACTIVE.has(snapshot.state) && isFresh(snapshot, now));
    if (tombstones.length) {
        const newest = tombstones.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        return result(newest.state, newest, now);
    }
    const stale = [...exact.filter((snapshot) => ACTIVE.has(snapshot.state)), ...mismatched].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return stale.length ? result("stale", stale[0], now) : { state: "unknown" };
}
export function pruneResponsiveDeliverySnapshots(cwd, options = {}) {
    const now = options.now || new Date();
    for (const snapshot of readResponsiveDeliverySnapshots(cwd)) {
        const stale = ACTIVE.has(snapshot.state) ? !isActiveLive(snapshot, now, options.inspectPid) : !isFresh(snapshot, now);
        if (stale)
            removeResponsiveDeliverySnapshot(cwd, snapshot.pid);
    }
}
export class ResponsiveDeliveryRecorder {
    options;
    target;
    latest;
    constructor(options) {
        this.options = options;
        this.target = { ...options.target };
    }
    record(state, event = {}) {
        const snapshot = buildResponsiveDeliverySnapshot({ pid: this.options.pid ?? process.pid, processStartedAt: this.options.processStartedAt, publisher: this.options.publisher, target: this.target }, state, event, this.options.now?.() || new Date());
        this.latest = snapshot;
        if (this.options.persist && this.options.cwd)
            writeResponsiveDeliverySnapshot(this.options.cwd, snapshot);
        return snapshot;
    }
    starting(event) { return this.record("starting", event); }
    watching(event) { return this.record("watching", event); }
    backoff(event) { return this.record("backoff", event); }
    stopped(event) { return this.record("stopped", event); }
    terminal(event) { return this.record("terminal", event); }
    retarget(target) { this.target = { ...target }; }
    snapshot() { return this.latest && { ...this.latest, publisher: { ...this.latest.publisher }, target: { ...this.latest.target } }; }
}
//# sourceMappingURL=responsive-delivery.js.map