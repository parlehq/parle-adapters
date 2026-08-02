import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParleAgentClient, ResponsiveDeliveryController } from "../dist/index.js";

const ALPHA = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const BETA = "019f7b46-178f-7a5a-9f7b-b4af2e045261";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A held stream the test can push wake frames into, mirroring the real
// server: the stream stays open and frames arrive after start() returns.
function heldWakeStream(sink) {
  return new Response(new ReadableStream({
    start(controller) {
      sink.push = (event) => controller.enqueue(new TextEncoder().encode(`event: wake\ndata: ${JSON.stringify(event)}\n\n`));
    },
  }), { status: 200 });
}

async function eventually(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true in time");
}

// Two configured rooms, each with its own queue of responsive rows. Rows are
// only removed from a queue by an acknowledgement, which is what makes the
// no-ack-on-failure and redelivery assertions meaningful.
function harness({ rooms = { [ALPHA]: [], [BETA]: [] }, profiles = "alpha,beta" } = {}) {
  const wakeSink = { push: () => {} };
  const home = mkdtempSync(join(tmpdir(), "parle-delivery-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-delivery-project-"));
  mkdirSync(join(home, ".parle"), { mode: 0o700 });
  writeFileSync(join(home, ".parle", "profiles"), `[alpha]\nroom_id = ${ALPHA}\nagent_token = parle_agt_alpha\n\n[beta]\nroom_id = ${BETA}\nagent_token = parle_agt_beta\n`, { mode: 0o600 });
  const queues = new Map(Object.entries(rooms).map(([roomId, messages]) => [roomId, [...messages]]));
  const acks = [];
  const calls = [];
  let wakeOpens = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const auth = init.headers?.Authorization;
    calls.push([path, auth]);
    if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
      return json({ agent_session_id: "as-shared", session_credential: "parle_ses_shared", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: "@p.a.shared" }, 201);
    }
    if (path.endsWith("/participants")) return json({ participant_id: "p-1", room_handle: path.includes(ALPHA) ? "alpha-room" : "beta-room" }, 201);
    if (path.includes("/projection")) return json({ watermark: 0, messages: [] });
    if (path === "/v/agent/wake") {
      wakeOpens += 1;
      return heldWakeStream(wakeSink);
    }
    if (path.endsWith("/responsive-delivery/ack")) {
      const roomId = path.split("/")[3];
      const body = JSON.parse(init.body);
      acks.push([roomId, body.event_id, auth]);
      const queue = queues.get(roomId) || [];
      queues.set(roomId, queue.filter((row) => row.event_id !== body.event_id));
      return json({ acked: true });
    }
    if (path.includes("/responsive-delivery")) {
      const roomId = path.split("/")[3];
      return json({ delivery: { cursor_scope: "session" }, messages: queues.get(roomId) || [] });
    }
    if (path.endsWith("/end")) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${path}`);
  };
  const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILES: profiles }, fetch });
  return {
    client,
    acks,
    calls,
    queues,
    wake: (event) => wakeSink.push(event),
    wakeOpens: () => wakeOpens,
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("a wake hint drains only the named room and acknowledges after handling", async () => {
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "a1" }], [BETA]: [{ seq: 1, event_id: "b1" }] } });
  const handled = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async ({ roomId, roomHandle, profile, message }) => { handled.push([roomId, roomHandle, profile, message.event_id]); return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await h.client.connect();
    // The startup drain reaches every ready room.
    await controller.start();
    assert.deepEqual(handled.map(([, , , id]) => id).sort(), ["a1", "b1"]);
    assert.deepEqual(handled.find(([room]) => room === BETA), [BETA, "beta-room", "beta", "b1"]);
    // A later hint drains only the room it names.
    h.queues.set(ALPHA, [{ seq: 2, event_id: "a2" }]);
    h.queues.set(BETA, [{ seq: 2, event_id: "b2" }]);
    h.wake({ room_id: BETA });
    await eventually(() => handled.some(([, , , id]) => id === "b2"));
    assert.equal(handled.some(([, , , id]) => id === "a2"), false, "an unhinted room is not drained");
    // Each ack authenticates with its own room's bearer.
    assert.deepEqual(h.acks.find(([room]) => room === ALPHA)?.[2], "Bearer parle_agt_alpha");
    assert.deepEqual(h.acks.find(([room]) => room === BETA)?.[2], "Bearer parle_agt_beta");
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("an intentional skip acknowledges and a handler failure does not", async () => {
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "skip-me" }], [BETA]: [{ seq: 1, event_id: "boom" }] } });
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async ({ message }) => {
      if (message.event_id === "boom") throw new Error("handler exploded");
      return "intentionally_skipped";
    },
    maxHandlerAttempts: 2,
    reconnectDelayMs: 5,
  });
  try {
    await h.client.connect();
    await controller.start();
    // A failed row is retried within its budget, then classified as an
    // intentional skip and acknowledged once so the room cannot wedge.
    assert.deepEqual(h.acks.map(([, id]) => id).sort(), ["boom", "skip-me"]);
    assert.deepEqual(h.queues.get(BETA), [], "the poisoned row leaves the queue");
    const status = controller.status();
    assert.equal(status.rooms.find((room) => room.roomId === ALPHA).skipped, 1);
    const beta = status.rooms.find((room) => room.roomId === BETA);
    assert.equal(beta.poisoned, 1, "bounded retries then an explicit skip, never a wedged queue");
    assert.equal(beta.skipped, 1);
    assert.match(beta.lastError, /handler exploded/);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("an unknown wake room is recorded and never fetched", async () => {
  const unknown = "019f0000-0000-7000-8000-000000000000";
  const h = harness();
  const controller = new ResponsiveDeliveryController(h.client, { handler: async () => "handled", reconnectDelayMs: 5 });
  try {
    await h.client.connect();
    await controller.start();
    h.wake({ room_id: unknown });
    await eventually(() => controller.status().ignoredWakeHints === 1);
    const status = controller.status();
    assert.equal(status.lastIgnoredWakeRoomId, unknown);
    assert.equal(h.calls.some(([path]) => path.includes(unknown)), false, "an untrusted hint never widens the room set");
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("deduplication by room and event survives redelivery of the same row", async () => {
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "dup" }] } });
  let deliveries = 0;
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async () => { deliveries += 1; return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await h.client.connect();
    await controller.start();
    // Server-side ack state restarts for a new participant, so the same row can
    // legitimately arrive again. One effective action is the contract.
    h.queues.set(ALPHA, [{ seq: 1, event_id: "dup" }]);
    await controller.status();
    await h.client.drainResponsiveDelivery(undefined, ALPHA);
    assert.equal(deliveries, 1);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a room entered without projection initialization is recovered, not stranded", async () => {
  // Entry succeeds and projection fails, so the room holds a real participant
  // binding while its cursor was never initialized. The server still delivers
  // and wakes on it, so it must be reinitialized rather than skipped.
  let projectionFailures = 1;
  const h = harness({ rooms: { [ALPHA]: [], [BETA]: [{ seq: 1, event_id: "b1" }] } });
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes(BETA) && path.includes("/projection") && projectionFailures > 0) {
        projectionFailures -= 1;
        return json({ error: { code: "unavailable", message: "projection unavailable", action: "retry_with_backoff", scope: "request", retryable: true } }, 503);
      }
      return baseFetch(url, init);
    },
  });
  const handled = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ roomId, message }) => { handled.push([roomId, message.event_id]); return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await client.connect();
    const degraded = client.runtime.rooms.find((room) => room.roomId === BETA);
    assert.equal(degraded.state, "degraded", "projection failure degrades the room");
    assert.ok(degraded.participantId, "but the participant binding is real");
    await controller.start();
    assert.deepEqual(handled, [[BETA, "b1"]], "the recovered room drains its backlog");
    assert.equal(client.runtime.rooms.find((room) => room.roomId === BETA).state, "ready");
    // A hint for a degraded-but-entered room is never counted as unknown.
    assert.equal(controller.status().ignoredWakeHints, 0);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a replacement session supersedes a prior alias owner without replay or wedge", async () => {
  // Own-session continuity (issue #49): the configured alias already has a
  // prior owner, the replacement claims it from the authoritative generation,
  // and alias-scoped delivery continues across the generation boundary with
  // one effective action per row.
  const home = mkdtempSync(join(tmpdir(), "parle-alias-continuity-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-alias-continuity-project-"));
  mkdirSync(join(home, ".parle"), { mode: 0o700 });
  writeFileSync(join(home, ".parle", "profiles"), `[alpha]\nroom_id = ${ALPHA}\nagent_token = parle_agt_alpha\n`, { mode: 0o600 });
  let generation = 4;
  let sessions = 0;
  const claims = [];
  let queue = [{ seq: 7, event_id: "carried" }];
  const acks = [];
  const client = new ParleAgentClient({
    cwd,
    env: { HOME: home, PARLE_PROFILE: "alpha", PARLE_SESSION_ALIAS: "main" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
        sessions += 1;
        return json({ agent_session_id: `as-${sessions}`, session_credential: `parle_ses_${sessions}`, created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: `@p.a.handle-${sessions}` }, 201);
      }
      if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation, current_agent_session_id: sessions > 1 ? `as-${sessions - 1}` : "prior-owner" });
      if (path.endsWith("/claim-alias")) {
        claims.push({ session: path.split("/")[4], expected: JSON.parse(init.body).expected_generation });
        generation += 1;
        return json({ agent_session_id: `as-${sessions}`, alias: "main", generation, address: "@p.a.main", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (path.endsWith("/participants")) return json({ participant_id: `p-${sessions}`, room_handle: "alpha-room" }, 201);
      if (path === "/v/agent/wake") return new Response(new ReadableStream({ start() {} }), { status: 200 });
      if (path.includes("/projection")) return json({ watermark: 6, messages: [] });
      if (path.endsWith("/responsive-delivery/ack")) {
        const body = JSON.parse(init.body);
        acks.push(body.event_id);
        queue = queue.filter((row) => row.event_id !== body.event_id);
        return json({ acked: true });
      }
      if (path.includes("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: queue });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  const handled = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ message }) => { handled.push(message.event_id); return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await client.connect();
    assert.deepEqual(claims, [{ session: "as-1", expected: 4 }], "the replacement claims from the authoritative generation");
    assert.equal(client.runtime.sessionAlias, "main");
    await controller.start();
    assert.deepEqual(handled, ["carried"]);
    assert.equal(client.runtime.responsiveCursorScope, "alias", "alias-scoped continuity is preserved");
    // Roll the session: the same alias is reclaimed and the server may replay
    // the row to the new participant. It must not be handled twice.
    queue = [{ seq: 7, event_id: "carried" }];
    await client.performProactiveRollover();
    assert.equal(claims.length, 2);
    assert.equal(claims[1].expected, 5, "the replacement fences on the advanced generation");
    await client.drainResponsiveDelivery(undefined, ALPHA);
    assert.deepEqual(handled, ["carried"], "one effective action across the generation boundary");
    assert.equal(client.runtime.sessionAlias, "main", "the route survives replacement");
  } finally {
    await controller.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an acknowledgement failure retries the ack without re-running the handler", async () => {
  // The host has already acted on a handled row, so replaying the handler
  // would duplicate a visible side effect (Pi would inject twice).
  let ackFailures = 1;
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "once" }] } });
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/responsive-delivery/ack") && ackFailures > 0) {
        ackFailures -= 1;
        return json({ error: { code: "unavailable", message: "ack unavailable", action: "retry_with_backoff", scope: "request", retryable: true } }, 503);
      }
      return baseFetch(url, init);
    },
  });
  const handled = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ message }) => { handled.push(message.event_id); return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await client.connect();
    await controller.start();
    assert.deepEqual(handled, ["once"], "handler ran once despite the failed ack");
    assert.equal(h.acks.length, 0, "nothing was acknowledged yet");
    // A later drain retries only the acknowledgement.
    await controller.drainForTest(ALPHA);
    assert.deepEqual(handled, ["once"], "the handler is never re-run");
    assert.deepEqual(h.acks.map(([, id]) => id), ["once"]);
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).delivered, 1);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a session revision queues a drain instead of joining an in-flight one", async () => {
  const h = harness({ rooms: { [ALPHA]: [] } });
  let gate;
  let gateOpen;
  let drains = 0;
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes(ALPHA) && path.includes("/responsive-delivery") && !path.endsWith("/ack")) {
        drains += 1;
        if (gate) await gate;
      }
      return baseFetch(url, init);
    },
  });
  const handled = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ message }) => { handled.push(message.event_id); return "handled"; },
    reconnectDelayMs: 5,
  });
  try {
    await client.connect();
    await controller.start();
    const drainsBefore = drains;
    // Hold one drain open. It has already read an empty queue when the
    // replacement lands, so joining it would lose the post-replacement pass
    // a session revision promises.
    gate = new Promise((resolve) => { gateOpen = resolve; });
    const inFlight = controller.drainForTest(ALPHA);
    await eventually(() => drains > drainsBefore);
    h.queues.set(ALPHA, [{ seq: 9, event_id: "after-replacement" }]);
    const requestedDuringDrain = controller.drainForTest(ALPHA);
    gate = undefined;
    gateOpen();
    await Promise.all([inFlight, requestedDuringDrain]);
    await eventually(() => handled.includes("after-replacement"));
    assert.ok(drains >= drainsBefore + 2, "the queued rerun issued its own drain");
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a deferred row is not acknowledged until the host reports effective handling", async () => {
  // Pi queues a row and injects it only when the assistant is idle, so a
  // crash between drain and injection must leave the row redeliverable.
  const h = harness({ rooms: { [ALPHA]: [{ seq: 3, event_id: "queued" }] } });
  const queued = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async ({ roomId, message }) => { queued.push({ roomId, message }); return "deferred"; },
    reconnectDelayMs: 5,
  });
  try {
    await h.client.connect();
    await controller.start();
    assert.equal(queued.length, 1);
    assert.deepEqual(h.acks, [], "a deferred row is never acknowledged by the drain");
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).deferred, 1);
    // A later drain must not re-offer the row to the handler.
    await controller.drainForTest(ALPHA);
    assert.equal(queued.length, 1, "a deferred row is never re-handled");
    // The host reports injection; only now is it acknowledged.
    assert.equal(await controller.completeDeferred(ALPHA, queued[0].message), true);
    assert.deepEqual(h.acks.map(([, id]) => id), ["queued"]);
    const status = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.equal(status.delivered, 1);
    assert.equal(status.deferred, 0);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a pending deferred row does not spin the drain", async () => {
  // A row awaiting host completion is re-offered by the server on every drain.
  // Counting it as progress would run the room to its batch cap each time.
  const h = harness({ rooms: { [ALPHA]: [{ seq: 5, event_id: "waiting" }] } });
  let drains = 0;
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes(ALPHA) && path.includes("/responsive-delivery") && !path.endsWith("/ack")) drains += 1;
      return baseFetch(url, init);
    },
  });
  let handled = 0;
  const controller = new ResponsiveDeliveryController(client, {
    handler: async () => { handled += 1; return "deferred"; },
    maxDrainBatches: 25,
    reconnectDelayMs: 5,
  });
  try {
    await client.connect();
    await controller.start();
    assert.equal(handled, 1);
    // Two calls: the batch that deferred the row, then the one that finds only
    // the pending row and stops.
    assert.ok(drains <= 3, `drain terminated promptly (${drains} calls)`);
    const before = drains;
    await controller.drainForTest(ALPHA);
    assert.equal(handled, 1, "the pending row is never re-handled");
    assert.ok(drains - before <= 2, "a later drain also terminates");
  } finally {
    await controller.stop();
    h.cleanup();
  }
});
