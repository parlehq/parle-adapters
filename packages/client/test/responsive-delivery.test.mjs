import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  RESPONSIVE_DELIVERY_MAX_FILE_BYTES,
  ResponsiveDeliveryRecorder,
  buildResponsiveDeliverySnapshot,
  parseResponsiveDeliverySnapshot,
  pruneResponsiveDeliverySnapshots,
  readResponsiveDeliverySnapshots,
  redactResponsiveDeliveryDiagnostic,
  resolveResponsiveDelivery,
  responsiveDeliveryRuntimeDirPath,
  responsiveDeliveryRuntimeFilePath,
} from "../dist/index.js";

const started = "2026-01-01T00:00:00.000Z";
let ms;
const now = () => new Date(ms);
const base = (pid = 10, target = "agent-a") => ({ pid, processStartedAt: started, publisher: { name: "test", version: "1", clientInstanceId: `instance-${pid}` }, target: { agentSessionId: target } });
const active = (state = "watching", pid = 10, target = "agent-a", event = { expectedProgressMs: 20_000 }) => buildResponsiveDeliverySnapshot(base(pid, target), state, event, now());
const live = () => "alive";

test("responsive recorder normalizes progress leases, recovery, and tombstones", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const recorder = new ResponsiveDeliveryRecorder({ ...base(), now });
  const starting = recorder.starting({ expectedProgressMs: 1_000 });
  assert.equal(starting.expiresAt, new Date(ms + 31_000).toISOString());
  ms += 100;
  const watching = recorder.watching({ expectedProgressMs: 25_000, lastSuccessAt: now().toISOString() });
  assert.equal(resolveResponsiveDelivery([watching], "agent-a", { now: now(), inspectPid: live }).state, "watching");
  ms += 100;
  const backoff = recorder.backoff({ expectedProgressMs: 2_000, retryAt: new Date(ms + 2_000).toISOString() });
  assert.equal(resolveResponsiveDelivery([backoff], "agent-a", { now: now(), inspectPid: live }).state, "backoff");
  ms += 100;
  const recovered = recorder.watching({ expectedProgressMs: 1_000 });
  assert.equal(resolveResponsiveDelivery([recovered], "agent-a", { now: now(), inspectPid: live }).state, "watching");
  const stopped = recorder.stopped({ reason: "operator stop" });
  assert.equal(new Date(stopped.expiresAt).getTime() - ms, 300_000);
  assert.equal(resolveResponsiveDelivery([stopped], "agent-a", { now: now(), inspectPid: () => "dead" }).state, "stopped");
  const terminal = recorder.terminal({ reason: "repair required" });
  assert.equal(resolveResponsiveDelivery([terminal], "agent-a", { now: now(), inspectPid: () => "dead" }).state, "terminal");
});

test("acknowledgement evidence survives later liveness publications and file round trips", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const cwd = mkdtempSync(join(tmpdir(), "parle-responsive-ack-"));
  try {
    const recorder = new ResponsiveDeliveryRecorder({ ...base(15), cwd, persist: true, now });
    const first = recorder.watching({ expectedProgressMs: 570_000, lastSuccessAt: now().toISOString() });
    ms += 300_000;
    const ackAt = now().toISOString();
    recorder.watching({ expectedProgressMs: 570_000, lastAckAt: ackAt });
    ms += 300_000;
    const refreshed = recorder.watching({ expectedProgressMs: 570_000, lastSuccessAt: now().toISOString() });

    assert.equal(refreshed.lastAckAt, ackAt, "later fetch liveness retains the acknowledgement clock");
    assert.ok(Date.parse(refreshed.expiresAt) > Date.parse(first.expiresAt), "repeated empty fetches renew the lease");
    assert.equal(resolveResponsiveDelivery([refreshed], "agent-a", { now: new Date(Date.parse(first.expiresAt) + 1), inspectPid: live }).state, "watching");

    const [parsed] = readResponsiveDeliverySnapshots(cwd);
    assert.equal(parsed.lastAckAt, ackAt);
    assert.equal(resolveResponsiveDelivery([parsed], "agent-a", { now: now(), inspectPid: live }).lastAckAt, ackAt);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolver expires wedged active owners and handles PID evidence conservatively", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const snapshot = active();
  assert.equal(resolveResponsiveDelivery([snapshot], "agent-a", { now: now(), inspectPid: () => "dead" }).state, "stale");
  assert.equal(resolveResponsiveDelivery([snapshot], "agent-a", { now: now(), inspectPid: () => ({ status: "alive", processStartedAt: "2025-01-01T00:00:00Z" }) }).state, "stale");
  assert.equal(resolveResponsiveDelivery([snapshot], "agent-a", { now: now(), inspectPid: () => "unknown" }).state, "watching");
  ms += 50_001;
  assert.equal(resolveResponsiveDelivery([snapshot], "agent-a", { now: now(), inspectPid: live }).state, "stale");
});

test("resolver correlates only agent session and applies deterministic selection", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const predecessor = active("watching", 10, "agent-a");
  const successor = active("watching", 11, "agent-a");
  assert.equal(resolveResponsiveDelivery([predecessor, successor], "agent-a", { now: now(), inspectPid: live }).state, "conflict");
  const hookBridge = { ...predecessor, publisher: { ...predecessor.publisher, name: "@parlehq/mcp-server:hook-bridge" } };
  const secondHookBridge = { ...successor, publisher: { ...successor.publisher, name: "@parlehq/mcp-server:hook-bridge" } };
  const wakeOnly = { ...successor, publisher: { ...successor.publisher, name: "@parlehq/mcp-server:standalone-watch" } };
  const secondWakeOnly = { ...predecessor, publisher: { ...predecessor.publisher, name: "@parlehq/mcp-server:standalone-watch" } };
  const bridged = resolveResponsiveDelivery([hookBridge, wakeOnly], "agent-a", { now: now(), inspectPid: live });
  assert.equal(bridged.state, "watching", "a wake-only helper does not conflict with the delivery owner");
  assert.equal(bridged.publisher?.name, "@parlehq/mcp-server:hook-bridge");
  assert.equal(resolveResponsiveDelivery([hookBridge, secondHookBridge, wakeOnly], "agent-a", { now: now(), inspectPid: live }).state, "conflict", "multiple delivery owners still conflict");
  assert.equal(resolveResponsiveDelivery([wakeOnly, secondWakeOnly], "agent-a", { now: now(), inspectPid: live }).state, "watching", "multiple wake-only helpers are not delivery-owner conflicts");
  assert.equal(resolveResponsiveDelivery([wakeOnly], "agent-a", { now: now(), inspectPid: live }).state, "watching", "wake-only evidence remains a backward-compatible fallback");
  const terminalHook = buildResponsiveDeliverySnapshot({ ...base(12), publisher: hookBridge.publisher }, "terminal", { reason: "bridge stopped" }, now());
  assert.equal(resolveResponsiveDelivery([terminalHook, wakeOnly], "agent-a", { now: now(), inspectPid: live }).state, "terminal", "wake-only evidence never masks owner failure");
  assert.deepEqual(resolveResponsiveDelivery([predecessor], "agent-b", { now: now(), inspectPid: live }), { state: "unknown", reason: "no_evidence_for_session" });
  assert.deepEqual(resolveResponsiveDelivery([], "agent-a", { now: now(), inspectPid: live }), { state: "unknown", reason: "no_evidence_for_session" });
  assert.equal(resolveResponsiveDelivery([predecessor, active("watching", 13, "agent-b")], "agent-a", { now: now(), inspectPid: live }).state, "watching", "a foreign live owner does not create a conflict");
  const ownExpired = { ...predecessor, expiresAt: new Date(ms - 1).toISOString(), publisher: { ...predecessor.publisher, name: "own-publisher" } };
  const foreignTerminal = buildResponsiveDeliverySnapshot({ ...base(14, "agent-b"), publisher: { ...base(14, "agent-b").publisher, name: "foreign-publisher" } }, "terminal", { reason: "foreign failure" }, now());
  const attributed = resolveResponsiveDelivery([ownExpired, foreignTerminal], "agent-a", { now: now(), inspectPid: live });
  assert.equal(attributed.state, "stale");
  assert.equal(attributed.publisher?.name, "own-publisher");
  assert.equal(attributed.reason, undefined);
  const tombstone = buildResponsiveDeliverySnapshot(base(12), "stopped", { reason: "clean exit" }, now());
  assert.equal(resolveResponsiveDelivery([successor, tombstone], "agent-a", { now: now(), inspectPid: live }).state, "watching");
  assert.equal(resolveResponsiveDelivery([tombstone], "agent-a", { now: now(), inspectPid: () => "dead" }).state, "stopped");
  const stale = { ...predecessor, expiresAt: new Date(ms - 1).toISOString() };
  assert.equal(resolveResponsiveDelivery([stale, successor], "agent-a", { now: now(), inspectPid: live }).state, "watching");
  const recorder = new ResponsiveDeliveryRecorder({ ...base(22, "agent-a"), now });
  recorder.watching({ expectedProgressMs: 1_000 });
  recorder.retarget({ agentSessionId: "agent-b" });
  const retargeted = recorder.watching({ expectedProgressMs: 1_000 });
  assert.equal(resolveResponsiveDelivery([retargeted], "agent-a", { now: now(), inspectPid: live }).state, "unknown");
  assert.equal(resolveResponsiveDelivery([retargeted], "agent-b", { now: now(), inspectPid: live }).state, "watching");
});

test("secure persistence, malformed files, oversized files, future schemas, and diagnostics fail closed", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const cwd = mkdtempSync(join(tmpdir(), "parle-responsive-"));
  try {
    const recorder = new ResponsiveDeliveryRecorder({ ...base(456), cwd, persist: true, now });
    const snapshot = recorder.watching({ expectedProgressMs: 999_999_999, reason: "Authorization: Bearer parle_ses_secret" });
    assert.equal(new Date(snapshot.expiresAt).getTime() - ms, 600_000);
    const path = responsiveDeliveryRuntimeFilePath(cwd, 456);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(responsiveDeliveryRuntimeDirPath(cwd)).mode & 0o777, 0o700);
    assert.doesNotMatch(readFileSync(path, "utf8"), /parle_ses_secret/);
    const dir = responsiveDeliveryRuntimeDirPath(cwd);
    writeFileSync(join(dir, "9.json"), "{no");
    writeFileSync(join(dir, "10.json"), JSON.stringify({ ...snapshot, schemaVersion: 2, pid: 10 }));
    writeFileSync(join(dir, "11.json"), "x".repeat(RESPONSIVE_DELIVERY_MAX_FILE_BYTES + 1));
    assert.equal(readResponsiveDeliverySnapshots(cwd).length, 1);
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, 457), JSON.stringify({ ...snapshot, pid: 457, expiresAt: new Date(ms - 1).toISOString() }), { mode: 0o600 });
    pruneResponsiveDeliverySnapshots(cwd, { now: now(), inspectPid: () => "dead" });
    assert.equal(readResponsiveDeliverySnapshots(cwd).length, 1);
    assert.equal(parseResponsiveDeliverySnapshot({ ...snapshot, schemaVersion: 2 }), undefined);
    assert.match(redactResponsiveDeliveryDiagnostic("token=abc Bearer parle_tok_deadbeef") || "", /REDACTED/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("writer pruning requires expiry and dead ownership and bounds each sweep", () => {
  ms = Date.parse("2026-01-01T01:00:00Z");
  const cwd = mkdtempSync(join(tmpdir(), "parle-responsive-prune-"));
  try {
    const dir = responsiveDeliveryRuntimeDirPath(cwd);
    mkdirSync(dir, { recursive: true });
    const expired = (pid) => ({ ...active("watching", pid), expiresAt: new Date(ms - 1).toISOString() });
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, 700), JSON.stringify(expired(700)), { mode: 0o600 });
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, 701), JSON.stringify(expired(701)), { mode: 0o600 });
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, 702), JSON.stringify(active("watching", 702)), { mode: 0o600 });
    pruneResponsiveDeliverySnapshots(cwd, { now: now(), inspectPid: () => "dead", maxInspections: 1, maxRemovals: 1 });
    assert.equal(readResponsiveDeliverySnapshots(cwd).length, 2, "one candidate is inspected and removed per bounded sweep while a fresh dead record remains");
    pruneResponsiveDeliverySnapshots(cwd, { now: now(), inspectPid: () => "dead", maxInspections: 1, maxRemovals: 1 });
    pruneResponsiveDeliverySnapshots(cwd, { now: now(), inspectPid: () => "dead", maxInspections: 1, maxRemovals: 1 });
    assert.deepEqual(readResponsiveDeliverySnapshots(cwd).map((row) => row.pid), [702], "the rotating cursor eventually reaches later stale records");

    const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, child.pid), JSON.stringify(expired(child.pid)), { mode: 0o600 });
    new ResponsiveDeliveryRecorder({ ...base(703), cwd, persist: true, now }).watching({ expectedProgressMs: 20_000 });
    assert.equal(readResponsiveDeliverySnapshots(cwd).some((row) => row.pid === child.pid), false, "a normal write opportunistically reaps an expired dead sibling");
    assert.equal(readResponsiveDeliverySnapshots(cwd).some((row) => row.pid === 702), true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
