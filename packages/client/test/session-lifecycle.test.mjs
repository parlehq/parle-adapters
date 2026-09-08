import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VERSION,
  ParleAgentClient,
  ResponsiveDeliveryController,
  deterministicSessionJitterMs,
  sessionRolloverAtMs,
} from "../dist/index.js";

const ENV = {
  PARLE_ROOM_ID: "room-1",
  PARLE_ROOM_AGENT_TOKEN: "agent-token",
  PARLE_SESSION_ALIAS: "main",
  PARLE_ALLOW_INSECURE_LOCAL: "1",
  PARLE_API_BASE: "http://localhost:3000",
  PARLE_WAKE_BASE: "http://localhost:3000",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(id, generation = 0) {
  return {
    agent_session_id: id,
    session_credential: `parle_ses_${id}`,
    session_handle: `handle-${id}`,
    generation,
    created_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T01:00:00.000Z",
    address: `@p.a.handle-${id}`,
  };
}

test("anonymous session creation sends a closed empty object and the current version", async () => {
  const seen = [];
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      seen.push([init.method || "GET", path, init.body, init.headers["Parle-Version"]]);
      if (path === "/v/agent/sessions") return json(session("anon"), 201);
      if (path.endsWith("/participants")) return json({ participant_id: "part-anon" }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 4, messages: [] });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  assert.deepEqual(JSON.parse(seen[0][2]), {});
  assert.equal(seen[0][3], "2026-08-17");
  assert.equal(DEFAULT_VERSION, "2026-08-17");
  await client.endSession().catch(() => undefined);
});







test("a rejected rollover guard runs before the claim and leaves alias authority untouched", async () => {
  const claims = [];
  const ended = [];
  let generation = 1;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`c-${claims.length + ended.length + 1}`), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation, current_agent_session_id: "prior" });
      if (path.endsWith("/participants")) return json({ participant_id: "p-1" }, 201);
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        claims.push(path.split("/").at(-2));
        generation += 1;
        return json({ ...session("claimed", generation), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) { ended.push(path.split("/").at(-2)); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  const live = client.runtime.agentSessionId;
  const claimsAfterBootstrap = claims.length;
  // A guard that rejects after a successful claim would strand alias
  // authority on a candidate this client never publishes.
  const release = client.onBeforeSessionCommit((plan) => {
    if (plan.reason === "rollover") throw new Error("bridge is busy");
  });
  await assert.rejects(client.performProactiveRollover(), /bridge is busy/);
  release();
  assert.equal(claims.length, claimsAfterBootstrap, "no claim is issued once the pre-claim guard rejects");
  assert.equal(client.runtime.agentSessionId, live, "the live session keeps serving the alias");
  assert.equal(ended.length, 1, "the unclaimed candidate is retired");
  await client.endSession();
});









test("lifecycle exclusion joins rollover before end and the ended fence prevents resurrection", async () => {
  let creates = 0;
  let releaseCandidate;
  const candidateGate = new Promise((resolve) => { releaseCandidate = resolve; });
  const ended = [];
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") {
        creates += 1;
        if (creates === 2) await candidateGate;
        return json(session(`life-${creates}`), 201);
      }
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session" }, messages: [] });
      if (path.endsWith("/end")) { ended.push(path.split("/").at(-2)); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  const rollover = client.performProactiveRollover();
  await new Promise((resolve) => setImmediate(resolve));
  const ending = client.endSession();
  releaseCandidate();
  await Promise.all([rollover, ending]);
  assert.equal(client.runtime.bootstrapped, false);
  assert.equal(client.runtime.agentSessionId, "");
  assert.deepEqual(ended, ["life-2"], "automatic rollover leaves the predecessor for exact-session drain");
  await assert.rejects(client.performProactiveRollover(), /lifecycle has ended/);
  await assert.rejects(client.bootstrap(), /lifecycle has ended/);
});

test("a completed responsive read stays fenced until its caller binds the result", async () => {
  let creates = 0;
  const ended = [];
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session(`read-fence-${++creates}`), 201);
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session" }, messages: [{ seq: 1, event_id: "old-work" }] });
      if (path.endsWith("/end")) { ended.push(path.split("/").at(-2)); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path} ${init.method || "GET"}`);
    },
  });
  await client.connect();
  const read = await client.drainResponsiveDeliveryWithFence();
  assert.equal(read.delivery.messages[0].event_id, "old-work");
  await assert.rejects(client.performProactiveRollover(), /being read/);
  assert.equal(client.runtime.agentSessionId, "read-fence-1");
  read.release();
  await client.endSession();
  assert.deepEqual(ended, ["read-fence-2", "read-fence-1"], "the blocked candidate and original session are both retired");
});

test("a responsive fence preserves its requested session scope", async () => {
  let creates = 0;
  let generation = 0;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`scope-${++creates}`), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation, current_agent_session_id: generation ? `scope-${creates}` : null });
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        generation += 1;
        return json({ ...session(`scope-${creates}`, generation), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session", alias_context: null }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  client.runtime.responsiveCursorScope = undefined;
  const read = await client.drainResponsiveDeliveryWithFence();
  try {
    assert.equal(read.fence.cursorScope, "session");
  } finally {
    read.release();
  }
  await client.endSession();
});

test("a retained responsive fence permits ack-triggered rebootstrap without self-blocking", async () => {
  let creates = 0;
  let ackAttempts = 0;
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session(`ack-bootstrap-${++creates}`), 201);
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session" }, messages: [{ seq: 1, event_id: "baseline-work" }] });
      if (path.endsWith("/responsive-delivery/ack")) {
        ackAttempts += 1;
        if (ackAttempts === 1) return json({ error: { code: "agent_session_expired", message: "expired", action: "rebootstrap", retryable: false, scope: "agent_session" } }, 401);
        return json({ delivery: { cursor_scope: "session", last_acked_seq: 1 } });
      }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path} ${init.method || "GET"}`);
    },
  });
  await client.connect();
  const read = await client.drainResponsiveDeliveryWithFence();
  try {
    await client.ackResponsiveDelivery(read.delivery.messages[0]);
  } finally {
    read.release();
  }
  assert.equal(creates, 2);
  assert.equal(ackAttempts, 2);
  assert.equal(client.runtime.agentSessionId, "ack-bootstrap-2");
  await client.endSession();
});

test("an exact-session ack fence prevents retry through a rebootstrap successor", async () => {
  let creates = 0;
  let ackAttempts = 0;
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session(`fenced-ack-${++creates}`), 201);
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery/ack")) {
        ackAttempts += 1;
        return json({ error: { code: "agent_session_ended", message: "ended", action: "rebootstrap", retryable: false, scope: "agent_session" } }, 401);
      }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path} ${init.method || "GET"}`);
    },
  });
  await client.connect();
  const fence = { sessionRevision: client.runtime.sessionRevision, agentSessionId: client.runtime.agentSessionId };
  await assert.rejects(
    client.ackResponsiveDelivery({ seq: 1, event_id: "old-work" }, undefined, undefined, fence),
    (error) => error.code === "responsive_delivery_session_changed" && error.scope === "request",
  );
  assert.equal(creates, 2);
  assert.equal(ackAttempts, 1, "the stale ack is never retried with the successor credential");
  assert.equal(client.runtime.agentSessionId, "fenced-ack-2");
  assert.equal(client.runtime.rolloverLatched, false);
  assert.equal(client.runtime.rolloverFailures || 0, 0);
  await client.endSession();
});

test("bounded rollover storm protection retries after a quiet cooldown without a hot loop", async () => {
  let nowMs = Date.parse("2026-08-01T00:10:00Z");
  let creates = 0;
  const timers = [];
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    now: () => new Date(nowMs),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") {
        creates += 1;
        if (creates >= 2 && creates <= 4) throw new TypeError("transient outage");
        return json(session(`cool-${creates}`), 201);
      }
      if (path.endsWith("/participants")) return json({ participant_id: "p" }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session" }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(client.performProactiveRollover(), /transient outage/);
  assert.equal(creates, 4);
  assert.equal(client.runtime.rolloverLatched, true);
  const cooldown = timers.at(-1);
  assert.equal(cooldown.delayMs, 60_000);
  assert.equal(cooldown.unrefCalled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 4, "cooldown schedules no hot-loop request");
  nowMs += 60_000;
  cooldown.callback();
  for (let attempt = 0; attempt < 20 && client.runtime.agentSessionId !== "cool-5"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.runtime.agentSessionId, "cool-5");
  assert.equal(client.runtime.rolloverLatched, false);
  assert.equal(client.runtime.rolloverFailures, 0);
  await client.endSession();
});

test("rollover schedule uses max(created_at, expiry minus lead and deterministic jitter)", () => {
  const id = "019f2946-aef5-77ad-a41d-747ce0fd6a11";
  const created = Date.parse("2026-08-01T00:00:00Z");
  const expires = Date.parse("2026-08-01T01:00:00Z");
  const jitter = deterministicSessionJitterMs(id);
  assert.ok(jitter >= 0 && jitter < 60_000);
  assert.equal(sessionRolloverAtMs({ agentSessionId: id, createdAt: new Date(created).toISOString(), expiresAt: new Date(expires).toISOString() }), expires - 5 * 60_000 - jitter);
  assert.equal(sessionRolloverAtMs({ agentSessionId: id, createdAt: new Date(expires).toISOString(), expiresAt: new Date(expires).toISOString() }), expires);
});

test("rollover scheduling uses the injectable timer and unreferences it", async () => {
  const scheduled = [];
  let unrefCalls = 0;
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    now: () => new Date("2026-08-01T00:10:00Z"),
    setTimer: (callback, delayMs) => {
      const handle = { callback, delayMs, unref() { unrefCalls += 1; } };
      scheduled.push(handle);
      return handle;
    },
    clearTimer: () => {},
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session("scheduled"), 201);
      if (path.endsWith("/participants")) return json({ participant_id: "p" }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  const expectedAt = sessionRolloverAtMs(client.runtime);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, expectedAt - Date.parse("2026-08-01T00:10:00Z"));
  assert.equal(unrefCalls, 1);
  await client.endSession();
});

test("a responsive read can rebootstrap its own expired anonymous session without self-blocking", async () => {
  let creates = 0;
  let drains = 0;
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: "" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`read-rebootstrap-${++creates}`), 201);
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) {
        drains += 1;
        if (drains === 1) return json({ error: { code: "agent_session_expired", message: "expired", action: "rebootstrap", retryable: false, scope: "agent_session" } }, 401);
        return json({ delivery: { cursor_scope: "session" }, messages: [{ seq: 1, event_id: "successor-row" }] });
      }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  const delivery = await client.drainResponsiveDelivery();
  assert.equal(creates, 2);
  assert.equal(client.runtime.agentSessionId, "read-rebootstrap-2");
  assert.equal(delivery.messages[0].event_id, "successor-row");
  await client.endSession();
});

test("anonymous planned replacement preserves only the adapter projection cursor", async () => {
  let creates = 0;
  let participantEntries = 0;
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session(`anon-${++creates}`), 201);
      if (path.endsWith("/participants")) { participantEntries += 1; return json({ participant_id: `p-${creates}` }, 201); }
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/projection")) return json({ watermark: 11, messages: [] });
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session", last_acked_seq: 0 }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  client.roomRuntime(client.cfg.roomId.value).cursor = 23;
  await client.performProactiveRollover();
  assert.equal(client.runtime.rooms[0].cursor, 23);
  assert.equal(client.runtime.responsiveCursorScope, "session");
  assert.equal(client.runtime.responsiveContinuity, "exact_session_not_transferred");
  assert.equal(client.runtime.sessionGeneration, 0);
  assert.equal(participantEntries, 2, "each prepared session enters exactly once");
  await client.endSession();
});

test("claim recovery is transport agnostic: a plain 409 error stays terminal", async () => {
  // Adapters construct their own error shapes. A conflict must stay terminal
  // for the candidate regardless, or a host would treat it as a lost response
  // and refuse to retire the losing candidate.
  const { claimAliasWithRecovery } = await import("../dist/index.js");
  const plain409 = Object.assign(new Error("Parle API 409: taken"), { status: 409 });
  const transport = { request: async () => { throw plain409; } };
  await assert.rejects(
    claimAliasWithRecovery(transport, { agentSessionId: "as-1", sessionHandle: "parle_ses_1" }, "main", 3),
    (error) => error === plain409,
  );

  // A lost response still resolves against the durable fence rather than
  // replaying the claim blindly.
  let claims = 0;
  const recovering = {
    request: async (path) => {
      if (path.endsWith("/claim-alias")) { claims += 1; throw Object.assign(new Error("Parle API 503: gateway"), { status: 503 }); }
      if (path.startsWith("/v/agent/session-aliases/")) return { alias: "main", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: 4, current_agent_session_id: "as-1" };
      return { sessions: [{ agent_session_id: "as-1", alias: "main", generation: 4 }], next: null };
    },
  };
  const committed = await claimAliasWithRecovery(recovering, { agentSessionId: "as-1", sessionHandle: "parle_ses_1" }, "main", 3);
  assert.equal(committed.alias, "main");
  assert.equal(claims, 1, "a committed claim is confirmed, never replayed");
});

test("live rollover drains exact predecessor work with its original credential", async () => {
  let sessions = 0;
  let generation = 0;
  const acks = [];
  const queues = new Map([["parle_ses_live-1", [{ seq: 1, event_id: "predecessor-work" }]], ["parle_ses_live-2", [{ seq: 2, event_id: "successor-session-work" }]]]);
  const client = new ParleAgentClient({
    env: ENV,
    now: () => new Date("2026-08-01T00:10:00.000Z"),
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const credential = init.headers?.["Parle-Agent-Session"];
      if (path === "/v/agent/sessions") return json(session(`live-${++sessions}`), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation, current_agent_session_id: sessions ? `live-${sessions}` : null });
      if (path.endsWith("/claim-alias")) return json({ ...session(`live-${sessions}`), alias: "main", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: ++generation, address: "@p.a.main" });
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.endsWith("/projection")) return json({ messages: [] });
      if (path === "/v/agent/wake") return new Response(new ReadableStream({ start() {} }), { status: 200 });
      if (path.endsWith("/responsive-delivery/ack")) {
        const body = JSON.parse(init.body);
        acks.push([credential, body.event_id, body.cursor_scope]);
        queues.set(credential, (queues.get(credential) || []).filter((row) => row.event_id !== body.event_id));
        return json({ acked: true });
      }
      if (path.endsWith("/responsive-delivery")) {
        const scope = new URL(String(url)).searchParams.get("cursor_scope");
        const messages = scope === "alias" ? [{ seq: 3, event_id: "successor-alias-work" }] : queues.get(credential) || [];
        return json({ delivery: { cursor_scope: scope, ...(scope === "alias" ? { alias_context: { alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", alias_generation: generation } } : {}) }, messages });
      }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  const handled = [];
  const controller = new ResponsiveDeliveryController(client, { handler: ({ message }) => { handled.push(message.event_id); return "handled"; } });
  try {
    await client.connect();
    await client.switchSessionAlias("main");
    await client.performProactiveRollover();
    await controller.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(handled.sort(), ["predecessor-work", "successor-alias-work", "successor-session-work"].sort());
    assert.notEqual(client.status().runtime.rooms[0].lastAckEventId, "predecessor-work", "predecessor ACK cannot overwrite current-room presentation");
    assert.ok(acks.some(([credential, eventId, scope]) => credential === "parle_ses_live-1" && eventId === "predecessor-work" && scope === "session"));
    assert.ok(acks.some(([credential, eventId, scope]) => credential === "parle_ses_live-2" && eventId === "successor-alias-work" && scope === "alias"));
    const status = JSON.stringify(client.status());
    assert.match(status, /live-1/);
    assert.doesNotMatch(status, /parle_ses_live-1/);
  } finally {
    await controller.stop();
    await client.endSession();
  }
});

test("expired predecessor is removed without successor ack or reclaim", async () => {
  let now = Date.parse("2026-08-01T00:00:00Z");
  let sessions = 0;
  const ackCredentials = [];
  const client = new ParleAgentClient({
    env: { ...ENV, PARLE_SESSION_ALIAS: undefined },
    now: () => new Date(now),
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json({ ...session(`expiry-${++sessions}`), expires_at: new Date(now + 1_000).toISOString() }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.endsWith("/projection")) return json({ messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "session" }, messages: [{ seq: 1, event_id: "expires-mid-drain" }] });
      if (path.endsWith("/responsive-delivery/ack")) { ackCredentials.push(init.headers?.["Parle-Agent-Session"]); return json({ acked: true }); }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await client.performProactiveRollover();
    const predecessor = client.status().runtime.predecessorDrainingIds[0];
    await assert.rejects(client.drainResponsiveDeliveryWithFence(undefined, "room-1", "session", "never-retained"), { code: "predecessor_delivery_unavailable" });
    const read = await client.drainResponsiveDeliveryWithFence(undefined, "room-1", "session", predecessor);
    now += 2_000;
    await assert.rejects(() => client.ackResponsiveDelivery(read.delivery.messages[0], undefined, "room-1", read.fence), { code: "responsive_delivery_session_changed" });
    read.release();
    await assert.rejects(client.drainResponsiveDeliveryWithFence(undefined, "room-1", "session", predecessor), { code: "predecessor_delivery_unavailable" });
    assert.deepEqual(ackCredentials, []);
    assert.equal(client.status().runtime.predecessorDrainingCount, undefined);
    assert.equal(sessions, 2, "expiry removes only the source and never reclaims");
  } finally { await client.endSession(); }
});

test("rollover capacity refuses before a third alias claim", async () => {
  let sessions = 0;
  let generation = 0;
  let claims = 0;
  const client = new ParleAgentClient({
    env: ENV,
    now: () => new Date("2026-08-01T00:10:00.000Z"),
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json(session(`cap-${++sessions}`), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation, current_agent_session_id: sessions ? `cap-${sessions}` : null });
      if (path.endsWith("/claim-alias")) {
        claims += 1;
        return json({ ...session(`cap-${sessions}`), alias: "main", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: ++generation, address: "@p.a.main" });
      }
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.endsWith("/projection")) return json({ messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: new URL(String(url)).searchParams.get("cursor_scope") }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await client.switchSessionAlias("main");
    await client.performProactiveRollover();
    await client.performProactiveRollover();
    await assert.rejects(client.performProactiveRollover(), { code: "predecessor_drain_capacity" });
    assert.equal(claims, 3, "the capped rollover sends neither a candidate request nor an alias claim");
    assert.equal(sessions, 3);
    assert.equal(client.status().runtime.predecessorDrainingCount, 2);
  } finally { await client.endSession(); }
});
