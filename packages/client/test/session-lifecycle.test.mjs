import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VERSION,
  ParleAgentClient,
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
  assert.equal(seen[0][3], "2026-08-01");
  assert.equal(DEFAULT_VERSION, "2026-08-01");
  await client.endSession().catch(() => undefined);
});

test("alias bootstrap prepares wake, reads the durable fence, and claims the discovered generation", async () => {
  const order = [];
  const claims = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      const { pathname: path } = parsed;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
        order.push("create");
        assert.deepEqual(JSON.parse(init.body), {});
        return json(session("candidate"), 201);
      }
      if (path.endsWith("/participants")) { order.push("enter"); return json({ participant_id: "part-candidate" }, 201); }
      if (path === "/v/agent/wake") { order.push("wake"); return new Response(": ready\n\n", { status: 200 }); }
      if (path === "/v/agent/session-aliases/main") {
        order.push("alias-lookup");
        return json({ alias: "main", generation: 7, current_agent_session_id: "prior" });
      }
      if (path.endsWith("/claim-alias")) {
        order.push("claim");
        claims.push(JSON.parse(init.body));
        return json({ ...session("candidate", 8), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/projection")) return json({ watermark: 9, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  assert.deepEqual(order.slice(0, 5), ["create", "enter", "wake", "alias-lookup", "claim"]);
  assert.deepEqual(claims, [{ alias: "main", expected_generation: 7 }]);
  assert.equal(client.runtime.sessionGeneration, 8);
  assert.equal(client.runtime.sessionAddress, "@p.a.main");
  await client.endSession();
});

test("alias bootstrap recovers the generation after the prior owner disappears from live inventory", async () => {
  let inventoryReads = 0;
  let claimedGeneration;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session("after-expiry"), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation: 9, current_agent_session_id: "expired-owner" });
      if (path === "/v/agent/sessions") { inventoryReads += 1; return json({ sessions: [], next: null }); }
      if (path.endsWith("/participants")) return json({ participant_id: "part-after-expiry" }, 201);
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        claimedGeneration = JSON.parse(init.body).expected_generation;
        return json({ ...session("after-expiry", 10), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  assert.equal(claimedGeneration, 9);
  assert.equal(inventoryReads, 0, "generation recovery does not depend on a live prior owner");
  assert.equal(client.runtime.sessionGeneration, 10);
  await client.endSession();
});

test("proactive alias replacement is single-flight and advances from the durable alias generation", async () => {
  let creates = 0;
  let claimGeneration = 2;
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const revisions = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
        creates += 1;
        if (creates === 2) await createGate;
        return json(session(`candidate-${creates}`), 201);
      }
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation: claimGeneration, current_agent_session_id: claimGeneration ? `candidate-${Math.max(1, creates - 1)}` : null });
      if (path.endsWith("/participants")) return json({ participant_id: `part-${creates}` }, 201);
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        const body = JSON.parse(init.body);
        assert.equal(body.expected_generation, claimGeneration);
        claimGeneration += 1;
        return json({ ...session(`candidate-${creates}`, claimGeneration), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/projection")) return json({ watermark: 1, messages: [] });
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias", last_acked_seq: 0 }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  client.onSessionRevision((event) => revisions.push(event));
  await client.connect();
  const first = client.performProactiveRollover();
  const second = client.performProactiveRollover();
  releaseCreate();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(creates, 2);
  assert.equal(a.agentSessionId, b.agentSessionId);
  assert.equal(client.runtime.sessionGeneration, 4);
  assert.equal(client.runtime.responsiveCursorScope, "alias");
  assert.deepEqual(revisions.map((event) => event.reason), ["bootstrap", "rollover"]);
  await client.endSession();
});

test("a stale claim conflict is terminal for that candidate and recovery uses a fresh cycle", async () => {
  let creates = 0;
  let claims = 0;
  let generation = 1;
  const claimedCandidates = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`c-${++creates}`), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation, current_agent_session_id: generation ? "prior" : null });
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        claims += 1;
        claimedCandidates.push(path.split("/").at(-2));
        if (claims === 2) {
          generation = 3;
          return json({ error: { code: "agent_session_alias_conflict", message: "stale", retryable: false } }, 409);
        }
        generation += 1;
        return json({ ...session(`c-${creates}`, generation), alias: "main", address: "@p.a.main" });
      }
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  const oldId = client.runtime.agentSessionId;
  await assert.rejects(client.performProactiveRollover(), (error) => error.status === 409);
  assert.equal(client.runtime.agentSessionId, oldId, "failed pre-claim preparation leaves old current");
  await client.performProactiveRollover();
  assert.equal(claims, 3, "the failed exact claim was not replayed");
  assert.notEqual(claimedCandidates[1], claimedCandidates[2]);
  assert.equal(client.runtime.sessionGeneration, 4);
  await client.endSession();
});

test("lost alias claim response recovers by durable alias confirmation without retiring the committed candidate", async () => {
  let creates = 0;
  let claims = 0;
  let inventoryReads = 0;
  let committed;
  const ended = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const credential = init.headers?.["Parle-Agent-Session"];
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`lost-${++creates}`), 201);
      if (path === "/v/agent/session-aliases/main") {
        return json(committed
          ? { alias: "main", generation: 5, current_agent_session_id: committed.agent_session_id }
          : { alias: "main", generation: 4, current_agent_session_id: "prior" });
      }
      if (path === "/v/agent/sessions") {
        inventoryReads += 1;
        return json({ sessions: committed ? [{ ...committed }] : [], next: null });
      }
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response("event: wake\ndata: {}\n\n");
      if (path.endsWith("/claim-alias")) {
        claims += 1;
        const candidateId = path.split("/").at(-2);
        const body = JSON.parse(init.body);
        if (claims === 1) {
          committed = { ...session(candidateId, body.expected_generation + 1), alias: body.alias, address: "@p.a.main" };
          throw new TypeError("response dropped after commit");
        }
        assert.equal(candidateId, committed.agent_session_id, "any replay remains bound to the original candidate");
        assert.deepEqual(body, { alias: "main", expected_generation: 4 });
        return json(committed);
      }
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) { ended.push([path.split("/").at(-2), credential]); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  assert.equal(client.runtime.agentSessionId, "lost-1");
  assert.equal(client.runtime.sessionGeneration, 5);
  assert.equal(claims, 1, "durable alias plus live inventory confirmation avoids an unnecessary replay");
  assert.deepEqual(ended, [], "an ambiguously committed candidate is never retired during recovery");
  await client.endSession();
});

test("durable proof reports a committed claim whose candidate disappeared from live inventory", async () => {
  let creates = 0;
  let claims = 0;
  let committedId;
  const ended = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session(`vanished-${++creates}`), 201);
      if (path === "/v/agent/session-aliases/main") return json(committedId
        ? { alias: "main", generation: 5, current_agent_session_id: committedId }
        : { alias: "main", generation: 4, current_agent_session_id: "prior" });
      if (path === "/v/agent/sessions") return json({ sessions: [], next: null });
      if (path.endsWith("/participants")) return json({ participant_id: `p-${creates}` }, 201);
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n");
      if (path.endsWith("/claim-alias")) {
        claims += 1;
        const candidateId = path.split("/").at(-2);
        const body = JSON.parse(init.body);
        if (claims === 1) {
          committedId = candidateId;
          throw new TypeError("response dropped after commit and candidate expiry");
        }
        return json({ ...session(candidateId, body.expected_generation + 1), alias: body.alias, address: "@p.a.main" });
      }
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) { ended.push(path.split("/").at(-2)); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    },
  });
  await assert.rejects(client.connect(), (error) => error?.code === "alias_claim_committed_session_unavailable" && error?.action === "rebootstrap");
  assert.equal(claims, 1, "durable proof stops exact replay once the committed candidate is known unavailable");
  assert.deepEqual(ended, ["vanished-1"]);
  await client.connect();
  assert.equal(client.runtime.agentSessionId, "vanished-2");
  assert.equal(client.runtime.sessionGeneration, 6);
  await client.endSession();
});

test("candidate wake is prefetched across claim, consumed once, and room entry reconciles after claim", async () => {
  const order = [];
  let wakeOpens = 0;
  const prefetched = new Response("event: wake\ndata: {\"near\":\"commit\"}\n\n");
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json(session("prefetched"), 201);
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation: 0, current_agent_session_id: null });
      if (path.endsWith("/participants")) { order.push("enter"); return json({ participant_id: "p" }, 201); }
      if (path.endsWith("/projection")) return json({ watermark: 0, messages: [] });
      if (path === "/v/agent/wake") { wakeOpens += 1; return wakeOpens === 1 ? prefetched : new Response(": replacement\n\n"); }
      if (path.endsWith("/claim-alias")) { order.push("claim"); return json({ ...session("prefetched", 1), alias: "main", address: "@p.a.main" }); }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  assert.deepEqual(order, ["enter", "claim", "enter"], "post-claim room entry is intentionally idempotent");
  const handedOff = await client.openWakeStream();
  assert.equal(handedOff, prefetched, "the watcher receives the stream opened before claim");
  const replacement = await client.openWakeStream();
  assert.notEqual(replacement, prefetched);
  assert.equal(wakeOpens, 2, "the prefetched response is consumed exactly once");
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
  assert.deepEqual(ended, ["life-1", "life-2"], "rollover retires the predecessor and end retires the joined successor");
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

test("a responsive fence adopts the authoritative response cursor scope", async () => {
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
      if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  await client.connect();
  client.runtime.responsiveCursorScope = undefined;
  const read = await client.drainResponsiveDeliveryWithFence();
  try {
    assert.equal(read.fence.cursorScope, "alias");
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
  client.runtime.cursor = 23;
  await client.performProactiveRollover();
  assert.equal(client.runtime.cursor, 23);
  assert.equal(client.runtime.responsiveCursorScope, "session");
  assert.equal(client.runtime.responsiveContinuity, "exact_session_not_transferred");
  assert.equal(client.runtime.sessionGeneration, 0);
  assert.equal(participantEntries, 2, "each prepared session enters exactly once");
  await client.endSession();
});
