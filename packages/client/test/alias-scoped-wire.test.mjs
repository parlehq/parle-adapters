import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParleAgentClient, ResponsiveDeliveryController } from "../dist/index.js";

const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const ID = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
const SESSION_EVENT = "019f7b46-178f-7a5a-9f7b-b4af2e045262";
const ALIAS_EVENT = "019f7b46-178f-7a5a-9f7b-b4af2e045263";
const REPLY = "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("current wire keeps fixed alias context and independent scoped delivery through deferred ACK", async () => {
  const root = mkdtempSync(join(tmpdir(), "parle-alias-wire-"));
  mkdirSync(join(root, ".parle"), { mode: 0o700 });
  const calls = [];
  const pending = { session: [SESSION_EVENT], alias: [ALIAS_EVENT] };
  let claimed = false;
  const client = new ParleAgentClient({
    cwd: root,
    env: { HOME: root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "token" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url));
      calls.push({ path: `${path.pathname}${path.search}`, body: init.body && JSON.parse(init.body) });
      if (path.pathname === "/v/agent/sessions") return json({ agent_session_id: "s1", session_credential: "parle_ses_s1", expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.pathname.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.pathname.includes("/projection")) return json({ messages: [] });
      if (path.pathname === "/v/agent/session-aliases/worker") return json({ alias: "worker", alias_identity_id: ID, generation: claimed ? 4 : 3, current_agent_session_id: claimed ? "s1" : null });
      if (path.pathname.endsWith("/claim-alias")) { claimed = true; return json({ agent_session_id: "s1", alias: "worker", generation: 4 }); }
      if (path.pathname.endsWith("/messages")) return json({ event_id: "sent", seq: 1 }, 201);
      if (path.pathname.endsWith("/replies")) return json({ event_id: "reply", seq: 2 }, 201);
      if (path.pathname.endsWith("/responsive-delivery/ack")) {
        const scope = JSON.parse(init.body).cursor_scope;
        pending[scope] = [];
        return json({ cursor_scope: scope });
      }
      if (path.pathname.endsWith("/responsive-delivery")) {
        const scope = path.searchParams.get("cursor_scope");
        const context = scope === "alias" ? { alias_identity_id: ID, alias_generation: 4 } : null;
        return json({ delivery: { cursor_scope: scope, alias_context: context }, messages: pending[scope].map((event_id, i) => ({ seq: i + 1, event_id })) });
      }
      if (path.pathname.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await client.switchSessionAlias("worker");
    await client.send({ body: "fixed" });
    await client.submitReply({ body: "fixed reply", replyRouteId: REPLY });
    const controller = new ResponsiveDeliveryController(client, { handler: () => "deferred" });
    await controller.drainForTest(ROOM);
    for (const event_id of [SESSION_EVENT, ALIAS_EVENT]) assert.equal(await controller.completeDeferred(ROOM, { seq: 1, event_id }), true);

    const sends = calls.filter(({ path }) => path.endsWith("/messages") || path.endsWith("/replies"));
    assert.deepEqual(sends.map(({ body }) => body.alias_context), [
      { alias_identity_id: ID, alias_generation: 4 },
      { alias_identity_id: ID, alias_generation: 4 },
    ]);
    assert.deepEqual([...new Set(calls.filter(({ path }) => path.includes("responsive-delivery?")).map(({ path }) => path))], [
      `/v/rooms/${ROOM}/responsive-delivery?cursor_scope=session&wait=0`,
      `/v/rooms/${ROOM}/responsive-delivery?cursor_scope=alias&wait=0&alias_identity_id=${ID}&alias_generation=4`,
    ]);
    const acks = calls.filter(({ path }) => path.endsWith("/responsive-delivery/ack")).map(({ body }) => body);
    assert.deepEqual(acks, [
      { cursor_scope: "session", seq: 1, event_id: SESSION_EVENT },
      { cursor_scope: "alias", seq: 1, event_id: ALIAS_EVENT, alias_context: { alias_identity_id: ID, alias_generation: 4 } },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("absent aliases require injected human authority and alias stale leaves exact scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "parle-alias-human-"));
  mkdirSync(join(root, ".parle"), { mode: 0o700 });
  let stale = false;
  let created = false;
  const human = [];
  const client = new ParleAgentClient({
    cwd: root,
    env: { HOME: root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "token" },
    humanAliasTransport: { request: async (path, options = {}) => {
      human.push({ path, options });
      if (options.method === "PUT") created = true;
      return options.method === "PUT"
        ? { alias: "new", exists: true, creation_generation: 7 }
        : { alias: "new", exists: false, creation_generation: 7 };
    } },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json({ agent_session_id: "s1", session_credential: "parle_ses_s1", expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.includes("/projection")) return json({ messages: [] });
      if (path === "/v/agent/session-aliases/new") return json(stale ? { error: { code: "alias_context_stale", action: "resync", scope: "alias" } } : created ? { alias: "new", alias_identity_id: ID, generation: 7, current_agent_session_id: null } : { alias: "new", alias_identity_id: null, generation: 0, current_agent_session_id: null }, stale ? 409 : 200);
      if (path.endsWith("/claim-alias")) return json({ agent_session_id: "s1", alias: "new", alias_identity_id: ID, generation: 8 });
      if (path.endsWith("/messages")) return stale ? json({ error: { code: "alias_context_stale", action: "resync", scope: "alias" } }, 409) : json({ event_id: "sent", seq: 1 }, 201);
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await assert.rejects(client.switchSessionAlias("new"), { code: "alias_human_auth_required" });
    await client.switchSessionAlias("new", { agentId: ID });
    assert.deepEqual(human.map(({ options }) => options.body), [undefined, { expected_creation_generation: 7 }]);
    stale = true;
    assert.equal((await client.send({ body: "stale" })).code, "alias_context_stale");
    assert.deepEqual(client.responsiveDeliveryScopes(), ["session"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("alias loss restores only the current incarnation's server-issued exact address", async () => {
  for (const rolloverAddress of ["@p.a.exact-2", undefined]) {
    const root = mkdtempSync(join(tmpdir(), "parle-alias-address-"));
    const calls = [];
    let sessions = 0;
    let generation = 0;
    const client = new ParleAgentClient({
      cwd: root,
      env: { HOME: root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "token" },
      setTimer: () => 0,
      clearTimer: () => {},
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        calls.push(path);
        if (path === "/v/agent/sessions") {
          sessions++;
          return json({ agent_session_id: `s${sessions}`, session_credential: `parle_ses_secret-${sessions}`,
            address: sessions === 1 ? "@p.a.exact-1" : rolloverAddress, expires_at: "2099-01-01T00:00:00Z" }, 201);
        }
        if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
        if (path.includes("/projection")) return json({ messages: [] });
        if (path === "/v/agent/wake") return new Response(new ReadableStream({ start() {} }));
        if (path === "/v/agent/session-aliases/worker") return json({ alias: "worker", alias_identity_id: ID, generation, current_agent_session_id: null });
        if (path.endsWith("/claim-alias")) return json({ agent_session_id: `s${sessions}`, alias: "worker", alias_identity_id: ID, generation: ++generation, address: "@p.a.worker" });
        if (path.endsWith("/messages")) return json({ error: { code: "alias_context_stale", action: "resync", scope: "alias" } }, 409);
        if (path.endsWith("/end")) return new Response(null, { status: 204 });
        throw new Error(`unexpected ${path}`);
      },
    });
    try {
      await client.connect();
      await client.switchSessionAlias("worker");
      assert.equal(client.runtime.sessionAddress, "@p.a.worker");
      const beforeLoss = calls.length;
      assert.equal((await client.send({ body: "stale" })).code, "alias_context_stale");
      assert.equal(client.runtime.sessionAddress, "@p.a.exact-1");
      assert.equal(client.runtime.agentSessionId, "s1");
      assert.deepEqual(calls.slice(beforeLoss), [`/v/rooms/${ROOM}/messages`]);
      assert.deepEqual(client.responsiveDeliveryScopes(), ["session"]);
      await client.switchSessionAlias("worker");
      await client.performProactiveRollover();
      assert.equal(client.runtime.agentSessionId, "s2");
      assert.equal(client.runtime.sessionAddress, "@p.a.worker");
      assert.equal((await client.send({ body: "stale again" })).code, "alias_context_stale");
      assert.equal(client.runtime.sessionAddress, rolloverAddress ?? null);
      assert.equal(client.runtime.sessionHandle, "parle_ses_secret-2");
      assert.equal(sessions, 2, "loss must not reconnect");
      assert.equal(calls.filter(path => path.endsWith("/claim-alias")).length, 3, "loss must not reclaim");
      await client.endSession();
      assert.equal(client.runtime.exactSessionAddress, undefined);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
