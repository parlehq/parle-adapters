import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findForbiddenImports } from "../scripts/check-boundaries.mjs";
import {
  ParleAgentClient,
  addressingWarning,
  assertSafeBase,
  capProjectionMessages,
  clampWaitSeconds,
  compactServerWrappedContent,
  parseKeyValueFile,
  parseSSEBlocks,
  redactedSecretValue,
  redactString,
  resolveConfig,
  summarizeSendDelivery,
  updateCursorFromMessages,
} from "../dist/index.js";

test("client boundary scan ignores prose and detects forbidden import specifiers", () => {
  assert.deepEqual(findForbiddenImports(new URL("../src", import.meta.url).pathname), []);
  const dir = mkdtempSync(join(tmpdir(), "parle-client-boundary-"));
  try {
    writeFileSync(join(dir, "ok.ts"), "// mentioning mcp, claude, galexc, and pi in prose is fine\nexport const ok = true;\n");
    assert.deepEqual(findForbiddenImports(dir), []);
    writeFileSync(join(dir, "bad.ts"), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n");
    const findings = findForbiddenImports(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].specifier, "@modelcontextprotocol/sdk/server/mcp.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config resolves env before files and redacts tokens", () => {
  const cfg = resolveConfig(process.cwd(), {
    PARLE_ROOM_ID: "room-1",
    PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
  });
  assert.equal(cfg.roomId?.value, "room-1");
  assert.equal(cfg.agentToken?.source, "env");
  assert.equal(redactString("Authorization: Bearer parle_agt_secret"), "Authorization: Bearer <redacted>");
});

test("key value parser handles quotes and comments", () => {
  assert.deepEqual(parseKeyValueFile("# hi\nA=1\nB=\"two\"\n"), { A: "1", B: "two" });
});

test("safe base rejects non-Parle hosts unless loopback opt-in is set", () => {
  assert.doesNotThrow(() => assertSafeBase("https://api.parle.sh"));
  assert.throws(() => assertSafeBase("http://evil.example"));
  assert.throws(() => assertSafeBase("https://evilparle.sh"));
  assert.doesNotThrow(() => assertSafeBase("http://localhost:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
  assert.doesNotThrow(() => assertSafeBase("http://[::1]:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
});

test("client safe-base validation uses injected env", async () => {
  const client = new ParleAgentClient({ env: { PARLE_API_BASE: "http://localhost:3000", PARLE_WAKE_BASE: "http://localhost:3001", PARLE_ALLOW_INSECURE_LOCAL: "1", PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" } });
  assert.doesNotThrow(() => client.assertConfigured());
});

test("secret values and protocol headers are redacted", () => {
  assert.deepEqual(redactedSecretValue({ source: "env", value: "opaque-token" }), { source: "env", configured: true, value: "<redacted>" });
  const text = "Bearer abc.def Idempotency-Key: idem-1 Parle-Agent-Session=s1 parle_inv_secret parle_agt_secret prt_secret";
  assert.equal(redactString(text), "Bearer <redacted> Idempotency-Key: <redacted> Parle-Agent-Session=<redacted> <redacted-token> <redacted-token> prt_<redacted>");
});

test("wait clamp is bounded and integral", () => {
  assert.equal(clampWaitSeconds(45), 30);
  assert.equal(clampWaitSeconds(-1), 0);
  assert.equal(clampWaitSeconds(2.9), 2);
});

test("SSE parser ignores keepalives and preserves partial block", () => {
  const parsed = parseSSEBlocks(": keepalive\n\nevent: wake\ndata: {\"room_id\":\"r1\"}\n\npartial");
  assert.deepEqual(parsed.events, [{ event: "wake", data: "{\"room_id\":\"r1\"}" }]);
  assert.equal(parsed.rest, "partial");
});

test("cursor math advances from messages or watermark", () => {
  assert.equal(updateCursorFromMessages(1, [{ seq: 3 }, { seq: 2 }]), 3);
  assert.equal(updateCursorFromMessages(3, [], 5), 5);
});

test("message cap does not drop an oversized first content row", () => {
  const capped = capProjectionMessages([{ seq: 9, content: "x".repeat(300_000) }], 50, 4096);
  assert.equal(capped.messages.length, 1);
  assert.equal(capped.truncated, true);
});

test("addressing warning fires only for body mentions without structured to", () => {
  assert.match(addressingWarning("@gilman.agent hello"), /will not wake/);
  assert.equal(addressingWarning("@gilman.agent hello", "@gilman.agent.session"), undefined);
});

test("send delivery summary classifies moderation envelopes", () => {
  assert.deepEqual(summarizeSendDelivery({ seq: 7, moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending", reason: "awaiting moderation completion" } }), {
    state: "accepted_scan_skipped",
    message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
  });
  const held = summarizeSendDelivery({ seq: 8, moderation: { held: true, delivered: false, scan: "queued", steps: [{ name: "scan" }], verdict: "pending", reason: "awaiting scan" } });
  assert.equal(held.state, "held_for_moderation");
  assert.equal(held.message, "awaiting scan");
  assert.match(held.nextStep, /seq 8/);
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivered: true } }), { state: "delivered", message: "Message accepted and delivered." });
  assert.equal(Object.hasOwn({ event_id: "evt-1" }, "deliveryStatus"), false);
  assert.equal(summarizeSendDelivery({ event_id: "evt-1" }), undefined);
});

test("wrapped content compacts only exact same-response framing", () => {
  const preamble = "trusted";
  const content = "trusted\n«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
  assert.equal(compactServerWrappedContent(content, preamble, "ABC"), "«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»");
  assert.equal(compactServerWrappedContent(content, "wrong", "ABC"), content);
  assert.equal(compactServerWrappedContent(content.replace("trusted\n", "trusted\n\n"), preamble, "ABC"), content.replace("trusted\n", "trusted\n\n"));
});

test("requestJson validates absolute URLs before sending bearer tokens", async () => {
  const client = new ParleAgentClient({ env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" }, fetch: async () => { throw new Error("fetch should not run"); } });
  await assert.rejects(() => client.requestJson("https://evil.example/x"), /not allowlisted/);
});

test("human session auth mode fails closed until implemented", async () => {
  const client = new ParleAgentClient({ env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" } });
  await assert.rejects(() => client.requestJson("/v/test", { authMode: "human_session" }), /human_session auth is not implemented/);
});

test("client bootstraps, reads inbox, and sends with direct addressing", async () => {
  const requests = [];
  const client = new ParleAgentClient({
    env: {
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
      PARLE_ALLOW_INSECURE_LOCAL: "1",
    },
    randomUUID: () => "idem-1",
    fetch: async (url, init = {}) => {
      const u = String(url);
      requests.push({ url: u, init });
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", address: "@p.a.s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 4, messages: [{ seq: 4, content: "hello" }] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 5, replayed: false, moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending" } }, 201);
      return json({});
    },
  });
  const inbox = await client.readInbox({ waitSeconds: 2 });
  assert.equal(inbox.cursorAfter, 4);
  const sent = await client.send({ body: "hello", to: "@p.a.s1" });
  assert.equal(sent.idempotencyKey, "idem-1");
  assert.equal(sent.deliveryStatus.state, "accepted_scan_skipped");
  assert.equal(requests.some((r) => r.url.includes("/inbound?since_seq=3&wait=2")), true);
  const sendReq = requests.find((r) => r.url.includes("/messages"));
  assert.equal(sendReq.init.headers["Idempotency-Key"], "idem-1");
  assert.equal(JSON.parse(sendReq.init.body).payload.turn, undefined);
});

test("send omits delivery status when success has no moderation envelope", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-no-moderation",
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-no-moderation", seq: 6 }, 201);
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.idempotencyKey, "idem-no-moderation");
  assert.equal(Object.hasOwn(result, "deliveryStatus"), false);
});

test("read cursor advances only through returned capped messages", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 5, messages: [{ seq: 4, content: "returned" }, { seq: 5, content: "not returned" }] });
      return json({});
    },
  });
  const result = await client.readInbox({ limitMessages: 1 });
  assert.equal(result.messages.length, 1);
  assert.equal(result.cursorAfter, 4);
});

test("401 rebootstrap retries once and preserves cursor", async () => {
  let sessions = 0;
  let readAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 12, messages: [] });
      if (u.includes("/projection?since_seq=")) {
        readAttempts += 1;
        return json({ error: { code: "unauthorized", message: "expired" } }, 401);
      }
      return json({});
    },
  });
  await assert.rejects(() => client.readProjection(), { status: 401 });
  assert.equal(sessions, 2);
  assert.equal(readAttempts, 2);
  assert.equal(client.runtime.cursor, 12);
});

test("session 404 rebootstrap retries once and surfaces second 404", async () => {
  let sessions = 0;
  let inboxAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 21, messages: [] });
      if (u.includes("/inbound")) {
        inboxAttempts += 1;
        return json({ error: { code: "session_not_found", message: "missing" } }, 404);
      }
      return json({});
    },
  });
  await assert.rejects(() => client.readInbox(), { status: 404 });
  assert.equal(sessions, 2);
  assert.equal(inboxAttempts, 2);
  assert.equal(client.runtime.cursor, 21);
});

test("affordances rebootstrap after session 404 and preserve cursor", async () => {
  let sessions = 0;
  let affordanceAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 33, messages: [] });
      if (u.includes("/affordances")) {
        affordanceAttempts += 1;
        if (affordanceAttempts === 1) return json({ error: { code: "session_not_found", message: "missing" } }, 404);
        return json({ affordances: [{ action: "send" }] });
      }
      return json({});
    },
  });
  const result = await client.affordances();
  assert.deepEqual(result.affordances, [{ action: "send" }]);
  assert.equal(sessions, 2);
  assert.equal(affordanceAttempts, 2);
  assert.equal(client.runtime.cursor, 33);
});

test("send reuses generated idempotency key across session 404 rebootstrap", async () => {
  let sessions = 0;
  let messageAttempts = 0;
  const messageKeys = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-stable",
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 44, messages: [] });
      if (u.includes("/messages")) {
        messageAttempts += 1;
        messageKeys.push(init.headers["Idempotency-Key"]);
        if (messageAttempts === 1) return json({ error: { code: "session_not_found", message: "missing" } }, 404);
        return json({ event_id: "evt-1", seq: 45 }, 201);
      }
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.idempotencyKey, "idem-stable");
  assert.deepEqual(messageKeys, ["idem-stable", "idem-stable"]);
  assert.equal(sessions, 2);
  assert.equal(client.runtime.cursor, 44);
});

test("send maps bootstrap setup errors into structured send failure", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1" },
    randomUUID: () => "idem-setup-needed",
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.idempotencyKey, "<redacted>");
  assert.match(result.error, /PARLE_ROOM_AGENT_TOKEN is missing/);
});

test("requestJson wraps fetch timeout as retryable ParleApiError", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => { throw new DOMException("timed out", "TimeoutError"); },
  });
  await assert.rejects(() => client.requestJson("/v/test"), (error) => {
    assert.equal(error.name, "ParleApiError");
    assert.equal(error.code, "timeout");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("retryable send errors return idempotency key for byte-identical retry", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-retry",
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ error: { code: "rate_limited", message: "Bearer secret" } }, 429);
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.idempotencyKey, "idem-retry");
  assert.equal(Object.hasOwn(result, "deliveryStatus"), false);
  assert.match(result.error, /Bearer <redacted>/);
});

test("connect bootstraps once, returns factual summary, and reuses live sessions", async () => {
  let sessions = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token", PARLE_ROOM_HANDLE: "room-handle" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, address: "@p.a.s1", expires_at: "2999-01-01T00:00:00Z" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 7, messages: [], held_backlog: { held_count: 2 } });
      return json({});
    },
  });
  const first = await client.connect();
  assert.equal(first.connected, true);
  assert.equal(first.reusedExistingSession, false);
  assert.equal(first.agentSessionId, "as-1");
  assert.equal(first.participantId, "part-1");
  assert.equal(first.cursor, 7);
  assert.equal(first.heldBacklogCount, 2);
  assert.equal(first.roomHandle, "room-handle");
  assert.match(first.next, /arm responsive delivery/);
  const second = await client.connect();
  assert.equal(second.reusedExistingSession, true);
  assert.equal(sessions, 1);
});

test("connect re-bootstraps an expired session", async () => {
  let sessions = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    now: () => new Date("2030-01-01T00:00:00Z"),
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "2029-01-01T00:00:00Z" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 1, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const second = await client.connect();
  assert.equal(second.reusedExistingSession, false);
  assert.equal(sessions, 2);
});

test("implicit bootstrap attaches session block to the triggering call only", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", address: "@p.a.s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 3, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 4 }, 201);
      return json({});
    },
  });
  const first = await client.readInbox();
  assert.equal(first.session.established, "this_call");
  assert.equal(first.session.sessionAddress, "@p.a.s1");
  assert.equal(first.session.agentSessionId, "as-1");
  assert.match(first.session.next, /arm responsive delivery/);
  const second = await client.readInbox();
  assert.equal(Object.hasOwn(second, "session"), false);
  const sent = await client.send({ body: "hello" });
  assert.equal(Object.hasOwn(sent, "session"), false);
});

test("send that bootstraps attaches the session block", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 1 }, 201);
      return json({});
    },
  });
  const sent = await client.send({ body: "hello" });
  assert.equal(sent.session.established, "this_call");
});

test("status exposes agent_session_id, redacts session handle, marks optional config", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      return json({});
    },
  });
  assert.equal(client.setup().connected, false);
  assert.match(client.setup().note, /Not yet connected/);
  await client.connect();
  const status = client.status();
  assert.equal(status.runtime.agentSessionId, "as-1");
  assert.equal(status.runtime.sessionHandle, "<redacted>");
  assert.equal(status.config.agentTokenId.optional, true);
  assert.match(client.setup().note, /holds a session/);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
