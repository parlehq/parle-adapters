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

test("alias bootstrap prepares wake, walks inventory, and claims the discovered generation", async () => {
  const order = [];
  const claims = [];
  let inventoryPage = 0;
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
      if (path === "/v/agent/sessions") {
        inventoryPage += 1;
        order.push(`inventory-${inventoryPage}`);
        if (inventoryPage === 1) return json({ sessions: [{ alias: null, generation: 0 }], next: "page-2" });
        assert.equal(parsed.searchParams.get("after"), "page-2");
        return json({ sessions: [{ alias: "main", generation: 7 }], next: null });
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
  assert.deepEqual(order.slice(0, 6), ["create", "enter", "wake", "inventory-1", "inventory-2", "claim"]);
  assert.deepEqual(claims, [{ alias: "main", expected_generation: 7 }]);
  assert.equal(client.runtime.sessionGeneration, 8);
  assert.equal(client.runtime.sessionAddress, "@p.a.main");
  await client.endSession();
});

test("proactive alias replacement is single-flight and advances from inventory generation", async () => {
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
      if (path === "/v/agent/sessions") return json({ sessions: claimGeneration ? [{ alias: "main", generation: claimGeneration }] : [], next: null });
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
      if (path === "/v/agent/sessions") return json({ sessions: [{ alias: "main", generation }], next: null });
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

test("lost alias claim response recovers by exact replay without retiring the committed candidate", async () => {
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
      if (path === "/v/agent/sessions") {
        inventoryReads += 1;
        const sessions = committed && inventoryReads > 2 ? [{ ...committed }] : [{ alias: "main", generation: 4, agent_session_id: "prior" }];
        return json({ sessions, next: null });
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
        assert.equal(candidateId, committed.agent_session_id, "recovery replays the exact original candidate request");
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
  assert.equal(claims, 2);
  assert.deepEqual(ended, [], "an ambiguously committed candidate is never retired during recovery");
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
      if (path === "/v/agent/sessions") return json({ sessions: [], next: null });
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
