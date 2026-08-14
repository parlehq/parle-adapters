import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/** Credential-free local evidence for a responsive-delivery owner. */
export const RESPONSIVE_DELIVERY_SCHEMA_VERSION = 1;
export const RESPONSIVE_DELIVERY_SKEW_MS = 30_000;
export const RESPONSIVE_DELIVERY_MAX_LEASE_MS = 10 * 60_000;
export const RESPONSIVE_DELIVERY_TOMBSTONE_MS = 5 * 60_000;
export const RESPONSIVE_DELIVERY_MAX_FILE_BYTES = 64 * 1024;
export const RESPONSIVE_DELIVERY_MAX_DIAGNOSTIC_CHARS = 512;
export const RESPONSIVE_DELIVERY_PRUNE_LIMIT = 32;
export const RESPONSIVE_DELIVERY_PRUNE_INSPECTION_LIMIT = 64;
const ACTIVE = new Set(["starting", "watching", "backoff"]);
const PUBLISHED = new Set(["starting", "watching", "backoff", "stopped", "terminal"]);
// Legacy publisher identity for the MCP helper that wakes a host but never
// drains or acknowledges responsive delivery. Explicit evidence roles can
// replace this compatibility classification if more helper types appear.
const STANDALONE_WAKE_ONLY_PUBLISHER = "@parlehq/mcp-server:standalone-watch";
const ISO = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const string = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const pruneCursor = new Map();
const systemCode = (error) => typeof error?.code === "string" ? error.code : undefined;
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
function readBoundedText(path, maxBytes) {
    const fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > maxBytes)
            throw new Error("Responsive-delivery evidence exceeds its byte limit.");
        const output = Buffer.allocUnsafe(maxBytes + 1);
        let offset = 0;
        while (offset < output.length) {
            const count = readSync(fd, output, offset, output.length - offset, null);
            if (count === 0)
                break;
            offset += count;
        }
        if (offset > maxBytes)
            throw new Error("Responsive-delivery evidence exceeds its byte limit.");
        return output.subarray(0, offset).toString("utf8");
    }
    finally {
        closeSync(fd);
    }
}
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
    try {
        pruneResponsiveDeliverySnapshots(cwd, {
            now: new Date(snapshot.updatedAt),
            inspectPid: inspectResponsiveDeliveryPid,
            excludePid: snapshot.pid,
        });
    }
    catch { /* cleanup is best effort after the snapshot is committed */ }
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
            const raw = readBoundedText(join(responsiveDeliveryRuntimeDirPath(cwd), name), RESPONSIVE_DELIVERY_MAX_FILE_BYTES);
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
    const owners = exact.filter((snapshot) => snapshot.publisher.name !== STANDALONE_WAKE_ONLY_PUBLISHER);
    // Owner evidence always outranks wake-only evidence, including terminal and
    // stale owner states. Wake helpers are fallback diagnostics, never owners.
    const selected = owners.length > 0 ? owners : exact;
    const active = selected.filter((snapshot) => ACTIVE.has(snapshot.state) && isActiveLive(snapshot, now, options.inspectPid));
    if (owners.length > 0 && active.length > 1)
        return result("conflict", active.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0], now);
    if (active.length > 0) {
        const newest = active.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        return result(newest.state, newest, now);
    }
    const tombstones = selected.filter((snapshot) => !ACTIVE.has(snapshot.state) && isFresh(snapshot, now));
    if (tombstones.length) {
        const newest = tombstones.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        return result(newest.state, newest, now);
    }
    const stale = selected.filter((snapshot) => ACTIVE.has(snapshot.state)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return stale.length ? result("stale", stale[0], now) : { state: "unknown", reason: "no_evidence_for_session" };
}
function isDefinitelyGone(snapshot, inspectPid) {
    const checked = inspection(snapshot.pid, inspectPid);
    return checked === "dead" || (typeof checked === "object" && (checked.status === "dead" || Boolean(checked.processStartedAt && checked.processStartedAt !== snapshot.processStartedAt)));
}
function boundedLimit(value, fallback) {
    const parsed = Math.trunc(value ?? fallback);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}
function rotatedCandidates(dir, names, limit) {
    if (!names.length || limit === 0)
        return [];
    names.sort();
    const start = (pruneCursor.get(dir) ?? 0) % names.length;
    const count = Math.min(limit, names.length);
    const selected = Array.from({ length: count }, (_, offset) => names[(start + offset) % names.length]);
    pruneCursor.set(dir, (start + count) % names.length);
    return selected;
}
function restoreResponsiveCandidate(path, quarantine) {
    try {
        linkSync(quarantine, path);
        unlinkSync(quarantine);
    }
    catch (error) {
        if (systemCode(error) === "EEXIST") {
            try {
                unlinkSync(quarantine);
            }
            catch (unlinkError) {
                if (systemCode(unlinkError) !== "ENOENT")
                    throw unlinkError;
            }
            return;
        }
        throw error;
    }
}
function removeResponsiveCandidateIf(path, shouldRemove) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch {
        return false;
    }
    if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)))
        return false;
    try {
        const raw = readBoundedText(path, RESPONSIVE_DELIVERY_MAX_FILE_BYTES);
        const snapshot = parseResponsiveDeliverySnapshot(JSON.parse(raw));
        if (!snapshot || !shouldRemove(snapshot))
            return false;
    }
    catch {
        return false;
    }
    const quarantine = `${path}.prune-${process.pid}-${Math.random().toString(36).slice(2)}`;
    try {
        renameSync(path, quarantine);
    }
    catch (error) {
        if (systemCode(error) === "ENOENT")
            return false;
        throw error;
    }
    let remove = false;
    try {
        const raw = readBoundedText(quarantine, RESPONSIVE_DELIVERY_MAX_FILE_BYTES);
        const snapshot = parseResponsiveDeliverySnapshot(JSON.parse(raw));
        remove = Boolean(snapshot && shouldRemove(snapshot));
    }
    catch {
        remove = false;
    }
    if (remove) {
        try {
            unlinkSync(quarantine);
        }
        catch (error) {
            if (systemCode(error) !== "ENOENT")
                throw error;
        }
        return true;
    }
    restoreResponsiveCandidate(path, quarantine);
    return false;
}
/** Opportunistically inspects and removes bounded sets of expired records whose writer is definitively gone. */
export function pruneResponsiveDeliverySnapshots(cwd, options = {}) {
    const now = options.now || new Date();
    const dir = responsiveDeliveryRuntimeDirPath(cwd);
    let names;
    try {
        names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
    }
    catch {
        return;
    }
    const maxInspections = boundedLimit(options.maxInspections, RESPONSIVE_DELIVERY_PRUNE_INSPECTION_LIMIT);
    const maxRemovals = boundedLimit(options.maxRemovals, RESPONSIVE_DELIVERY_PRUNE_LIMIT);
    let removed = 0;
    for (const name of rotatedCandidates(dir, names, maxInspections)) {
        if (removed >= maxRemovals)
            break;
        const path = join(dir, name);
        if (removeResponsiveCandidateIf(path, (snapshot) => snapshot.pid !== options.excludePid && Date.parse(snapshot.expiresAt) <= now.getTime() && isDefinitelyGone(snapshot, options.inspectPid)))
            removed += 1;
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