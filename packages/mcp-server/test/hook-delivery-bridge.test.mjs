import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { ParleApiError } from "@parlehq/agent-client";
import {
  HookDeliveryBridge,
  hookBridgeHostDir,
  hookBridgeRuntimeDescriptorPath,
  hookBridgeRuntimeHandlePath,
  hookBridgeStateDir,
} from "../dist/hook-delivery-bridge.js";

const ROOM = "room-1";

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
  writeFileSync(staleSocket, "");
  writeFileSync(staleDescriptor, "{}\n");
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
    assert.equal(existsSync(staleSocket), true, "a stale sibling must not block publication or be deleted");
    assert.equal(existsSync(staleDescriptor), true);
    assert.equal(existsSync(staleHandle), true);
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
    await bridge.stop();
    stopped = true;
    assert.equal(existsSync(descriptorPath), false);
    assert.equal(existsSync(handlePath), false);
    assert.equal(existsSync(bridge.status().socketPath), false);
  } finally {
    if (!stopped) await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    const waiting = request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" });
    await settle(20);
    assert.deepEqual(
      await request(bridge.status().socketPath, { action: "wait", agentSessionId: "session-1" }),
      { ok: false, error: "Parle hook bridge already has a waiter" },
    );

    fakeClient.runtime.agentSessionId = "session-2";
    bridge.enqueue({
      roomId: ROOM,
      cursorScope: "session",
      message: { seq: 1, event_id: "evt-wait", content: "queued" },
    });
    assert.deepEqual(await waiting, { ok: true, ready: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    await bridge.stop();
    stopped = true;
    assert.deepEqual(await waiting, { ok: false, error: "Parle hook bridge stopped" });
  } finally {
    if (!stopped) await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    // The wake failure is diagnosable, not fatal: the socket keeps answering
    // and the runtime artifacts stay published for the hook flow.
    assert.equal(bridge.status().running, true);
    assert.equal(existsSync(bridge.status().socketPath), true);
    assert.equal(existsSync(hookBridgeRuntimeDescriptorPath(cwd)), true);
    assert.equal(existsSync(hookBridgeRuntimeHandlePath(cwd)), true);
    const status = await request(bridge.status().socketPath, { action: "status" });
    assert.equal(status.ok, true);
    assert.match(status.lastError, /Bad Gateway/);

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
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    rmSync(cwd, { recursive: true, force: true });
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
    const firstUpdatedAt = opened.updatedAt;
    await settle(5);
    wakeSink.push({ room_id: ROOM });
    await eventually(() => drains >= 3 && JSON.parse(readFileSync(evidencePath, "utf8")).updatedAt !== firstUpdatedAt);
    assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).state, "watching");
    await bridge.stop();
    assert.equal(JSON.parse(readFileSync(evidencePath, "utf8")).state, "stopped");
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hook delivery bridge records runtime publication failure without throwing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-runtime-failure-"));
  const fakeClient = {
    runtime: bridgeRuntime(),
    ensureBootstrapped: async () => {},
    drainResponsiveDelivery: async () => ({ messages: [] }),
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd, join(cwd, "missing-node"));
  try {
    await bridge.start();
    assert.equal(bridge.status().running, false);
    assert.match(bridge.status().lastError, /ENOENT/);
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
