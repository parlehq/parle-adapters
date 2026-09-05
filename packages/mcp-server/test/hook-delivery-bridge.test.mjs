import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { ParleApiError } from "@parlehq/agent-client";
import { CLAUDE_MONITOR_WAKE_FRAME, ClaudeMonitorWake } from "../dist/claude-monitor-wake.js";
import {
  HookDeliveryBridge,
  cleanupHookBridgeArtifacts,
  hookBridgeHostDir,
  hookBridgeRuntimeDescriptorPath,
  hookBridgeRuntimeHandlePath,
  hookBridgeStateDir,
} from "../dist/hook-delivery-bridge.js";

const ROOM = "room-1";

function cleanupFixture(cwd) {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(hookBridgeStateDir(cwd), { recursive: true, force: true });
}

function bridgeRuntime(overrides = {}) {
  return {
    sessionRevision: 1,
    agentSessionId: "session-1",
    sessionAlias: undefined,
    rooms: [{ roomId: ROOM, roomHandle: "bridge-room", participantId: "p-1", cursor: 0, state: "ready" }],
    ...overrides,
  };
}

// A held stream the test can push wake frames into, mirroring the real
// server: the stream stays open and frames arrive after start() returns.
function heldWakeStream(sink, signal) {
  return new Response(new ReadableStream({
    start(controller) {
      sink.push = (event) => controller.enqueue(new TextEncoder().encode(`event: wake\ndata: ${JSON.stringify(event)}\n\n`));
      signal?.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

function request(path, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.setEncoding("utf8");
    let text = "";
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      text += chunk;
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(text.slice(0, newline)));
      }
    });
    socket.once("error", reject);
  });
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

async function settle(ms = 100) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("hook delivery bridge queues SSE delivery and acks only after lease commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-delivery-bridge-"));
  const stateDir = hookBridgeStateDir(cwd);
  const hostDir = hookBridgeHostDir(cwd);
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  chmodSync(hostDir, 0o700);
  const stalePid = 99_999_999;
  const staleSocket = join(hostDir, `${stalePid}.sock`);
  const staleDescriptor = join(hostDir, `${stalePid}.runtime.json`);
  const staleHandle = join(stateDir, `${stalePid}.node`);
  writeFileSync(staleSocket, "", { mode: 0o600 });
  writeFileSync(staleDescriptor, `${JSON.stringify({ execPath: process.execPath, pid: stalePid, hostParentPid: process.ppid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  symlinkSync(process.execPath, staleHandle);
  const acknowledgements = [];
  let drainCalls = 0;
  let wakeStreams = 0;
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => {
      drainCalls += 1;
      if (drainCalls === 1) return { messages: [] };
      return { messages: [{
        seq: 7,
        event_id: "evt-7",
        content: "server-framed content",
        author: { address: "@principal.agent.session" },
        reply_route: {
          reply_route_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61",
          interaction_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e62",
          reply_hop: 14,
          remaining_reply_hops: 2,
          expires_at: "2026-08-13T12:00:00Z",
        },
      }] };
    },
    ackResponsiveDelivery: async (message) => { acknowledgements.push([message.seq, message.event_id]); },
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      if (wakeStreams === 1) return new Response("event: wake\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd, process.ppid);
  let stopped = false;
  try {
    await bridge.start();
    const descriptorPath = hookBridgeRuntimeDescriptorPath(cwd, process.pid, process.ppid);
    const handlePath = hookBridgeRuntimeHandlePath(cwd);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    assert.equal(descriptor.execPath, process.execPath);
    assert.equal(descriptor.pid, process.pid);
    assert.equal(descriptor.hostParentPid, process.ppid);
    assert.equal(typeof descriptor.startedAt, "string");
    assert.equal(statSync(descriptorPath).mode & 0o077, 0);
    assert.equal(readlinkSync(handlePath), process.execPath);
    assert.equal(existsSync(staleSocket), false, "a definitively dead sibling is cleaned before publication");
    assert.equal(existsSync(staleDescriptor), false);
    assert.equal(existsSync(staleHandle), false);
    await eventually(() => bridge.status().pending === 1);
    assert.deepEqual(acknowledgements, []);
    assert.equal(bridge.status().lastError, undefined);
    // Termination property: a batch with no fresh, actionable rows ends the
    // drain. The pending deferred row must not spin the drain to its batch cap.
    await settle();
    const settledDrains = drainCalls;
    await settle();
    assert.equal(drainCalls, settledDrains, "the drain should terminate once no batch makes progress");
    assert.ok(settledDrains < 10, `the drain should stop far below the batch cap, saw ${settledDrains}`);

    const status = await request(bridge.status().socketPath, { action: "status" });
    assert.equal(status.ownerPid, process.pid);
    assert.equal(status.hostParentPid, process.ppid);
    assert.equal(status.currentParentPid, process.ppid);
    assert.deepEqual(await request(bridge.status().socketPath, { action: "bind", sessionId: "command-code-session" }), { ok: true, bound: true });
    assert.deepEqual(await request(bridge.status().socketPath, { action: "bind", sessionId: "other-session" }), { ok: false, bound: true });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "command-code-session" });
    assert.equal(leased.messages.length, 1);
    assert.equal(leased.messages[0].content, "server-framed content");
    assert.equal(leased.messages[0].reply_route.reply_route_id, "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61");
    assert.match(leased.messages[0].clientReplyPresentation.lines.join("\n"), /call parle_reply/);
    assert.equal(leased.messages[0].clientReplyPresentation.clientWarnings.length, 1);
    assert.deepEqual(acknowledgements, []);

    const committed = await request(bridge.status().socketPath, { action: "commit", sessionId: "command-code-session", leaseId: leased.leaseId });
    assert.deepEqual(committed, { ok: true, committed: 1 });
    assert.deepEqual(acknowledgements, [[7, "evt-7"]]);
    assert.equal(bridge.status().pending, 0);
    const evidence = JSON.parse(readFileSync(join(cwd, ".parle", "runtime", "responsive", `${process.pid}.json`), "utf8"));
    assert.equal(typeof evidence.lastAckAt, "string", "bridge commit publishes acknowledgement evidence");
    await bridge.stop();
    stopped = true;
    assert.equal(existsSync(descriptorPath), false);
    assert.equal(existsSync(handlePath), false);
    assert.equal(existsSync(bridge.status().socketPath), false);
  } finally {
    if (!stopped) await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge cleanup is bounded, conservative, and current-scope only", () => {
  const scope = mkdtempSync(join(tmpdir(), "parle-hook-cleanup-"));
  const stateDir = hookBridgeStateDir(scope);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    const deadHost = 8_000_001;
    const uncertainHost = 8_000_002;
    const deadHostDir = hookBridgeHostDir(scope, deadHost);
    const uncertainHostDir = hookBridgeHostDir(scope, uncertainHost);
    const currentHostDir = hookBridgeHostDir(scope, process.ppid);
    mkdirSync(deadHostDir, { mode: 0o700 });
    mkdirSync(uncertainHostDir, { mode: 0o700 });
    mkdirSync(currentHostDir, { mode: 0o700 });
    writeFileSync(join(deadHostDir, "8000011.runtime.json"), JSON.stringify({ pid: 8_000_011, hostParentPid: deadHost }), { mode: 0o600 });
    writeFileSync(join(deadHostDir, "8000012.runtime.json"), JSON.stringify({ pid: 8_000_012, hostParentPid: deadHost }), { mode: 0o640 });
    writeFileSync(join(deadHostDir, "8000014.runtime.json"), "{}\n", { mode: 0o600 });
    symlinkSync(process.execPath, join(stateDir, "8000011.node"));
    symlinkSync(process.execPath, join(stateDir, "8000013.sock"));
    writeFileSync(join(currentHostDir, `${process.pid}.runtime.json`), JSON.stringify({ pid: process.pid, hostParentPid: process.ppid }), { mode: 0o600 });
    symlinkSync(process.execPath, join(stateDir, `${process.pid}.node`));
    for (let index = 0; index < 70; index += 1) {
      const pid = 8_100_000 + index;
      writeFileSync(join(stateDir, `${pid}.runtime.json`), JSON.stringify({ pid }), { mode: 0o600 });
    }

    const alive = (pid) => pid === uncertainHost || pid === 8_000_012 || pid === 8_000_013;
    cleanupHookBridgeArtifacts(stateDir, { processIsAlive: alive });
    assert.ok(readdirSync(stateDir).some((name) => /^81\d+\.runtime\.json$/.test(name)), "one bounded sweep leaves later candidates");
    cleanupHookBridgeArtifacts(stateDir, { processIsAlive: alive });

    assert.equal(existsSync(join(deadHostDir, "8000011.runtime.json")), false);
    assert.equal(existsSync(join(deadHostDir, "8000012.runtime.json")), true, "unsafe mode is retained");
    assert.equal(existsSync(join(deadHostDir, "8000014.runtime.json")), true, "a malformed descriptor is retained");
    assert.equal(existsSync(join(stateDir, "8000011.node")), false, "the expected dead executable symlink is removed without following it");
    assert.equal(existsSync(join(stateDir, "8000013.sock")), true, "an unexpected symlink shape is retained");
    assert.equal(existsSync(uncertainHostDir), true, "ambiguous host liveness retains an empty directory");
    assert.equal(existsSync(join(currentHostDir, `${process.pid}.runtime.json`)), true, "cleanup retains the current process's artifacts");
    assert.equal(existsSync(join(stateDir, `${process.pid}.node`)), true);
    assert.equal(existsSync(currentHostDir), true, "cleanup retains the current live host directory");
    assert.equal(readdirSync(stateDir).filter((name) => /^81\d+\.runtime\.json$/.test(name)).length, 0, "bounded repeated sweeps make progress");
  } finally {
    cleanupFixture(scope);
  }
});

test("hook bridge cleanup retains a raced replacement and continues", () => {
  const scope = mkdtempSync(join(tmpdir(), "parle-hook-cleanup-race-"));
  const stateDir = hookBridgeStateDir(scope);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const replacedPid = 8_200_001;
  const removablePid = 8_200_002;
  const replacedPath = join(stateDir, `${replacedPid}.runtime.json`);
  const removablePath = join(stateDir, `${removablePid}.runtime.json`);
  writeFileSync(replacedPath, JSON.stringify({ pid: replacedPid }), { mode: 0o600 });
  writeFileSync(removablePath, JSON.stringify({ pid: removablePid }), { mode: 0o600 });
  let targetInspections = 0;
  try {
    cleanupHookBridgeArtifacts(stateDir, {
      processIsAlive: () => false,
      lstat(path) {
        const stat = lstatSync(path);
        if (path === replacedPath && ++targetInspections === 2) return { dev: stat.dev, ino: stat.ino + 1 };
        return stat;
      },
    });
    assert.equal(existsSync(replacedPath), true, "an inode replacement observed before removal wins");
    assert.equal(existsSync(removablePath), false, "one raced candidate does not abort the sweep");
  } finally {
    cleanupFixture(scope);
  }
});

test("hook bridge binding recovers an unbound bridge but only SessionStart may replace a live binding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-binding-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd, process.ppid);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    assert.equal(bridge.bindHostSession("uncorrelated-metadata"), false, "in-band metadata cannot preempt Claude process correlation");
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-1" }), { ok: true, bound: true });
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "pending", content: "pending" } });
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2" }), { ok: false, bound: true });
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2", allowReplace: true }), { ok: true, bound: true });
    assert.equal(bridge.status().pending, 1, "SessionStart replacement preserves pending delivery");
    const leased = await request(path, { action: "take", sessionId: "host-2" });
    assert.equal(leased.messages.length, 1);
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-3", allowReplace: true }), { ok: false, bound: true });
    assert.equal(bridge.status().pending, 1, "an active lease blocks replacement without discarding work");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge rejects invalid or changed direct-parent correlation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-parent-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  assert.throws(() => new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd, 1), /greater than 1/);
  let currentParentPid = process.ppid;
  const bridge = new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd, process.ppid, () => currentParentPid);
  try {
    await bridge.start();
    currentParentPid = 1;
    const status = await request(bridge.status().socketPath, { action: "status" });
    assert.equal(status.hostParentPid, process.ppid);
    assert.equal(status.currentParentPid, 1);
    const binding = await request(bridge.status().socketPath, { action: "bind", sessionId: "host-1" });
    assert.equal(binding.ok, false);
    assert.match(binding.error, /correlation is no longer valid/);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge wait is race-free, single-waiter, and survives session revision", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-wait-"));
  const sink = {};
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream(sink, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    assert.equal(bridge.status().waiterAttached, false);
    const waiting = request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" });
    await settle(20);
    assert.equal(bridge.status().waiterAttached, true);
    assert.deepEqual(
      await request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" }),
      { ok: true, ready: true, alreadyAttached: true },
    );

    fakeClient.runtime.agentSessionId = "session-2";
    bridge.enqueue({
      roomId: ROOM,
      cursorScope: "session",
      message: { seq: 1, event_id: "evt-wait", content: "queued" },
    });
    assert.deepEqual(await waiting, { ok: true, ready: true });
    assert.equal(bridge.status().waiterAttached, false);
    assert.deepEqual(
      await request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" }),
      { ok: false, error: "Parle agent session does not own this hook bridge" },
    );
    assert.deepEqual(
      await request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-2" }),
      { ok: true, ready: true },
    );
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge wait cleans up disconnected clients and reports shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-wait-cleanup-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  let stopped = false;
  try {
    await bridge.start();
    const abandoned = connect(bridge.status().socketPath);
    abandoned.once("connect", () => abandoned.write(`${JSON.stringify({ action: "wait", agentSessionId: "session-1" })}\n`));
    await settle(20);
    abandoned.destroy();
    await settle(20);

    const waiting = request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" });
    await settle(20);
    assert.equal(bridge.status().waiterAttached, true);
    await bridge.stop();
    stopped = true;
    assert.deepEqual(await waiting, { ok: false, error: "Parle hook bridge stopped" });
    assert.equal(bridge.status().waiterAttached, false);
  } finally {
    if (!stopped) await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge restarts its owned wake stream on a client session revision", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-revision-"));
  let revisionListener;
  let wakeStreams = 0;
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    onSessionRevision: (listener) => { revisionListener = listener; return () => { revisionListener = undefined; }; },
    drainResponsiveDelivery: async () => ({ delivery: { cursor_scope: "alias" }, messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(new DOMException("revised", "AbortError")), { once: true });
        },
      }));
    },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await eventually(() => wakeStreams === 1);
    revisionListener({ revision: 2, agentSessionId: "new", generation: 2, reason: "rollover" });
    await eventually(() => wakeStreams === 2);
    assert.equal(bridge.status().lastError, undefined);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge preserves alias-scoped unacked baseline delivery", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-alias-baseline-"));
  let drains = 0;
  const acknowledgements = [];
  const fakeClient = {
    runtime: bridgeRuntime({ sessionAlias: "bridge-alias" }),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => {
      drains += 1;
      return { delivery: { cursor_scope: "alias" }, messages: [{ seq: 12, event_id: "alias-unacked", content: "redeliver" }] };
    },
    ackResponsiveDelivery: async (message) => acknowledgements.push(message),
    openWakeStream: async (signal) => new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true }); } })),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    assert.equal(bridge.status().pending, 1);
    assert.equal(bridge.status().baselineSkipped, 0);
    assert.deepEqual(acknowledgements, []);
    // Termination property: the repeated unacked alias row is queued once and
    // then stops making progress, so the baseline drain must settle.
    const settledDrains = drains;
    await settle();
    assert.equal(drains, settledDrains, "the baseline drain should terminate on a no-progress batch");
    assert.ok(settledDrains < 10, `the baseline drain should stop far below the batch cap, saw ${settledDrains}`);
    assert.equal(bridge.status().pending, 1);
    await bridge.stop();
    assert.deepEqual(acknowledgements, [], "shutdown never acknowledges an uncommitted lease");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge skips session-scoped baseline and queues rows arriving afterwards", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-session-baseline-"));
  const wakeSink = { push: () => {} };
  const acknowledgements = [];
  let queue = [
    { seq: 3, event_id: "stale-3", content: "stale backlog" },
    { seq: 4, event_id: "stale-4", content: "stale backlog" },
  ];
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => ({ delivery: { cursor_scope: "session" }, messages: [...queue] }),
    ackResponsiveDelivery: async (message) => {
      acknowledgements.push([message.seq, message.event_id]);
      queue = queue.filter((row) => row.event_id !== message.event_id);
    },
    openWakeStream: async (signal) => heldWakeStream(wakeSink, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    // Session-scoped backlog present at startup belongs to a replaced session:
    // it is counted, acknowledged, and never queued for the host.
    assert.equal(bridge.status().baselineSkipped, 2);
    assert.equal(bridge.status().pending, 0);
    assert.deepEqual(acknowledgements, [[3, "stale-3"], [4, "stale-4"]]);
    queue = [{ seq: 5, event_id: "live-5", content: "live row" }];
    wakeSink.push({});
    await eventually(() => bridge.status().pending === 1);
    // The post-baseline row is queued for the hook flow, not skipped.
    assert.equal(bridge.status().baselineSkipped, 2);
    assert.deepEqual(acknowledgements, [[3, "stale-3"], [4, "stale-4"]]);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge keeps its artifacts through a terminal wake failure and recovers on retry", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-wake-failure-"));
  let wakeStreams = 0;
  let queue = [];
  const acknowledgements = [];
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => ({ delivery: { cursor_scope: "session" }, messages: [...queue] }),
    ackResponsiveDelivery: async (message) => {
      acknowledgements.push([message.seq, message.event_id]);
      queue = queue.filter((row) => row.event_id !== message.event_id);
    },
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      if (wakeStreams === 1) throw new ParleApiError("Parle wake stream 502: Bad Gateway", { status: 502, action: "fix_client" });
      return new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true }); } }));
    },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await eventually(() => Boolean(bridge.status().lastError));
    assert.match(bridge.status().lastError, /Bad Gateway/);
    assert.equal(bridge.status().lastErrorSource, "controller");
    assert.match(bridge.status().lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(bridge.status().lastErrorKind, undefined, "controller runtime errors are not bridge lifecycle kinds");
    // The wake failure is diagnosable, not fatal: the socket keeps answering
    // and the runtime artifacts stay published for the hook flow.
    assert.equal(bridge.status().running, true);
    assert.equal(existsSync(bridge.status().socketPath), true);
    assert.equal(existsSync(hookBridgeRuntimeDescriptorPath(cwd)), true);
    assert.equal(existsSync(hookBridgeRuntimeHandlePath(cwd)), true);
    const status = await request(bridge.status().socketPath, { action: "status" });
    assert.equal(status.ok, true);
    assert.match(status.lastError, /Bad Gateway/);
    assert.equal(status.lastErrorSource, "controller");
    assert.equal(status.lastErrorAt, bridge.status().lastErrorAt);

    // The settled controller loop must not read as running forever: a later
    // bridge start() restarts delivery on the same socket. Rows found by that
    // retry belong to this live session, so they queue instead of replaying
    // the baseline skip.
    queue = [{ seq: 8, event_id: "post-recovery", content: "live row" }];
    await bridge.start();
    await eventually(() => wakeStreams >= 2);
    await eventually(() => bridge.status().pending === 1);
    assert.equal(bridge.status().baselineSkipped, 0, "a recovery drain is not a baseline window");
    assert.deepEqual(acknowledgements, [], "recovered rows still ack only through hook commit");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge attributes active room errors without manufacturing a bridge lifecycle kind", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-room-failure-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => { throw new Error("room drain unavailable"); },
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await eventually(() => bridge.status().lastErrorSource === "room");
    const status = bridge.status();
    assert.match(status.lastError, /room drain unavailable/);
    assert.match(status.lastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(status.lastErrorSource, "room");
    assert.equal(status.lastErrorKind, undefined);
    assert.equal(status.running, true);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge keys pending work by room so identical seq/event ids never collapse", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-cross-room-"));
  const wakeSink = { push: () => {} };
  const acknowledgements = [];
  let live = false;
  const fakeClient = {
    runtime: bridgeRuntime({
      rooms: [
        { roomId: "room-1", roomHandle: "one", participantId: "p-1", cursor: 0, state: "ready" },
        { roomId: "room-2", roomHandle: "two", participantId: "p-2", cursor: 0, state: "ready" },
      ],
    }),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async (_signal, roomId) => ({
      delivery: { cursor_scope: "session" },
      messages: live && !acknowledgements.some(([room]) => room === roomId)
        ? [{ seq: 7, event_id: "evt-7", content: `row for ${roomId}` }]
        : [],
    }),
    ackResponsiveDelivery: async (message, _signal, roomId) => {
      acknowledgements.push([roomId, message.seq, message.event_id]);
    },
    openWakeStream: async (signal) => heldWakeStream(wakeSink, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    live = true;
    wakeSink.push({});
    // Both rows share seq and event id; only the room distinguishes them. A
    // seq/event-only key would silently drop one room's work.
    await eventually(() => bridge.status().pending === 2);
    await request(bridge.status().socketPath, { action: "bind", sessionId: "host-1" });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 2);
    const committed = await request(bridge.status().socketPath, { action: "commit", sessionId: "host-1", leaseId: leased.leaseId });
    assert.deepEqual(committed, { ok: true, committed: 2 });
    assert.deepEqual(acknowledgements.map(([room]) => room).sort(), ["room-1", "room-2"]);
    assert.equal(bridge.status().pending, 0);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge defers exact-session rollover and fences stale leased acknowledgements", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-exact-fence-"));
  let commitGuard;
  let drains = 0;
  let wakeStreams = 0;
  const acknowledgements = [];
  const fakeClient = {
    runtime: bridgeRuntime({ agentSessionId: "old-session" }),
    ensureBootstrapped: async () => {},
    onBeforeSessionCommit: (guard) => { commitGuard = guard; return () => { commitGuard = undefined; }; },
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => {
      drains += 1;
      if (drains === 1) return { delivery: { cursor_scope: "session" }, messages: [] };
      return { delivery: { cursor_scope: "session" }, messages: [{ seq: 9, event_id: "old-exact", content: "old work" }] };
    },
    ackResponsiveDelivery: async (message) => acknowledgements.push(message),
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      if (wakeStreams === 1) return new Response("event: wake\ndata: {}\n\n");
      return new Response(new ReadableStream({ start(controller) { signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true }); } }));
    },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await eventually(() => bridge.status().pending === 1);
    await request(bridge.status().socketPath, { action: "bind", sessionId: "host-1" });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 1);
    const candidate = {
      ...fakeClient.runtime,
      sessionRevision: 2,
      agentSessionId: "successor",
      responsiveContinuity: "exact_session_not_transferred",
    };
    assert.throws(() => commitGuard({ reason: "rollover", previous: { ...fakeClient.runtime }, candidate }), /deferred/);
    assert.throws(() => commitGuard({ reason: "profile_switch", previous: { ...fakeClient.runtime }, candidate }), /profile switch is deferred/);

    // Defense in depth: even if a future caller bypasses the lifecycle guard,
    // the bridge refuses the stale lease synchronously before credentialed ack.
    fakeClient.runtime = candidate;
    const committed = await request(bridge.status().socketPath, { action: "commit", sessionId: "host-1", leaseId: leased.leaseId });
    assert.equal(committed.ok, false);
    assert.match(committed.error, /prior session revision/);
    assert.deepEqual(acknowledgements, [], "old exact-session work is never acked through the successor");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge drops an old in-flight drain that resolves after rebootstrap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-stale-drain-"));
  const wakeSink = { push: () => {} };
  const acknowledgements = [];
  let drains = 0;
  let releaseDrain;
  const blockedDrain = new Promise((resolve) => { releaseDrain = resolve; });
  const fakeClient = {
    runtime: bridgeRuntime({ agentSessionId: "drain-old" }),
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDeliveryWithFence: async () => {
      drains += 1;
      const fence = {
        sessionRevision: fakeClient.runtime.sessionRevision,
        roomId: ROOM,
        sessionAlias: fakeClient.runtime.sessionAlias,
        agentSessionId: fakeClient.runtime.agentSessionId,
      };
      if (drains === 1) return { delivery: { delivery: { cursor_scope: "session" }, messages: [] }, fence, release: () => {} };
      const delivery = await blockedDrain;
      return { delivery, fence, release: () => {} };
    },
    ackResponsiveDelivery: async (message) => acknowledgements.push(message),
    openWakeStream: async (signal) => heldWakeStream(wakeSink, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    wakeSink.push({ room_id: ROOM });
    await eventually(() => drains === 2);
    fakeClient.runtime = bridgeRuntime({ sessionRevision: 2, agentSessionId: "drain-new" });
    releaseDrain({ delivery: { cursor_scope: "session" }, messages: [{ seq: 8, event_id: "stale-in-flight", content: "old work" }] });
    await settle(30);
    assert.equal(bridge.status().pending, 0, "the old drain never inherits successor identity or reaches the host queue");
    assert.deepEqual(acknowledgements, [], "stale in-flight work is never acknowledged through the successor");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge carries alias leases across same-alias rollover", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-alias-rollover-"));
  let commitGuard;
  const acknowledgements = [];
  const fakeClient = {
    runtime: bridgeRuntime({ agentSessionId: "alias-old", sessionAlias: "durable", responsiveContinuity: "alias" }),
    ensureBootstrapped: async () => {},
    onBeforeSessionCommit: (guard) => { commitGuard = guard; return () => { commitGuard = undefined; }; },
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => ({ delivery: { cursor_scope: "alias" }, messages: [] }),
    ackResponsiveDelivery: async (message, _signal, _roomId, fence) => {
      assert.equal(fence, undefined, "alias work is fenced by alias continuity, not predecessor session identity");
      acknowledgements.push(message.event_id);
    },
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await request(bridge.status().socketPath, { action: "bind", sessionId: "host-1" });
    bridge.enqueue({ roomId: ROOM, cursorScope: "alias", message: { seq: 9, event_id: "alias-work", content: "durable work" } });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "host-1" });
    const previous = { ...fakeClient.runtime };
    const candidate = { ...previous, sessionRevision: 2, agentSessionId: "alias-new", responsiveContinuity: "alias" };
    assert.doesNotThrow(() => commitGuard({ reason: "rollover", previous, candidate }));
    fakeClient.runtime = candidate;
    assert.deepEqual(await request(bridge.status().socketPath, { action: "commit", sessionId: "host-1", leaseId: leased.leaseId }), { ok: true, committed: 1 });
    assert.deepEqual(acknowledgements, ["alias-work"]);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge abandons dead exact-session work before rebootstrap commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-dead-session-"));
  let commitGuard;
  const acknowledgements = [];
  const fakeClient = {
    runtime: bridgeRuntime({ agentSessionId: "dead-session" }),
    ensureBootstrapped: async () => {},
    onBeforeSessionCommit: (guard) => { commitGuard = guard; return () => { commitGuard = undefined; }; },
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => ({ delivery: { cursor_scope: "session" }, messages: [] }),
    ackResponsiveDelivery: async (message) => acknowledgements.push(message),
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await request(bridge.status().socketPath, { action: "bind", sessionId: "host-1" });
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 10, event_id: "dead-work", content: "old work" } });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 1);
    const previous = { ...fakeClient.runtime };
    const candidate = { ...previous, sessionRevision: 2, agentSessionId: "successor", responsiveContinuity: "exact_session_not_transferred" };

    assert.doesNotThrow(() => commitGuard({ reason: "rebootstrap", previous, candidate }));
    fakeClient.runtime = candidate;
    assert.equal(bridge.status().pending, 0);
    const staleCommit = await request(bridge.status().socketPath, { action: "commit", sessionId: "host-1", leaseId: leased.leaseId });
    assert.equal(staleCommit.ok, false);
    assert.match(staleCommit.error, /missing or expired/);
    assert.deepEqual(acknowledgements, [], "abandoned dead-session work is never acknowledged");

    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 11, event_id: "fresh-work", content: "new work" } });
    const fresh = await request(bridge.status().socketPath, { action: "take", sessionId: "host-1" });
    assert.deepEqual(fresh.messages.map((message) => message.event_id), ["fresh-work"]);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge renews lifecycle evidence on observed progress and tombstones shutdown", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-evidence-"));
  const wakeSink = { push: () => {} };
  let drains = 0;
  const fakeClient = {
    runtime: bridgeRuntime(),
    clientInstanceId: "bridge-test",
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => { drains += 1; return { messages: [] }; },
    openWakeStream: async (signal) => heldWakeStream(wakeSink, signal),
  };
  const evidencePath = join(cwd, ".parle", "runtime", "responsive", `${process.pid}.json`);
  const queueScope = join(cwd, "opaque-queue-scope");
  const bridge = new HookDeliveryBridge(fakeClient, queueScope, process.execPath, cwd);
  try {
    await bridge.start();
    await eventually(() => existsSync(evidencePath));
    const opened = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(opened.state, "watching");
    assert.equal(typeof opened.lastSuccessAt, "string", "empty fetches publish liveness");
    assert.equal(opened.lastAckAt, undefined, "empty fetches do not claim acknowledgement");
    void bridge.start();
    const afterStatus = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(afterStatus.state, "watching", "plain status startup must not clobber healthy evidence");
    assert.equal(afterStatus.updatedAt, opened.updatedAt, "plain status startup must not replace healthy evidence");
    const firstUpdatedAt = opened.updatedAt;
    await settle(5);
    wakeSink.push({ room_id: ROOM });
    await eventually(() => drains >= 3 && JSON.parse(readFileSync(evidencePath, "utf8")).updatedAt !== firstUpdatedAt);
    const renewed = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(renewed.state, "watching");
    assert.equal(typeof renewed.lastSuccessAt, "string");
    assert.equal(renewed.lastAckAt, undefined);
    await bridge.stop();
    assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).state, "stopped");
  } finally {
    await bridge.stop();
    cleanupFixture(queueScope);
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge publishes terminal evidence when socket listen fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-listen-failure-"));
  const wakeSink = { push: () => {} };
  const fakeClient = {
    runtime: bridgeRuntime(),
    clientInstanceId: "bridge-listen-test",
    ensureBootstrapped: async () => {},
    onSessionRevision: () => () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    openWakeStream: async (signal) => heldWakeStream(wakeSink, signal),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd);
  const listen = bridge.listen.bind(bridge);
  bridge.listen = async () => {
    throw Object.assign(new Error("listen EPERM: operation not permitted"), { code: "EPERM", syscall: "listen" });
  };
  const evidencePath = join(cwd, ".parle", "runtime", "responsive", `${process.pid}.json`);
  try {
    await bridge.start();
    assert.equal(bridge.status().running, false);
    assert.equal(bridge.status().lastErrorKind, "listen");
    assert.equal(bridge.status().lastErrorSource, "bridge");
    assert.match(bridge.status().lastError, /listen EPERM/);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.state, "terminal");
    assert.equal(evidence.reason, "bridge_listen_failed");
    assert.match(evidence.lastError.message, /listen EPERM/);

    await bridge.start();
    assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).state, "terminal", "retry must not leave fresh starting evidence behind");

    bridge.listen = listen;
    await bridge.start();
    assert.equal(bridge.status().running, true);
    assert.equal(bridge.status().lastError, undefined);
    assert.equal(bridge.status().lastErrorKind, undefined);
    assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).state, "watching");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook delivery bridge records runtime publication failure without throwing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-runtime-failure-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, join(cwd, "missing-node"), cwd);
  const evidencePath = join(cwd, ".parle", "runtime", "responsive", `${process.pid}.json`);
  try {
    await bridge.start();
    assert.equal(bridge.status().running, false);
    assert.equal(bridge.status().lastErrorKind, "startup");
    assert.match(bridge.status().lastError, /ENOENT/);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.state, "terminal");
    assert.equal(evidence.reason, "bridge_start_failed");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge arms host idle wake only for the hook-bound thread that MCP metadata confirms, and coalesces across take and commit (#174)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-idle-wake-"));
  const bodies = Array.from({ length: 25 }, (_, index) => `PEER-BODY-${index}-${randomToken()}`);
  let drainCalls = 0;
  let wakeStreams = 0;
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => {
      drainCalls += 1;
      if (drainCalls === 1) return { messages: [] };
      if (drainCalls === 2) return { messages: bodies.map((content, index) => ({ seq: index + 1, event_id: `evt-${index + 1}`, content })) };
      return { messages: [] };
    },
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      if (wakeStreams === 1) return new Response("event: wake\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return heldWakeStream({}, signal);
    },
  };
  const idleWake = {
    started: 0,
    stopped: 0,
    consumed: 0,
    requests: [],
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
    requestWake(threadId, stillPending) { this.requests.push({ threadId, pending: stillPending() }); },
    consumeWake() { this.consumed += 1; },
    status() { return { state: "queue-only", outstanding: false }; },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, process.execPath, cwd, process.ppid, undefined, idleWake);
  try {
    await bridge.start();
    assert.equal(idleWake.started, 1, "host verification starts with the bridge");
    await eventually(() => bridge.status().pending === 25);
    const path = bridge.status().socketPath;
    assert.deepEqual(idleWake.requests, [], "pending work alone never wakes an unbound thread");
    assert.deepEqual(bridge.status().idleWake, { state: "unavailable", reason: "host-session-unbound", outstanding: false });

    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-1" }), { ok: true, bound: true });
    assert.deepEqual(idleWake.requests, [], "a hook binding without MCP confirmation does not arm");
    assert.deepEqual(bridge.status().idleWake, { state: "unavailable", reason: "host-session-unconfirmed", outstanding: false });
    assert.equal(bridge.status().hostSessionId, "thread-1");

    assert.equal(bridge.bindHostSession("thread-2"), false, "in-band metadata never binds a correlated bridge");
    assert.equal(bridge.status().hostSessionId, "thread-1");
    assert.equal(bridge.status().metaHostSessionId, "thread-2");
    assert.deepEqual(idleWake.requests, []);
    assert.deepEqual(bridge.status().idleWake, { state: "unavailable", reason: "host-session-conflict", outstanding: false });

    assert.equal(bridge.bindHostSession("thread-1"), false);
    assert.deepEqual(idleWake.requests, [{ threadId: "thread-1", pending: true }], "agreement arms exactly one wake for the pending work");
    assert.deepEqual(bridge.status().idleWake, { state: "queue-only", outstanding: false });
    const socketStatus = await request(path, { action: "status" });
    assert.equal(socketStatus.idleWake.state, "queue-only");
    assert.equal(socketStatus.metaHostSessionId, "thread-1");

    // Zero peer-content leakage: the host module sees a thread id and a
    // predicate, never a body.
    const seen = JSON.stringify(idleWake.requests);
    for (const body of bodies) assert.equal(seen.includes(body), false);

    const first = await request(path, { action: "take", sessionId: "thread-1" });
    assert.equal(first.messages.length, 20, "the hook batch cap leaves work behind");
    assert.equal(idleWake.consumed, 1, "a take proves a live turn and consumes the trigger");
    assert.deepEqual(idleWake.requests.length, 1, "no wake is requested while a lease is live");
    assert.deepEqual(await request(path, { action: "commit", sessionId: "thread-1", leaseId: first.leaseId }), { ok: true, committed: 20 });
    assert.equal(bridge.status().pending, 5);
    assert.deepEqual(idleWake.requests, [{ threadId: "thread-1", pending: true }, { threadId: "thread-1", pending: true }], "remaining work after commit asks once more");

    const second = await request(path, { action: "take", sessionId: "thread-1" });
    assert.equal(second.messages.length, 5);
    assert.equal(idleWake.consumed, 2);
    assert.deepEqual(await request(path, { action: "commit", sessionId: "thread-1", leaseId: second.leaseId }), { ok: true, committed: 5 });
    assert.equal(idleWake.requests.length, 2, "an empty queue after commit asks for nothing");

    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 99, event_id: "evt-99", content: "later" } });
    assert.equal(idleWake.requests.length, 3, "the next 0 -> N transition asks again");
    assert.equal(idleWake.requests[2].pending, true);

    // SessionStart replacing the binding un-arms until metadata agrees again.
    const empty = await request(path, { action: "take", sessionId: "thread-1" });
    assert.deepEqual(await request(path, { action: "commit", sessionId: "thread-1", leaseId: empty.leaseId }), { ok: true, committed: 1 });
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-3", allowReplace: true }), { ok: true, bound: true });
    assert.deepEqual(bridge.status().idleWake, { state: "unavailable", reason: "host-session-conflict", outstanding: false });
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 100, event_id: "evt-100", content: "after replace" } });
    assert.equal(idleWake.requests.length, 3, "a conflicting thread is never woken");
    assert.equal(bridge.bindHostSession("thread-3"), false);
    assert.equal(idleWake.requests.length, 4);
    assert.equal(idleWake.requests[3].threadId, "thread-3");
  } finally {
    await bridge.stop();
    assert.equal(idleWake.stopped, 1);
    cleanupFixture(cwd);
  }
});

function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

function idleWakeRecorder() {
  return {
    consumed: 0,
    requests: [],
    requestWake(threadId, stillPending) { this.requests.push({ threadId, pending: stillPending() }); },
    consumeWake() { this.consumed += 1; },
    status() { return { state: "queue-only", outstanding: false }; },
  };
}

function idleWakeClient() {
  return {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
}

test("hook bridge refuses SessionStart replacement of a confirmed binding that still holds work (#174)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-confirmed-"));
  const idleWake = idleWakeRecorder();
  const bridge = new HookDeliveryBridge(idleWakeClient(), cwd, process.execPath, cwd, process.ppid, undefined, idleWake);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-1" }), { ok: true, bound: true });
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "for thread-1" } });
    // Unconfirmed with work: replaceable, as a cleared session in the same
    // process must not strand the bridge.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-2", allowReplace: true }), { ok: true, bound: true });
    assert.equal(bridge.bindHostSession("thread-2"), false, "metadata confirms thread-2");
    assert.equal(idleWake.requests.length, 1);
    // Confirmed with work: another thread's SessionStart cannot take it.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-3", allowReplace: true }), { ok: false, bound: true });
    assert.equal(bridge.status().hostSessionId, "thread-2");
    assert.deepEqual(await request(path, { action: "take", sessionId: "thread-3" }), { ok: false, error: "Host session is not bound to this Parle hook bridge" });
    const leased = await request(path, { action: "take", sessionId: "thread-2" });
    assert.equal(leased.messages.length, 1);
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-3", allowReplace: true }), { ok: false, bound: true }, "a live lease still blocks");
    assert.deepEqual(await request(path, { action: "commit", sessionId: "thread-2", leaseId: leased.leaseId }), { ok: true, committed: 1 });
    // Confirmed and drained: replaceable, and unarmed until metadata agrees.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-3", allowReplace: true }), { ok: true, bound: true });
    assert.deepEqual(bridge.status().idleWake, { state: "unavailable", reason: "host-session-conflict", outstanding: false });
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge expires an uncommitted lease actively and re-arms idle wake; a busy take counts as a live turn (#174)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-lease-expiry-"));
  let now = 1_000_000;
  const timers = [];
  const cleared = [];
  const idleWake = idleWakeRecorder();
  const bridge = new HookDeliveryBridge(idleWakeClient(), cwd, process.execPath, cwd, process.ppid, undefined, idleWake, {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, id: timers.length + 1 };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (timer) => cleared.push(timer),
  });
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "thread-1" }), { ok: true, bound: true });
    bridge.bindHostSession("thread-1");
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "first" } });
    assert.equal(idleWake.requests.length, 1);

    const leased = await request(path, { action: "take", sessionId: "thread-1" });
    assert.equal(leased.messages.length, 1);
    assert.equal(idleWake.consumed, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delayMs, 30_000);
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 2, event_id: "evt-2", content: "during lease" } });
    assert.equal(idleWake.requests.length, 1, "work arriving during a lease waits for commit or expiry");
    const busyTake = await request(path, { action: "take", sessionId: "thread-1" });
    assert.equal(busyTake.busy, true);
    assert.deepEqual(busyTake.messages, []);
    assert.equal(busyTake.status.hostSessionBound, true, "the merged busy path carries a status snapshot");
    assert.equal(idleWake.consumed, 2, "a busy take is still a live turn");

    // The hook never commits (its host died mid-turn). The lease expires on
    // its own and the work it held is re-armed.
    now += 30_000;
    timers[0].callback();
    assert.equal(bridge.status().pending, 2);
    assert.equal(idleWake.requests.length, 2, "expiry re-arms idle wake for the held and new work");
    assert.deepEqual(idleWake.requests[1], { threadId: "thread-1", pending: true });
    await assert.rejects(request(path, { action: "commit", sessionId: "thread-1", leaseId: leased.leaseId }).then((response) => { if (!response.ok) throw new Error(response.error); }), /missing or expired/);

    const again = await request(path, { action: "take", sessionId: "thread-1" });
    assert.equal(again.messages.length, 2);
    assert.equal(timers.length, 2);
    assert.deepEqual(await request(path, { action: "commit", sessionId: "thread-1", leaseId: again.leaseId }), { ok: true, committed: 2 });
    assert.deepEqual(cleared, [2], "commit cancels the expiry timer");
    assert.equal(idleWake.requests.length, 2, "nothing left to arm");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

// Idle-wake suspension (parlehq/parle-adapters#185): the host keeps ending the
// waiter task without any delivery. The bridge counts those detaches, latches
// a suspension, announces it once (claim, then commit), and resets on a prompt.
function suspensionClient() {
  return {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
    ackResponsiveDelivery: async () => {},
    openWakeStream: async (signal) => heldWakeStream({}, signal),
  };
}

const MINUTE = 60_000;

test("hook bridge counts a waiter that detaches without delivery and not one it ended", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-detach-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    assert.equal(bridge.status().waiterDetachesRecent, 0);
    assert.equal(bridge.status().idleWakeSuspended, false);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false);

    const reaped = connect(bridge.status().socketPath);
    reaped.once("connect", () => reaped.write(`${JSON.stringify({ action: "wait", agentSessionId: "session-1" })}\n`));
    await eventually(() => bridge.status().waiterAttached);
    reaped.destroy();
    await eventually(() => bridge.status().waiterDetachesRecent === 1);
    assert.equal(bridge.status().idleWakeSuspended, false);

    const delivered = request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" });
    await eventually(() => bridge.status().waiterAttached);
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "queued" } });
    assert.deepEqual(await delivered, { ok: true, ready: true });
    await settle(20);
    assert.equal(bridge.status().waiterDetachesRecent, 1, "a waiter the bridge ended with delivery is not a detach");

    const status = await request(bridge.status().socketPath, { action: "status" });
    assert.equal(status.waiterDetachesRecent, 1);
    assert.equal(status.idleWakeSuspended, false);
    assert.equal(status.idleWakeSuspensionAnnounced, false);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge suspends idle wake at three detaches inside one hour and expires older detaches", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-suspend-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const now = Date.now();
    // The window is measured from each detach, so the old pair must be more
    // than an hour before the first recent one, not merely before now.
    bridge.recordWaiterDetach(now - 130 * MINUTE);
    bridge.recordWaiterDetach(now - 130 * MINUTE);
    bridge.recordWaiterDetach(now - 30 * MINUTE);
    assert.equal(bridge.status().waiterDetachesRecent, 1, "detaches older than the hour do not count");
    assert.equal(bridge.status().idleWakeSuspended, false);
    bridge.recordWaiterDetach(now - 20 * MINUTE);
    assert.equal(bridge.status().idleWakeSuspended, false, "two recent detaches are below threshold");
    bridge.recordWaiterDetach(now);
    assert.equal(bridge.status().waiterDetachesRecent, 3);
    assert.equal(bridge.status().idleWakeSuspended, true);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false);
    for (let index = 0; index < 40; index += 1) bridge.recordWaiterDetach(now);
    assert.equal(bridge.status().waiterDetachesRecent, 16, "the detach ring is bounded");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge announces a suspension once through a committed claim and resets it on a UserPromptSubmit bind", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-announce-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" }), { ok: true, bound: true });
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1" }), { ok: true, owed: false }, "nothing is owed before a suspension");
    assert.equal((await request(path, { action: "announce-suspension", sessionId: "host-2" })).ok, false, "an unbound host session cannot claim the announcement");

    const now = Date.now();
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(now);
    assert.equal(bridge.status().idleWakeSuspended, true);
    // take snapshots current status so the hook never decides on a stale probe.
    const taken = await request(path, { action: "take", sessionId: "host-1" });
    assert.equal(taken.status.idleWakeSuspended, true);
    assert.equal(taken.status.waiterDetachesRecent, 3);

    const claimed = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
    assert.equal(claimed.owed, true);
    assert.match(claimed.claimId, /^[0-9a-f-]{36}$/);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false, "a claim is not yet an announcement");
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true }), { ok: true, owed: false }, "a live claim blocks a second claim");
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1" }), { ok: true, owed: false }, "a legacy hook cannot pre-empt a live claim either");
    const wrong = await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: "not-the-claim" });
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /missing or expired/);
    assert.deepEqual(await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: claimed.claimId }), { ok: true, announced: true });
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, true);
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1" }), { ok: true, owed: false }, "one announcement per episode");
    bridge.recordWaiterDetach(now);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, true, "further detaches inside the episode owe nothing new");

    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-1", hookEventName: "PreToolUse" }), { ok: true, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, true, "only a human prompt ends the episode");
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-1", hookEventName: "UserPromptSubmit" }), { ok: true, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, false);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false);
    assert.equal(bridge.status().waiterDetachesRecent, 0);

    // A fresh episode after the reset owes a fresh announcement. An older
    // plugin hook omits claim:true and cannot commit, so its announcement is
    // final in one step and returns no claimId.
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1" }), { ok: true, owed: true });
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, true, "a legacy announcement is marked final immediately");
    assert.equal(bridge.suspensionClaim, undefined, "a legacy announcement leaves no claim to expire");
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true }), { ok: true, owed: false });
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge makes an uncommitted suspension claim owed again after expiry, alongside an uncommitted lease", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-claim-expiry-"));
  const acknowledgements = [];
  const client = { ...suspensionClient(), ackResponsiveDelivery: async (message) => acknowledgements.push(message.event_id) };
  const bridge = new HookDeliveryBridge(client, cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" });
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "queued" } });

    // One Stop leases the row and claims the announcement, then dies before
    // writing output: nothing is acknowledged and nothing is announced.
    const leased = await request(path, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 1);
    const claimed = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
    assert.equal(claimed.owed, true);
    assert.equal(bridge.status().pending, 1);
    assert.deepEqual(acknowledgements, []);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false);
    assert.deepEqual(await request(path, { action: "take", sessionId: "host-1" }), { ok: true, busy: true, messages: [], status: bridge.status() });
    assert.equal((await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true })).owed, false, "a live claim is not re-issued");

    // Both expire uncommitted; the next Stop gets the row and the announcement again.
    bridge.lease.expiresAt = Date.now() - 1;
    bridge.suspensionClaim.expiresAt = Date.now() - 1;
    const expired = await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: claimed.claimId });
    assert.equal(expired.ok, false);
    assert.match(expired.error, /missing or expired/);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false, "an expired claim never announces");
    const retaken = await request(path, { action: "take", sessionId: "host-1" });
    assert.deepEqual(retaken.messages.map((message) => message.event_id), ["evt-1"]);
    const reclaimed = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
    assert.equal(reclaimed.owed, true);
    assert.notEqual(reclaimed.claimId, claimed.claimId);
    assert.deepEqual(await request(path, { action: "commit", sessionId: "host-1", leaseId: retaken.leaseId }), { ok: true, committed: 1 });
    assert.deepEqual(await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: reclaimed.claimId }), { ok: true, announced: true });
    assert.deepEqual(acknowledgements, ["evt-1"]);
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, true);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge fences SessionStart replacement behind a live suspension claim until it commits or expires", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-claim-fence-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" });
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    const claimed = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
    assert.equal(claimed.owed, true);

    // Another same-cwd session starts while host-1's line is written but not
    // yet committed: replacement is refused so host-1 can still commit.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2", allowReplace: true, hookEventName: "SessionStart" }), { ok: false, bound: true });
    assert.deepEqual(await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: claimed.claimId }), { ok: true, announced: true });
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2", allowReplace: true, hookEventName: "SessionStart" }), { ok: true, bound: true });
    assert.deepEqual(await request(path, { action: "announce-suspension", sessionId: "host-2", claim: true }), { ok: true, owed: false }, "the replacement cannot repeat the committed announcement");

    // An expired uncommitted claim no longer fences replacement.
    await request(path, { action: "bind", sessionId: "host-2", hookEventName: "UserPromptSubmit" });
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    const stale = await request(path, { action: "announce-suspension", sessionId: "host-2", claim: true });
    assert.equal(stale.owed, true);
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-3", allowReplace: true, hookEventName: "SessionStart" }), { ok: false, bound: true });
    bridge.suspensionClaim.expiresAt = Date.now() - 1;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-3", allowReplace: true, hookEventName: "SessionStart" }), { ok: true, bound: true });
    assert.equal((await request(path, { action: "commit-suspension", sessionId: "host-2", claimId: stale.claimId })).ok, false, "the replaced session is no longer bound");
    assert.equal((await request(path, { action: "announce-suspension", sessionId: "host-3", claim: true })).owed, true, "the expired claim is owed to the replacement");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge replays the recorded 2026-08-27/28 reap sequence as one announcement and no re-arm eligibility until reset", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-replay-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" });
    // The 21 recorded watcher reaps (UTC) of the observed 38-hour session.
    const recorded = [
      "2026-08-27T14:27:32Z", "2026-08-27T22:21:04Z", "2026-08-27T22:40:49Z", "2026-08-27T22:56:25Z",
      "2026-08-27T22:56:52Z", "2026-08-27T23:10:07Z", "2026-08-27T23:14:48Z", "2026-08-27T23:46:47Z",
      "2026-08-27T23:54:34Z", "2026-08-28T00:02:17Z", "2026-08-28T01:13:29Z", "2026-08-28T02:22:15Z",
      "2026-08-28T02:52:14Z", "2026-08-28T07:36:04Z", "2026-08-28T07:43:55Z", "2026-08-28T07:54:17Z",
      "2026-08-28T08:01:14Z", "2026-08-28T08:26:30Z", "2026-08-28T08:35:42Z", "2026-08-28T08:37:42Z",
      "2026-08-28T10:31:15Z",
    ];
    assert.equal(recorded.length, 21);
    let announcements = 0;
    let rearmEligibleAfterSuspension = 0;
    let latchedAt;
    for (const at of recorded) {
      bridge.recordWaiterDetach(Date.parse(at));
      if (latchedAt === undefined && bridge.status().idleWakeSuspended) latchedAt = at;
      // What the stateless Stop hook does at each following turn: decide on
      // the take snapshot, claim, write output, commit.
      const { status } = await request(path, { action: "take", sessionId: "host-1" });
      if (status.idleWakeSuspended) {
        if (!status.idleWakeSuspensionAnnounced) {
          const announced = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
          if (announced.owed) {
            announcements += 1;
            await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: announced.claimId });
          }
        }
      } else if (latchedAt !== undefined) {
        rearmEligibleAfterSuspension += 1;
      }
    }
    // Discovered from the data, then pinned: the rolling 60-minute window
    // first holds three detaches (22:21:04, 22:40:49, 22:56:25) at the fourth
    // recorded reap, so that is where the suspension latches.
    assert.equal(latchedAt, "2026-08-27T22:56:25Z");
    assert.equal(announcements, 1, "one announcement for the whole episode");
    assert.equal(rearmEligibleAfterSuspension, 0, "quiet stretches never silently re-enable re-arming");
    assert.equal(bridge.status().idleWakeSuspended, true);
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "UserPromptSubmit" });
    assert.equal(bridge.status().idleWakeSuspended, false);

    // Companion: a sparse cadence from the same workload's tail -- one detach
    // every two hours -- stays below the threshold and never suspends, so the
    // threshold is validated against the observed workload in both directions.
    let tick = Date.parse("2026-08-28T10:31:15Z");
    for (let index = 0; index < 21; index += 1) {
      bridge.recordWaiterDetach(tick);
      tick += 120 * MINUTE;
    }
    assert.equal(bridge.status().idleWakeSuspended, false, "a two-hour cadence never suspends");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("take returns a fresh status snapshot on every merged return path: empty, leased, and busy (#185/#174)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-take-status-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" });

    // Empty path: no pending work.
    const empty = await request(path, { action: "take", sessionId: "host-1" });
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.status.idleWakeSuspended, false);

    // A suspension latched between the hook's discovery probe and its take is
    // visible on the leased path.
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "queued" } });
    const leased = await request(path, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 1);
    assert.equal(leased.status.idleWakeSuspended, true, "the leased path snapshots current state");
    assert.equal(leased.status.waiterDetachesRecent, 3);

    // Busy path: the live lease blocks a second take, and its snapshot is
    // taken now, not replayed -- the bound session's own prompt reset that
    // landed in between is visible.
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "UserPromptSubmit" });
    const busy = await request(path, { action: "take", sessionId: "host-1" });
    assert.equal(busy.busy, true);
    assert.deepEqual(busy.messages, []);
    assert.equal(busy.status.idleWakeSuspended, false, "the busy path snapshots the state after the reset");
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("UserPromptSubmit reset cannot bypass the live lease and suspension-claim fences of the merged bridge (#185/#174)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-reset-fence-"));
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd);
  try {
    await bridge.start();
    const path = bridge.status().socketPath;
    await request(path, { action: "bind", sessionId: "host-1", hookEventName: "SessionStart" });
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(Date.now());
    const claimed = await request(path, { action: "announce-suspension", sessionId: "host-1", claim: true });
    assert.equal(claimed.owed, true);

    // Another session's UserPromptSubmit cannot replace the binding while the
    // claim is live, so it cannot reset the episode either.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2", allowReplace: true, hookEventName: "UserPromptSubmit" }), { ok: false, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, true, "a fenced bind never resets the suspension");
    assert.notEqual(bridge.suspensionClaim, undefined, "the live claim survives the refused bind");

    // Same fence for a live delivery lease after the claim commits.
    await request(path, { action: "commit-suspension", sessionId: "host-1", claimId: claimed.claimId });
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "queued" } });
    const leased = await request(path, { action: "take", sessionId: "host-1" });
    assert.equal(leased.messages.length, 1);
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-2", allowReplace: true, hookEventName: "UserPromptSubmit" }), { ok: false, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, true, "a lease-fenced bind never resets the suspension");
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, true, "the committed announcement survives the refused bind");

    // The bound session's own human prompt still ends the episode.
    assert.deepEqual(await request(path, { action: "bind", sessionId: "host-1", hookEventName: "UserPromptSubmit" }), { ok: true, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, false);
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

// Claude monitor wake (parlehq/parle-adapters#195): the bridge's idle wake is
// a loopback WebSocket the host's Monitor tool attaches to. The bridge still
// owns every decision about work; the socket carries one content-free hint.
const WAKE_URL = /^ws:\/\/127\.0\.0\.1:\d+\/([A-Za-z0-9_-]{43})$/;

function openMonitorPeer(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames = [];
    const closed = new Promise((done) => socket.addEventListener("close", (event) => done({ code: event.code, reason: event.reason })));
    socket.addEventListener("message", (event) => frames.push(String(event.data)));
    socket.addEventListener("open", () => resolve({ socket, frames, closed }));
    socket.addEventListener("error", () => reject(new Error("websocket handshake failed")));
  });
}

test("hook bridge frames an attached Claude monitor peer and hands the wake url only to the bound session's take", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-monitor-"));
  const stderr = [];
  const originalError = console.error;
  console.error = (...args) => stderr.push(args.map(String).join(" "));
  const wake = new ClaudeMonitorWake();
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd, process.execPath, cwd, process.ppid, undefined, wake);
  try {
    await bridge.start();
    await wake.ready(2_000);
    const path = bridge.status().socketPath;
    assert.equal(bridge.status().waiterAttached, false);
    assert.equal(bridge.status().idleWake.state, "unavailable");
    assert.equal(bridge.status().idleWake.reason, "monitor-not-attached");

    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-1", hookEventName: "SessionStart" }), { ok: true, bound: true });
    const empty = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.messages, []);
    const url = empty.idleWakeUrl;
    const token = url.match(WAKE_URL)?.[1];
    assert.ok(token, `an empty take hands the bound session the wake url: ${url}`);
    assert.equal(JSON.stringify(empty.status).includes(token), false, "the status snapshot inside take carries no url");
    assert.equal((await request(path, { action: "take", sessionId: "other" })).ok, false, "an unbound session gets no take and no url");
    // Claude Code sends no MCP thread metadata: the hook binding alone arms.
    assert.equal(bridge.status().metaHostSessionId, undefined);

    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "queued before attach" } });
    assert.equal(bridge.status().pending, 1);
    assert.equal(wake.status().outstanding, false, "no peer, no frame");
    assert.equal(bridge.status().idleWake.reason, "monitor-not-attached");

    const peer = await openMonitorPeer(url);
    await eventually(() => bridge.status().waiterAttached === true);
    await eventually(() => peer.frames.length === 1);
    assert.deepEqual(peer.frames, [CLAUDE_MONITOR_WAKE_FRAME], "attaching with pending work frames once");
    assert.equal(bridge.status().idleWake.state, "daemon-attached");
    assert.equal(bridge.status().idleWake.outstanding, true);
    assert.equal(bridge.status().pending, 1, "a frame dequeues nothing");
    const socketStatus = await request(path, { action: "status" });
    assert.equal(socketStatus.waiterAttached, true);
    assert.equal(socketStatus.pending, 1);
    assert.equal(JSON.stringify(socketStatus).includes(token), false, "the status action carries no url");

    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 2, event_id: "evt-2", content: "second" } });
    await settle(50);
    assert.equal(peer.frames.length, 1, "no second frame while one is outstanding");

    const first = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(first.messages.length, 2, "the frame acknowledged nothing: both rows are still leasable");
    assert.equal(first.idleWakeUrl, url);
    assert.equal(wake.status().outstanding, false, "a take consumes the outstanding frame");
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 3, event_id: "evt-3", content: "third" } });
    await settle(50);
    assert.equal(peer.frames.length, 1, "no frame while a lease is live");
    const busy = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(busy.busy, true);
    assert.equal(busy.idleWakeUrl, url, "a busy take still carries the url");
    assert.deepEqual(await request(path, { action: "commit", sessionId: "claude-1", leaseId: first.leaseId }), { ok: true, committed: 2 });
    await eventually(() => peer.frames.length === 2);
    assert.equal(bridge.status().pending, 1, "remaining work after commit frames again and stays queued");
    const second = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(second.messages.length, 1);
    assert.deepEqual(await request(path, { action: "commit", sessionId: "claude-1", leaseId: second.leaseId }), { ok: true, committed: 1 });
    await settle(50);
    assert.equal(peer.frames.length, 2, "an empty queue frames nothing");

    // The url is owner-only: not in status(), the runtime descriptor, the
    // evidence files, or anything the bridge or wake wrote to stderr.
    assert.equal(JSON.stringify(bridge.status()).includes(token), false);
    assert.equal(readFileSync(hookBridgeRuntimeDescriptorPath(cwd, process.pid, process.ppid), "utf8").includes(token), false);
    const evidenceDir = join(cwd, ".parle", "runtime", "responsive");
    const evidence = readdirSync(evidenceDir);
    assert.ok(evidence.length > 0, "evidence was published");
    for (const name of evidence) assert.equal(readFileSync(join(evidenceDir, name), "utf8").includes(token), false);
    assert.ok(stderr.length > 0, "the bridge and wake logged");
    assert.equal(stderr.join("\n").includes(token), false, "stderr never carries the token");
    assert.equal(stderr.join("\n").includes("ws://"), false, "stderr never carries the url");

    peer.socket.close(1000, "user stopped the monitor");
    await eventually(() => bridge.status().waiterAttached === false);
    await eventually(() => bridge.status().waiterDetachesRecent === 1);
    assert.equal(bridge.status().idleWake.reason, "monitor-not-attached");
  } finally {
    console.error = originalError;
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge counts Claude monitor detaches like waiter detaches and never a replacement or its own stop (#185)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-monitor-detach-"));
  const wake = new ClaudeMonitorWake({ log: () => {} });
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd, process.execPath, cwd, undefined, undefined, wake);
  let stopped = false;
  try {
    await bridge.start();
    await wake.ready(2_000);
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-1", hookEventName: "SessionStart" }), { ok: true, bound: true });
    const { idleWakeUrl: url } = await request(path, { action: "take", sessionId: "claude-1" });
    assert.match(url, WAKE_URL);

    const first = await openMonitorPeer(url);
    await eventually(() => bridge.status().waiterAttached === true);
    const second = await openMonitorPeer(url);
    assert.deepEqual(await first.closed, { code: 1000, reason: "replaced" });
    const third = await openMonitorPeer(url);
    assert.deepEqual(await second.closed, { code: 1000, reason: "replaced" });
    await settle(50);
    assert.equal(bridge.status().waiterDetachesRecent, 0, "a Monitor restart cannot manufacture a suspension");
    assert.equal(bridge.status().waiterAttached, true);
    assert.equal(wake.status().attachments, 3);

    third.socket.close();
    await eventually(() => bridge.status().waiterDetachesRecent === 1);
    assert.equal(bridge.status().waiterAttached, false);
    assert.equal(bridge.status().idleWakeSuspended, false);
    for (const expected of [2, 3]) {
      const peer = await openMonitorPeer(url);
      await eventually(() => bridge.status().waiterAttached === true);
      peer.socket.close();
      await eventually(() => bridge.status().waiterDetachesRecent === expected);
    }
    assert.equal(bridge.status().idleWakeSuspended, true, "three external closes inside the hour latch the suspension");
    assert.equal(bridge.status().idleWakeSuspensionAnnounced, false);
    const taken = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(taken.status.idleWakeSuspended, true);
    assert.equal(taken.idleWakeUrl, url, "the url is still handed out; the hook decides whether to re-arm");
    const claimed = await request(path, { action: "announce-suspension", sessionId: "claude-1", claim: true });
    assert.equal(claimed.owed, true);
    assert.deepEqual(await request(path, { action: "commit-suspension", sessionId: "claude-1", claimId: claimed.claimId }), { ok: true, announced: true });

    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-1", hookEventName: "UserPromptSubmit" }), { ok: true, bound: true });
    assert.equal(bridge.status().idleWakeSuspended, false, "a human prompt ends the episode");
    assert.equal(bridge.status().waiterDetachesRecent, 0);

    const last = await openMonitorPeer(url);
    await eventually(() => bridge.status().waiterAttached === true);
    stopped = true;
    await bridge.stop();
    assert.equal((await last.closed).code, 1001, "stop closes the peer as going away");
    assert.equal(bridge.status().waiterDetachesRecent, 0, "the bridge's own stop is not a detach");
    assert.equal(bridge.status().waiterAttached, false);
  } finally {
    if (!stopped) await bridge.stop();
    cleanupFixture(cwd);
  }
});

test("hook bridge rebinding to another session closes the monitor peer, rotates the wake url, and frames only the successor", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-monitor-rebind-"));
  const wake = new ClaudeMonitorWake({ log: () => {} });
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd, process.execPath, cwd, undefined, undefined, wake);
  try {
    await bridge.start();
    await wake.ready(2_000);
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-a", hookEventName: "SessionStart" }), { ok: true, bound: true });
    const { idleWakeUrl: urlA } = await request(path, { action: "take", sessionId: "claude-a" });
    assert.match(urlA, WAKE_URL);
    const peerA = await openMonitorPeer(urlA);
    await eventually(() => bridge.status().waiterAttached === true);

    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-a", hookEventName: "PreToolUse" }), { ok: true, bound: true });
    await settle(30);
    assert.equal(peerA.socket.readyState, WebSocket.OPEN, "re-binding the same session changes nothing");

    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-b", hookEventName: "SessionStart", allowReplace: true }), { ok: true, bound: true });
    assert.deepEqual(await peerA.closed, { code: 1000, reason: "rebound" });
    await settle(30);
    assert.equal(bridge.status().waiterDetachesRecent, 0, "a rebind close is not a detach");
    assert.equal(bridge.status().waiterAttached, false);
    assert.equal(bridge.status().hostSessionId, "claude-b");
    await assert.rejects(openMonitorPeer(urlA), "the replaced session's address is dead");

    assert.equal((await request(path, { action: "take", sessionId: "claude-a" })).ok, false, "the replaced session gets no take");
    const { idleWakeUrl: urlB } = await request(path, { action: "take", sessionId: "claude-b" });
    assert.match(urlB, WAKE_URL);
    assert.notEqual(urlB, urlA);
    const peerB = await openMonitorPeer(urlB);
    await eventually(() => bridge.status().waiterAttached === true);
    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "for b" } });
    await eventually(() => peerB.frames.length === 1);
    assert.deepEqual(peerA.frames, [], "the replaced peer heard nothing");
    peerB.socket.close();
    await peerB.closed;
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});

// The suspension latch (#185) stops the Stop hook from asking the model to
// re-arm; it never withholds a wake from a peer that is attached anyway,
// exactly as the Unix waiter is still answered while suspended.
test("hook bridge still frames an attached monitor peer while idle wake is suspended", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-monitor-suspended-"));
  const wake = new ClaudeMonitorWake({ log: () => {} });
  const bridge = new HookDeliveryBridge(suspensionClient(), cwd, process.execPath, cwd, undefined, undefined, wake);
  try {
    await bridge.start();
    await wake.ready(2_000);
    const path = bridge.status().socketPath;
    assert.deepEqual(await request(path, { action: "bind", sessionId: "claude-1", hookEventName: "SessionStart" }), { ok: true, bound: true });
    const { idleWakeUrl: url } = await request(path, { action: "take", sessionId: "claude-1" });
    const peer = await openMonitorPeer(url);
    await eventually(() => bridge.status().waiterAttached === true);
    const now = Date.now();
    for (let index = 0; index < 3; index += 1) bridge.recordWaiterDetach(now);
    assert.equal(bridge.status().idleWakeSuspended, true);

    bridge.enqueue({ roomId: ROOM, cursorScope: "session", message: { seq: 1, event_id: "evt-1", content: "while suspended" } });
    await eventually(() => peer.frames.length === 1);
    assert.deepEqual(peer.frames, [CLAUDE_MONITOR_WAKE_FRAME], "suspension withholds re-arm guidance, not delivery to an attached peer");
    assert.equal(bridge.status().idleWakeSuspended, true, "framing does not end the episode");
    const taken = await request(path, { action: "take", sessionId: "claude-1" });
    assert.equal(taken.messages.length, 1);
    assert.equal(taken.status.idleWakeSuspended, true);
    peer.socket.close();
    await peer.closed;
  } finally {
    await bridge.stop();
    cleanupFixture(cwd);
  }
});
