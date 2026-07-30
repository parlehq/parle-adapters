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
import {
  HookDeliveryBridge,
  hookBridgeRuntimeDescriptorPath,
  hookBridgeRuntimeHandlePath,
  hookBridgeStateDir,
} from "../dist/hook-delivery-bridge.js";

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

test("hook delivery bridge queues SSE delivery and acks only after lease commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-delivery-bridge-"));
  const stateDir = hookBridgeStateDir(cwd);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const deadPid = 99_999_999;
  const staleSocket = join(stateDir, `${deadPid}.sock`);
  const staleDescriptor = join(stateDir, `${deadPid}.runtime.json`);
  const staleHandle = join(stateDir, `${deadPid}.node`);
  writeFileSync(staleSocket, "");
  writeFileSync(staleDescriptor, "{}\n");
  symlinkSync(process.execPath, staleHandle);
  const acknowledgements = [];
  let drainCalls = 0;
  let wakeStreams = 0;
  const fakeClient = {
    ensureBootstrapped: async () => {},
    withRebootstrap: async (fn) => fn(),
    drainResponsiveDelivery: async () => {
      drainCalls += 1;
      if (drainCalls === 1) return { messages: [] };
      return { messages: [{ seq: 7, event_id: "evt-7", content: "server-framed content" }] };
    },
    ackResponsiveDelivery: async (message) => { acknowledgements.push([message.seq, message.event_id]); },
    openWakeStream: async (signal) => {
      wakeStreams += 1;
      if (wakeStreams === 1) return new Response("event: wake\ndata: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  const bridge = new HookDeliveryBridge(fakeClient, cwd);
  let stopped = false;
  try {
    await bridge.start();
    const descriptorPath = hookBridgeRuntimeDescriptorPath(cwd);
    const handlePath = hookBridgeRuntimeHandlePath(cwd);
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    assert.equal(descriptor.execPath, process.execPath);
    assert.equal(descriptor.pid, process.pid);
    assert.equal(typeof descriptor.startedAt, "string");
    assert.equal(statSync(descriptorPath).mode & 0o077, 0);
    assert.equal(readlinkSync(handlePath), process.execPath);
    assert.equal(existsSync(staleSocket), false);
    assert.equal(existsSync(staleDescriptor), false);
    assert.equal(existsSync(staleHandle), false);
    await eventually(() => bridge.status().pending === 1);
    assert.deepEqual(acknowledgements, []);
    assert.equal(bridge.status().lastError, undefined);
    assert.equal(drainCalls, 3, "the repeated unacked batch should terminate the drain");

    assert.deepEqual(await request(bridge.status().socketPath, { action: "bind", sessionId: "command-code-session" }), { ok: true, bound: true });
    assert.deepEqual(await request(bridge.status().socketPath, { action: "bind", sessionId: "other-session" }), { ok: false, bound: true });
    const leased = await request(bridge.status().socketPath, { action: "take", sessionId: "command-code-session" });
    assert.equal(leased.messages.length, 1);
    assert.equal(leased.messages[0].content, "server-framed content");
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

test("hook delivery bridge records runtime publication failure without throwing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-hook-runtime-failure-"));
  const fakeClient = {
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
