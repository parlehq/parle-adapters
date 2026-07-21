import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { CommandCodeWakeBridge } from "../dist/command-code-bridge.js";

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

test("Command Code wake bridge queues SSE delivery and acks only after lease commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-command-code-bridge-"));
  const acknowledgements = [];
  let drainCalls = 0;
  let wakeStreams = 0;
  const fakeClient = {
    ensureBootstrapped: async () => {},
    withRebootstrap: async (fn) => fn(),
    drainResponsiveDelivery: async () => {
      drainCalls += 1;
      if (drainCalls === 2) return { messages: [{ seq: 7, event_id: "evt-7", content: "server-framed content" }] };
      return { messages: [] };
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
  const bridge = new CommandCodeWakeBridge(fakeClient, cwd);
  try {
    await bridge.start();
    await eventually(() => bridge.status().pending === 1);
    assert.deepEqual(acknowledgements, []);

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
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
