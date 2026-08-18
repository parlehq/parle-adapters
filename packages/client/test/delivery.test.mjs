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
function heldWakeStream(sink, config) {
  return new Response(new ReadableStream({
    start(controller) {
      const send = (event, data) => controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      sink.push = (event) => send("wake", event);
      sink.config = (value) => send("config", value);
      sink.close = () => controller.close();
      sink.error = (error = new Error("wake stream failed")) => controller.error(error);
      if (config) send("config", config);
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

function controlledSleeper() {
  const calls = [];
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const entry = { ms, settled: false, release: () => {} };
    const onAbort = () => {
      if (entry.settled) return;
      entry.settled = true;
      reject(new Error("aborted"));
    };
    entry.release = () => {
      if (entry.settled) return;
      entry.settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    calls.push(entry);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const release = (predicate) => {
    const entry = calls.find((candidate) => !candidate.settled && predicate(candidate.ms));
    assert.ok(entry, `no pending sleep matched; saw ${JSON.stringify(calls.map(({ ms, settled }) => ({ ms, settled })))}`);
    entry.release();
  };
  return { calls, sleep, release };
}

// Two configured rooms, each with its own queue of responsive rows. Rows are
// only removed from a queue by an acknowledgement, which is what makes the
// no-ack-on-failure and redelivery assertions meaningful.
function harness({ rooms = { [ALPHA]: [], [BETA]: [] }, profiles = "alpha,beta", failFirstWakes = 0, retryFirstWakes = 0, emptyFirstWakes = 0, wakeConfig, onWakeOpen } = {}) {
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
      onWakeOpen?.({ wakeOpens, queues });
      if (wakeOpens <= failFirstWakes) {
        return json({ error: { message: "wake refused terminally", action: "fix_client", scope: "request" } }, 401);
      }
      if (wakeOpens <= failFirstWakes + retryFirstWakes) {
        return json({ error: { message: "wake temporarily unavailable", action: "retry_with_backoff", scope: "request", retryable: true } }, 502);
      }
      if (wakeOpens <= failFirstWakes + retryFirstWakes + emptyFirstWakes) return new Response("", { status: 200 });
      return heldWakeStream(wakeSink, wakeConfig);
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
    config: (value) => wakeSink.config(value),
    closeWake: () => wakeSink.close(),
    failWake: (error) => wakeSink.error(error),
    wakeOpens: () => wakeOpens,
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("the post-open drain closes the startup drain-to-subscribe race", async () => {
  const handled = [];
  const opens = [];
  const h = harness({
    rooms: { [ALPHA]: [] },
    profiles: "alpha",
    onWakeOpen: ({ wakeOpens, queues }) => {
      if (wakeOpens === 1) queues.set(ALPHA, [{ seq: 1, event_id: "during-open" }]);
    },
  });
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async ({ message }) => { handled.push(message.event_id); return "handled"; },
    onWakeOpen: () => { opens.push([...handled]); },
  });
  try {
    await h.client.connect();
    await controller.start();
    await eventually(() => opens.length === 1);
    assert.deepEqual(handled, ["during-open"], "the live subscription precedes the correctness drain");
    assert.deepEqual(opens, [["during-open"]], "the host reports watching only after reconciliation");
    assert.deepEqual(h.acks.map(([, eventId]) => eventId), ["during-open"]);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a wake hint drains only the named room and acknowledges after handling", async () => {
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "a1" }], [BETA]: [{ seq: 1, event_id: "b1" }] } });
  const handled = [];
  let opened = false;
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async ({ roomId, roomHandle, profile, message }) => { handled.push([roomId, roomHandle, profile, message.event_id]); return "handled"; },
    reconnectDelayMs: 5,
    onWakeOpen: () => { opened = true; },
  });
  try {
    await h.client.connect();
    // The startup drain reaches every ready room.
    await controller.start();
    await eventually(() => opened);
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
    now: () => new Date("2026-08-18T20:00:00.000Z"),
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
    assert.equal(beta.lastErrorDomain, "handler", "poisoning is the terminal handler outcome");
    assert.equal(beta.lastErrorAt, "2026-08-18T20:00:00.000Z");
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a handler error clears after a later successful retry", async () => {
  const h = harness({ rooms: { [ALPHA]: [{ seq: 2, event_id: "retry-handler" }] }, profiles: "alpha" });
  let attempts = 0;
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("handler retry needed");
      return "handled";
    },
    maxHandlerAttempts: 2,
    now: () => new Date("2026-08-18T20:00:30.000Z"),
  });
  try {
    await h.client.connect();
    await controller.drainForTest(ALPHA);
    assert.equal(attempts, 2);
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).lastError, undefined);
    assert.deepEqual(h.acks.map(([, eventId]) => eventId), ["retry-handler"]);
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
  let wakeOpens = 0;
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
      if (path === "/v/agent/wake") {
        wakeOpens += 1;
        return new Response(new ReadableStream({ start() {} }), { status: 200 });
      }
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
  const opens = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ message }) => { handled.push(message.event_id); return "handled"; },
    reconnectDelayMs: 5,
    onWakeOpen: () => { opens.push(wakeOpens); },
  });
  try {
    await client.connect();
    assert.deepEqual(claims, [{ session: "as-1", expected: 4 }], "the replacement claims from the authoritative generation");
    assert.equal(client.runtime.sessionAlias, "main");
    await controller.start();
    await eventually(() => opens.length === 1);
    assert.deepEqual(handled, ["carried"]);
    assert.equal(client.runtime.responsiveCursorScope, "alias", "alias-scoped continuity is preserved");
    // Roll the session: the same alias is reclaimed, the server may replay the
    // prior row, and new durable work is reconciled only after the successor's
    // wake stream has opened.
    queue = [{ seq: 7, event_id: "carried" }, { seq: 8, event_id: "after-revision" }];
    await client.performProactiveRollover();
    assert.equal(claims.length, 2);
    assert.equal(claims[1].expected, 5, "the replacement fences on the advanced generation");
    await eventually(() => opens.length === 2 && handled.includes("after-revision"));
    assert.deepEqual(handled, ["carried", "after-revision"], "one effective action per row across the generation boundary");
    assert.equal(client.runtime.sessionAlias, "main", "the route survives replacement");
  } finally {
    await controller.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a room drain error survives unrelated success and clears on same-domain recovery", async () => {
  let drainFailures = 1;
  const h = harness({ rooms: { [ALPHA]: [], [BETA]: [] } });
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes(ALPHA) && path.includes("/responsive-delivery") && !path.endsWith("/ack") && drainFailures > 0) {
        drainFailures -= 1;
        return json({ error: { code: "internal", message: "drain unavailable", action: "retry_with_backoff", scope: "request", retryable: true } }, 500);
      }
      return baseFetch(url, init);
    },
  });
  const controller = new ResponsiveDeliveryController(client, {
    handler: async () => "handled",
    now: () => new Date("2026-08-18T20:01:00.000Z"),
  });
  try {
    await client.connect();
    await controller.drainForTest(ALPHA);
    const failed = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.match(failed.lastError, /drain unavailable/);
    assert.equal(failed.lastErrorAt, "2026-08-18T20:01:00.000Z");
    assert.equal(failed.lastErrorDomain, "drain");
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).lastErrorAt, failed.lastErrorAt, "status reads do not restamp errors");

    await controller.drainForTest(BETA);
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).lastErrorAt, failed.lastErrorAt, "another room cannot clear the fault");

    await controller.drainForTest(ALPHA);
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).lastError, undefined);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("an acknowledgement failure survives a successful drain and clears after ack without re-running the handler", async () => {
  // The host has already acted on a handled row, so replaying the handler
  // would duplicate a visible side effect (Pi would inject twice).
  let ackFailures = 1;
  const h = harness({ rooms: { [ALPHA]: [{ seq: 1, event_id: "once" }] }, profiles: "alpha" });
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
    now: () => new Date("2026-08-18T20:02:00.000Z"),
  });
  try {
    await client.connect();
    await controller.drainForTest(ALPHA);
    assert.deepEqual(handled, ["once"], "handler ran once despite the failed ack");
    assert.equal(h.acks.length, 0, "nothing was acknowledged yet");
    const failed = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.match(failed.lastError, /ack unavailable/);
    assert.equal(failed.lastErrorDomain, "ack");
    assert.equal(failed.lastErrorAt, "2026-08-18T20:02:00.000Z");

    h.queues.set(ALPHA, []);
    await controller.drainForTest(ALPHA);
    assert.match(controller.status().rooms.find((room) => room.roomId === ALPHA).lastError, /ack unavailable/, "same-room fetch success cannot mask an ack fault");

    h.queues.set(ALPHA, [{ seq: 1, event_id: "once" }]);
    await controller.drainForTest(ALPHA);
    assert.deepEqual(handled, ["once"], "the handler is never re-run");
    assert.deepEqual(h.acks.map(([, id]) => id), ["once"]);
    const recovered = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.equal(recovered.delivered, 1);
    assert.equal(recovered.lastError, undefined);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a concurrent recovery request queues a drain instead of joining an in-flight one", async () => {
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
    // next recovery request lands, so joining it would lose the requested pass.
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
  let ackFailures = 1;
  const h = harness({ rooms: { [ALPHA]: [{ seq: 3, event_id: "queued" }] } });
  const baseFetch = h.client.fetchImpl;
  const client = new ParleAgentClient({
    cwd: h.client.cwd,
    env: h.client.env,
    fetch: async (url, init = {}) => {
      if (new URL(String(url)).pathname.endsWith("/responsive-delivery/ack") && ackFailures-- > 0) {
        return json({ error: { code: "unavailable", message: "deferred ack unavailable", action: "retry_with_backoff", scope: "request", retryable: true } }, 503);
      }
      return baseFetch(url, init);
    },
  });
  const queued = [];
  const controller = new ResponsiveDeliveryController(client, {
    handler: async ({ roomId, message }) => { queued.push({ roomId, message }); return "deferred"; },
    reconnectDelayMs: 5,
    now: () => new Date("2026-08-18T20:03:00.000Z"),
  });
  try {
    await client.connect();
    await controller.start();
    assert.equal(queued.length, 1);
    assert.deepEqual(h.acks, [], "a deferred row is never acknowledged by the drain");
    assert.equal(controller.status().rooms.find((room) => room.roomId === ALPHA).deferred, 1);
    // A later drain must not re-offer the row to the handler.
    await controller.drainForTest(ALPHA);
    assert.equal(queued.length, 1, "a deferred row is never re-handled");
    // The host reports injection; a failed ack remains current until retry.
    assert.equal(await controller.completeDeferred(ALPHA, queued[0].message), false);
    const failed = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.match(failed.lastError, /deferred ack unavailable/);
    assert.equal(failed.lastErrorDomain, "ack");
    assert.equal(failed.lastErrorAt, "2026-08-18T20:03:00.000Z");
    assert.equal(await controller.completeDeferred(ALPHA, queued[0].message), true);
    assert.deepEqual(h.acks.map(([, id]) => id), ["queued"]);
    const status = controller.status().rooms.find((room) => room.roomId === ALPHA);
    assert.equal(status.delivered, 1);
    assert.equal(status.deferred, 0);
    assert.equal(status.lastError, undefined);
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

test("a terminal wake failure settles the loop and a later start resumes delivery", async () => {
  const h = harness({ rooms: { [ALPHA]: [] }, profiles: "alpha", failFirstWakes: 1 });
  let clockReads = 0;
  let observedAt;
  let controller;
  controller = new ResponsiveDeliveryController(h.client, {
    handler: () => "handled",
    reconnectDelayMs: 5,
    now: () => new Date(Date.parse("2026-08-18T20:04:00.000Z") + clockReads++ * 1000),
    onWakeError: () => { observedAt = controller.status().lastErrorAt; },
  });
  try {
    await controller.start();
    // The terminal wake error must settle the loop and report it: a controller
    // that still claims running would make every later start() a no-op and
    // leave the host with no recovery path short of a process restart.
    await eventually(() => controller.status().running === false);
    assert.match(controller.status().lastError, /wake refused terminally/);
    assert.equal(observedAt, "2026-08-18T20:04:00.000Z");
    assert.equal(controller.status().lastErrorAt, observedAt, "terminal propagation does not restamp one failure");
    assert.equal(clockReads, 1);

    h.queues.set(ALPHA, [{ seq: 1, event_id: "after-restart" }]);
    await controller.start();
    assert.equal(controller.status().running, true);
    await eventually(() => h.acks.some(([, eventId]) => eventId === "after-restart"));
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a successful internal reconnect reports the live wake stream to the host", async () => {
  const h = harness({ rooms: { [ALPHA]: [] }, profiles: "alpha", retryFirstWakes: 1 });
  const sleeper = controlledSleeper();
  const opens = [];
  const failures = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: () => "handled",
    reconnectDelayMs: 5,
    random: () => 0,
    sleep: sleeper.sleep,
    onWakeError: (error) => { failures.push(error); return "continue"; },
    onWakeOpen: () => { opens.push(h.wakeOpens()); },
  });
  try {
    await controller.start();
    await eventually(() => sleeper.calls.some(({ ms, settled }) => ms === 5 && !settled));
    sleeper.release((ms) => ms === 5);
    await eventually(() => h.wakeOpens() === 2 && opens.length === 1);
    assert.equal(failures.length, 1, "the retryable failure reaches host policy");
    assert.deepEqual(opens, [2], "only the subsequently opened reconciled stream reports success");
    assert.equal(controller.status().lastError, undefined, "a live stream supersedes the retryable error");
    assert.equal(controller.status().lastErrorAt, undefined);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("a reconnect drains work queued while the stream was disconnected", async () => {
  const h = harness({ rooms: { [ALPHA]: [] }, profiles: "alpha" });
  const sleeper = controlledSleeper();
  const handled = [];
  const failures = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: ({ message }) => { handled.push(message.event_id); return "handled"; },
    reconnectDelayMs: 5,
    random: () => 0,
    sleep: sleeper.sleep,
    onWakeError: (error) => { failures.push(error); return "continue"; },
  });
  try {
    await controller.start();
    await eventually(() => h.wakeOpens() === 1);
    h.queues.set(ALPHA, [{ seq: 2, event_id: "during-disconnect" }]);
    h.closeWake();
    await eventually(() => sleeper.calls.some(({ ms, settled }) => ms === 5 && !settled));
    assert.match(String(failures[0]), /ended unexpectedly/, "clean EOF is a reconnectable failure");
    sleeper.release((ms) => ms === 5);
    await eventually(() => handled.includes("during-disconnect"));
    assert.equal(h.wakeOpens(), 2);
    assert.deepEqual(h.acks.map(([, eventId]) => eventId), ["during-disconnect"]);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("fallback timing recovers all rooms after total wake-hint loss", async () => {
  const h = harness({
    rooms: { [ALPHA]: [], [BETA]: [] },
    wakeConfig: { fallback_ms: 1234, fallback_jitter_ms: 100, reconnect_jitter_ms: 7 },
  });
  const sleeper = controlledSleeper();
  const handled = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: ({ roomId, message }) => { handled.push([roomId, message.event_id]); return "handled"; },
    random: () => 0.5,
    sleep: sleeper.sleep,
  });
  try {
    await controller.start();
    await eventually(() => sleeper.calls.some(({ ms, settled }) => ms === 135000 && !settled));
    await eventually(() => controller.status().running && h.wakeOpens() === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.queues.set(ALPHA, [{ seq: 3, event_id: "alpha-lost-hint" }]);
    h.queues.set(BETA, [{ seq: 4, event_id: "beta-lost-hint" }]);
    sleeper.release((ms) => ms === 135000);
    await eventually(() => handled.length === 2);
    assert.deepEqual(handled.sort(), [[ALPHA, "alpha-lost-hint"], [BETA, "beta-lost-hint"]].sort());
    assert.deepEqual(h.acks.map(([roomId, eventId]) => [roomId, eventId]).sort(), handled.sort());
    await eventually(() => sleeper.calls.some(({ ms, settled }) => ms === 1284 && !settled));
    h.config({ fallback_ms: 0, fallback_jitter_ms: -1, reconnect_jitter_ms: "bad" });
    sleeper.release((ms) => ms === 1284);
    await eventually(() => sleeper.calls.filter(({ ms }) => ms === 1284).length === 2);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});

test("an empty wake response uses the bounded reconnect path", async () => {
  const h = harness({ rooms: { [ALPHA]: [] }, profiles: "alpha", emptyFirstWakes: 1 });
  const sleeper = controlledSleeper();
  const failures = [];
  const controller = new ResponsiveDeliveryController(h.client, {
    handler: () => "handled",
    reconnectDelayMs: 5,
    random: () => 0,
    sleep: sleeper.sleep,
    onWakeError: (error) => { failures.push(error); return "continue"; },
  });
  try {
    await controller.start();
    await eventually(() => sleeper.calls.some(({ ms, settled }) => ms === 5 && !settled));
    assert.equal(h.wakeOpens(), 1, "EOF never spins reopen on microtasks");
    assert.match(String(failures[0]), /ended unexpectedly/);
    sleeper.release((ms) => ms === 5);
    await eventually(() => h.wakeOpens() === 2);
  } finally {
    await controller.stop();
    h.cleanup();
  }
});
