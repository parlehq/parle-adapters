import test from "node:test";
import assert from "node:assert/strict";
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
  updateCursorFromMessages,
} from "../dist/index.js";

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
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_handle: "s1", address: "@p.a.s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 4, messages: [{ seq: 4, content: "hello" }] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 5, replayed: false }, 201);
      return json({});
    },
  });
  const inbox = await client.readInbox({ waitSeconds: 2 });
  assert.equal(inbox.cursorAfter, 4);
  const sent = await client.send({ body: "hello", to: "@p.a.s1" });
  assert.equal(sent.idempotencyKey, "idem-1");
  assert.equal(requests.some((r) => r.url.includes("/inbound?since_seq=3&wait=2")), true);
  const sendReq = requests.find((r) => r.url.includes("/messages"));
  assert.equal(sendReq.init.headers["Idempotency-Key"], "idem-1");
  assert.equal(JSON.parse(sendReq.init.body).payload.turn, undefined);
});

test("retryable send errors return idempotency key for byte-identical retry", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-retry",
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_handle: "s1", expires_at: "later" }, 201);
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
  assert.match(result.error, /Bearer <redacted>/);
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
