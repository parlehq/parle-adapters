import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const jitiFactory = req("jiti");
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const mod = jiti("../src/index.ts");

function installHarness(cwd) {
  const tools = {};
  const commands = {};
  const pi = {
    on() {},
    registerCommand(name, spec) { commands[name] = spec; },
    registerTool(spec) { tools[spec.name] = spec; },
  };
  mod.default(pi);
  const ctx = { cwd, ui: { setStatus() {}, notify() {} } };
  return {
    tools,
    commands,
    call(name, params = {}) {
      return tools[name].execute("tc", params, undefined, undefined, ctx);
    },
  };
}

function clearParleEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PARLE")) delete process.env[key];
  }
}

function tempProject(env = "") {
  clearParleEnv();
  const dir = mkdtempSync(join(tmpdir(), "parle-pi-extension-"));
  if (env) writeFileSync(join(dir, ".env"), env);
  return dir;
}

test("status reads room and token from project .env and redacts token", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  globalThis.fetch = async () => { throw new Error("offline test"); };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.roomId.set, true);
  assert.equal(status.details.roomId.value, "room-1");
  assert.equal(status.details.agentToken.set, true);
  assert.equal(status.details.agentToken.value, "<redacted>");
});

test("status bootstraps and redacts session handle", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-1", session_handle: "raw-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.raw-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-1", room_id: "room-1", agent_session_id: "as-1" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.runtime.sessionHandle, "<redacted>");
  assert.equal(status.details.runtime.sessionAddress, "@p.a.raw-session");
});

test("mutating request requires exact confirmation scope", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const harness = installHarness(cwd);
  await assert.rejects(
    harness.call("parle_request", { method: "POST", path: "/v/rooms" }),
    /confirmScope=POST \/v\/rooms/,
  );
  const ok = await harness.call("parle_request", { method: "POST", path: "/v/rooms", confirmMutation: true, confirmScope: "POST /v/rooms", reason: "test" });
  assert.equal(ok.details.ok, true);
});

function installSendHarness(fetchImpl) {
  const cwd = tempProject("PARLE_ROOM_ID=room-send\nPARLE_ROOM_AGENT_TOKEN=token-send\n");
  globalThis.fetch = fetchImpl;
  return installHarness(cwd);
}

test("parle_send includes direct addressing when to is present", async () => {
  let messageRequest;
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-send", session_handle: "send-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.send-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-send" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.endsWith("/v/rooms/room-send/messages")) {
      messageRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({ seq: 1, event_id: "event-1", moderation: { held: false } }), { status: 201 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_send", { body: "What time is it?", to: "@gilman.galexc.mme3hxrdumknrpvv", idempotencyKey: "idem-1" });

  assert.deepEqual(messageRequest.addressing, { audience: "direct", to: "@gilman.galexc.mme3hxrdumknrpvv" });
  assert.equal(messageRequest.payload.body, "What time is it?");
  assert.equal(result.details.addressedTo, "@gilman.galexc.mme3hxrdumknrpvv");
  assert.equal(result.details.warning, undefined);
  assert.match(result.details.retry, /identical to\/addressing/);
});

test("parle_send without to stays unaddressed and warns on leading body mention", async () => {
  let messageRequest;
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/rooms/room-send/messages")) {
      messageRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({ seq: 2, event_id: "event-2" }), { status: 201 });
    }
    return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
  });

  const result = await harness.call("parle_send", { body: "ask @gilman.galexc.mme3hxrdumknrpvv what time it is", idempotencyKey: "idem-2" });

  assert.equal(Object.hasOwn(messageRequest, "addressing"), false);
  assert.match(result.details.warning, /will not wake a peer watcher/);
});

test("parle_send treats direct addressing failures as non-retryable with hint", async () => {
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/rooms/room-send/messages")) {
      return new Response(JSON.stringify({ error: { code: "address_not_deliverable", message: "address not deliverable" } }), { status: 422 });
    }
    return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
  });

  const result = await harness.call("parle_send", { body: "hello", to: "@missing.agent", idempotencyKey: "idem-3" });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.retryable, false);
  assert.equal(result.details.idempotencyKey, "<redacted>");
  assert.match(result.details.hint, /target is a live room participant/);
  assert.match(result.details.error, /address not deliverable/);
});
