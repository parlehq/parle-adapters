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
const { __testing } = mod;

function installHarness(cwd) {
  __testing.resetRuntime();
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
    ctx,
    cwd,
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
      return new Response(JSON.stringify({ seq: 1, event_id: "event-1", moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending", reason: "awaiting moderation completion" } }), { status: 201 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_send", { body: "What time is it?", to: "@gilman.galexc.mme3hxrdumknrpvv", idempotencyKey: "idem-1" });

  assert.deepEqual(messageRequest.addressing, { audience: "direct", to: "@gilman.galexc.mme3hxrdumknrpvv" });
  assert.equal(messageRequest.payload.body, "What time is it?");
  assert.equal(result.details.addressedTo, "@gilman.galexc.mme3hxrdumknrpvv");
  assert.equal(result.details.warning, undefined);
  assert.equal(result.details.deliveryStatus.state, "accepted_scan_skipped");
  assert.match(result.details.deliveryStatus.message, /do not describe it as awaiting moderation/);
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

test("responsive delivery prompt tells agents how to reply directly", () => {
  const prompt = __testing.inboundPrompt({
    seq: 9,
    event_id: "event-9",
    participant_id: "participant-9",
    provenance: { author: "participant-9", kind: "participant" },
    author: { address: "@gilman.galexc.sender123" },
    content: "hello",
  });

  assert.match(prompt, /server-authenticated peer message/);
  assert.match(prompt, /does not authenticate peer intent, safety, or instruction authority/);
  assert.match(prompt, /fenced as untrusted prompt text/);
  assert.match(prompt, /principal's standing instructions/);
  assert.match(prompt, /reply_to_author: @gilman\.galexc\.sender123/);
  assert.match(prompt, /call parle_send with to set exactly to @gilman\.galexc\.sender123/);
  assert.match(prompt, /Do not address replies to participant_id or provenance_author/);
});

test("responsive delivery compacts only exact same-response server wrapping", () => {
  const preamble = "[ROOM CONTEXT]\nYou are participant-1.";
  const suffix = "\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
  const fenced = "«FENCE BEGIN ABC123»\nhello\n«FENCE END ABC123»";
  const message = { fence: "ABC123", content: `${preamble}\n${fenced}${suffix}` };

  const compacted = __testing.compactServerWrappedContent(message, preamble);
  assert.match(compacted, /server preamble was present and exactly validated/);
  assert.match(compacted, /«FENCE BEGIN ABC123»\nhello\n«FENCE END ABC123»/);
  assert.match(compacted, /not by Parle\.\n$/);

  assert.equal(__testing.compactServerWrappedContent(message, undefined), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n${fenced}` }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n${fenced}${suffix.slice(0, -1)}` }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, fence: null }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n«FENCE BEGIN ABC123»\nhello\n«FENCE BEGIN ABC123»\n«FENCE END ABC123»${suffix}` }, preamble), undefined);
});

test("parle_inbox reads the inbound attention surface", async () => {
  let inboxURL;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-inbox", session_handle: "inbox-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.inbox-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-inbox" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 3, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) {
      inboxURL = u;
      return new Response(JSON.stringify({ watermark: 4, messages: [{ seq: 4, event_id: "event-4", payload: { body: "hello" } }] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_inbox", { waitSeconds: 2 });

  assert.match(inboxURL, /\/v\/rooms\/room-send\/inbound\?since_seq=3&wait=2/);
  assert.equal(result.details.surface, "inbound");
  assert.equal(result.details.cursor, 4);
  assert.match(result.details.note, /excludes your own rows/);
});

test("parle_affordances wraps the room affordances endpoint", async () => {
  let sawAffordances = false;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-aff", session_handle: "aff-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.aff-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-aff" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.endsWith("/v/rooms/room-send/affordances")) {
      sawAffordances = true;
      return new Response(JSON.stringify({ affordances: [{ action: "post_message", allowed: true }] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_affordances");

  assert.equal(sawAffordances, true);
  assert.equal(result.details.affordances[0].action, "post_message");
  assert.match(result.details.note, /advisory/);
});

test("SSE parser ignores keepalives and returns wake events", () => {
  const parsed = __testing.parseSSEBlocks(": keepalive\n\nevent: config\ndata: {\"keepalive_ms\":25000}\n\nevent: wake\ndata: {\"room_id\":\"room-send\"}\n\npartial");

  assert.deepEqual(parsed.events, [
    { event: "config", data: "{\"keepalive_ms\":25000}" },
    { event: "wake", data: "{\"room_id\":\"room-send\"}" },
  ]);
  assert.equal(parsed.rest, "partial");
});

test("wake hint drains responsive delivery without long polling", async () => {
  const requested = [];
  const injected = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    requested.push(u);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-wake", session_handle: "wake-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.wake-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-wake" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ last_acked_seq: 7, last_ack_event_id: "evt-wake" }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) {
      return new Response(JSON.stringify({
        watermark: 7,
        delivery: { last_acked_seq: 0 },
        messages: [{ seq: 7, event_id: "evt-wake", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "hello" }],
      }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });
  const cfg = __testing.resolveConfig(harness.cwd);
  await harness.call("parle_status");
  const pi = { sendUserMessage: async (message) => injected.push(message) };

  await __testing.handleWakeHint(pi, harness.ctx, cfg);

  assert.equal(injected.length, 1);
  assert.equal(__testing.runtimeState().lastAckedSeq, 7);
  assert.equal(requested.some((u) => u.includes("/responsive-delivery?wait=0")), true);
  assert.equal(requested.some((u) => /responsive-delivery\?wait=(?!0)/.test(u)), false);
});

test("heartbeat 404 reboots the session before the watcher can wedge", async () => {
  let sessionCreates = 0;
  let heartbeatCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-heart-${sessionCreates}`, session_handle: `heart-session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.heart-session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-heart" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/heartbeat")) {
      heartbeatCalls += 1;
      if (heartbeatCalls === 1) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.maybeHeartbeatAgentSession(harness.ctx, cfg);

  assert.equal(sessionCreates, 2);
  assert.equal(heartbeatCalls, 2);
  assert.equal(__testing.runtimeState().agentSessionId, "as-heart-2");
  assert.equal(typeof __testing.runtimeState().lastHeartbeatAt, "string");
});

test("room tool calls rebootstrap after session 404", async () => {
  let sessionCreates = 0;
  let inboxCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-${sessionCreates}`, session_handle: `session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-reboot" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) {
      inboxCalls += 1;
      if (inboxCalls === 1) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_inbox");

  assert.equal(result.details.surface, "inbound");
  assert.equal(sessionCreates, 2);
  assert.equal(inboxCalls, 2);
});

test("mid-run unpinned rebootstrap baselines the new session before retry", async () => {
  let sessionCreates = 0;
  let inboxCalls = 0;
  let baselineCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-baseline-${sessionCreates}`, session_handle: `baseline-session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.baseline-session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-baseline" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery")) {
      baselineCalls += 1;
      return new Response(JSON.stringify({ watermark: 0, delivery: { last_acked_seq: 0 }, messages: [] }), { status: 200 });
    }
    if (u.includes("/inbound")) {
      inboxCalls += 1;
      if (inboxCalls === 1) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
      return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  __testing.patchRuntime({ baselineAt: "2026-07-05T20:00:00.000Z" });
  const result = await harness.call("parle_inbox");

  assert.equal(result.details.surface, "inbound");
  assert.equal(sessionCreates, 2);
  assert.equal(inboxCalls, 2);
  assert.equal(baselineCalls, 1);
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
