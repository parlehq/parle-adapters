import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ParleAgentClient } from "@parlehq/agent-client";
import { MCP_CLIENT_INSTANCE_ID, MCP_CLIENT_NAME, MCP_CLIENT_VERSION, WATCHER_USAGE, WatcherUsageError, createMcpAgentClient, createParleMcpServer, hostSessionIdFromMeta, isDirectRun, parseWatcherArgs, resolveWatcherEnvironment, scheduleEagerBootstrap, watcherExitRequiresInternalRestart, watcherRequestWire } from "../dist/index.js";

const expectedTools = [
  "parle_accept_room_invitation",
  "parle_affordances",
  "parle_claim_principal_invite",
  "parle_connect",
  "parle_connect_own_agent",
  "parle_guidance",
  "parle_harden_account",
  "parle_inbox",
  "parle_mint_principal_invite",
  "parle_read",
  "parle_send",
  "parle_setup",
  "parle_status",
  "parle_switch_profile",
];

test("eager MCP bootstrap retries autonomously at the shared-client deadline", async () => {
  let now = 1_000;
  let attempts = 0;
  let bridgeStarts = 0;
  const timers = [];
  const client = {
    runtime: { bootstrapped: false, bootstrapState: "unstarted" },
    async ensureReadySafe() {
      attempts += 1;
      if (attempts === 1) {
        this.runtime = { bootstrapped: false, bootstrapState: "failed", nextRetryAt: new Date(now + 100).toISOString() };
      } else {
        this.runtime = { bootstrapped: true, bootstrapState: "ready" };
      }
      return true;
    },
  };
  const stop = scheduleEagerBootstrap(client, { async start() { bridgeStarts += 1; } }, {
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 100);
  assert.equal(timers[0].unrefCalled, true);
  now += 100;
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(bridgeStarts, 1);
  stop();
});

test("eager MCP bootstrap stops after a bounded persistent outage", async () => {
  let attempts = 0;
  let now = 1_000;
  const timers = [];
  const client = {
    runtime: { bootstrapped: false, bootstrapState: "failed" },
    async ensureReadySafe() {
      attempts += 1;
      this.runtime.nextRetryAt = new Date(now + 100).toISOString();
    },
  };
  scheduleEagerBootstrap(client, undefined, {
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (index < 4) {
      now += timers[index].delayMs;
      timers[index].callback();
    }
  }
  assert.equal(attempts, 5);
  assert.equal(timers.length, 4, "the fifth failed attempt does not arm an unbounded poll");
});

test("eager MCP bootstrap retries a transient bridge start failure", async () => {
  let starts = 0;
  const timers = [];
  const errors = [];
  const client = { runtime: { bootstrapped: true, bootstrapState: "ready" }, async ensureReadySafe() {} };
  scheduleEagerBootstrap(client, {
    async start() {
      starts += 1;
      if (starts === 1) throw new Error("bridge unavailable");
    },
  }, {
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    onError(error) { errors.push(error); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers[0].delayMs, 1_000);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 2);
  assert.equal(errors.length, 1);
  assert.equal(timers.length, 1);
});

test("direct-run detection handles URL-encoded paths", () => {
  const path = "/tmp/Application Support/parle-mcp.js";
  assert.equal(isDirectRun(pathToFileURL(path).href, path), true);
});

test("Codex request metadata resolves an exact host session binding", () => {
  assert.equal(hostSessionIdFromMeta({ threadId: "thread-direct" }), "thread-direct");
  assert.equal(hostSessionIdFromMeta({ "x-codex-turn-metadata": { session_id: "thread-session", thread_id: "thread-fallback" } }), "thread-session");
  assert.equal(hostSessionIdFromMeta({ "x-codex-turn-metadata": { thread_id: "thread-fallback" } }), "thread-fallback");
  assert.equal(hostSessionIdFromMeta({}), undefined);
});

test("simultaneous relevant exit and watcher revision is final without exact internal-stop provenance", () => {
  assert.equal(watcherExitRequiresInternalRestart(4, 5), false, "revision advancement alone cannot suppress natural exit 0");
  assert.equal(watcherExitRequiresInternalRestart(4, 5, 5), true, "the exact live child stop request permits an internal restart");
  assert.equal(watcherExitRequiresInternalRestart(5, 5, 5), false, "a stale request cannot restart a later child");
});

test("watcher arguments accept only documented positional and profile forms", () => {
  assert.deepEqual(parseWatcherArgs(["0"]), { workerArgs: ["0"] });
  assert.deepEqual(parseWatcherArgs(["007"]), { workerArgs: ["007"] });
  assert.deepEqual(parseWatcherArgs(["7"]), { workerArgs: ["7"] });
  assert.deepEqual(parseWatcherArgs(["7", "as-1"]), { workerArgs: ["7", "as-1"] });
  assert.deepEqual(parseWatcherArgs(["--profile", "target", "7"]), { profile: "target", workerArgs: ["7"] });
  assert.deepEqual(parseWatcherArgs(["--profile", "target", "7", "as-1"]), { profile: "target", workerArgs: ["7", "as-1"] });

  for (const args of [[], ["--unknown"], ["--profile=x", "7"], ["--profile"], ["--profile", "target"], ["--profile", "--bad", "7"], [""], [" "], ["abc"], ["-1"], ["+1"], ["1.5"], ["1e3"], ["50", "--profile"], ["7", "as-1", "extra"], ["--profile", "target", "abc"], ["--profile", "target", "7", "--sid"], ["--profile", "target", "7", "as-1", "extra"]]) {
    assert.throws(() => parseWatcherArgs(args), (error) => error instanceof WatcherUsageError && error.message === WATCHER_USAGE);
  }
});

const watcherEnv = {
  PARLE_API_BASE: "https://api.example",
  PARLE_ROOM_ID: "room-1",
  PARLE_ROOM_AGENT_TOKEN: "parle_agt_watch_secret",
  PARLE_WATCH_AGENT_SESSION: "parle_ses_watch_secret",
  PARLE_WATCH_CLIENT_INSTANCE_ID: MCP_CLIENT_INSTANCE_ID,
  PARLE_VERSION: "2026-08-01",
  PARLE_INTEGRATION_NAME: "@parlehq/claude-plugin",
  PARLE_INTEGRATION_VERSION: "0.5.39",
};

test("watch request helper retains the owner process identity without exposing credentials", async () => {
  let requestedUrl;
  let requestedHeaders;
  const fetchImpl = (url, options) => {
    requestedUrl = String(url);
    requestedHeaders = options.headers;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  };
  const wire = await watcherRequestWire("7", "hold", { env: watcherEnv, fetchImpl, timeoutMs: 5, parentPid: 0 });
  assert.equal(wire, '000\n{"watcher_local":{"outcome":"held_deadline"}}');
  assert.match(requestedUrl, /since_seq=7&wait=25/);
  assert.equal(requestedHeaders["Parle-Client-Name"], MCP_CLIENT_NAME);
  assert.equal(requestedHeaders["Parle-Client-Version"], MCP_CLIENT_VERSION);
  assert.equal(requestedHeaders["Parle-Client-Instance"], MCP_CLIENT_INSTANCE_ID);
  assert.equal(requestedHeaders["Parle-Integration-Name"], "@parlehq/claude-plugin");
  assert.equal(requestedHeaders["Parle-Integration-Version"], "0.5.39");
  assert.equal(wire.includes(watcherEnv.PARLE_ROOM_AGENT_TOKEN), false);
  assert.equal(wire.includes(watcherEnv.PARLE_WATCH_AGENT_SESSION), false);
});

test("watch request helper keeps transport, parent abort, and malformed responses distinct from a held deadline", async () => {
  const transport = await watcherRequestWire("8", "hold", {
    env: watcherEnv,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    parentPid: 0,
  });
  assert.equal(transport, '000\n{"watcher_local":{"outcome":"network_failure"}}');

  for (const body of ["not-json", "[]", "null", "{}", '{"messages":[],"watermark":-1}']) {
    const malformed = await watcherRequestWire("9", "hold", {
      env: watcherEnv,
      fetchImpl: async () => new Response(body, { status: 200 }),
      parentPid: 0,
    });
    assert.equal(malformed, '000\n{"watcher_local":{"outcome":"malformed_response"}}');
  }

  const parentAbort = await watcherRequestWire("10", "hold", {
    env: watcherEnv,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    timeoutMs: 2000,
    parentPid: 99999999,
  });
  assert.equal(parentAbort, '000\n{"watcher_local":{"outcome":"parent_gone"}}');

  const probeTimeout = await watcherRequestWire("11", "probe", {
    env: watcherEnv,
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    timeoutMs: 5,
    parentPid: 0,
  });
  assert.equal(probeTimeout, '000\n{"watcher_local":{"outcome":"network_failure"}}');

  const http = await watcherRequestWire("12", "hold", {
    env: watcherEnv,
    fetchImpl: async () => new Response(JSON.stringify({ messages: [], watermark: 12 }), { status: 200 }),
    parentPid: 0,
  });
  assert.equal(http, '200\n{"messages":[],"watermark":12}');

  const apiError = await watcherRequestWire("13", "hold", {
    env: watcherEnv,
    fetchImpl: async () => new Response(JSON.stringify({ error: { action: "retry_with_backoff", retry_after_ms: 2000 } }), { status: 429 }),
    parentPid: 0,
  });
  assert.equal(apiError, '429\n{"error":{"action":"retry_with_backoff","retry_after_ms":2000}}');
});

test("MCP client factory keeps one process identity through dedicated session bootstrap", async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers });
    if (String(url).endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-watch", session_credential: "parle_ses_watch", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    if (String(url).endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "part-watch" }), { status: 201 });
    return new Response(JSON.stringify({ watermark: 0, messages: [] }));
  };
  const integrationEnv = {
    PARLE_ROOM_ID: "room-1",
    PARLE_ROOM_AGENT_TOKEN: "token-1",
    PARLE_INTEGRATION_NAME: "@parlehq/codex-plugin",
    PARLE_INTEGRATION_VERSION: "0.2.3",
  };
  const first = createMcpAgentClient({ env: integrationEnv, fetch: fetchImpl });
  const second = createMcpAgentClient({ env: integrationEnv, fetch: fetchImpl });
  await first.bootstrap();
  await second.requestJson("/v/probe");
  assert.equal(first.clientInstanceId, MCP_CLIENT_INSTANCE_ID);
  assert.equal(second.clientInstanceId, MCP_CLIENT_INSTANCE_ID);
  for (const request of requests) {
    assert.equal(request.headers["Parle-Client-Name"], MCP_CLIENT_NAME);
    assert.equal(request.headers["Parle-Client-Version"], MCP_CLIENT_VERSION);
    assert.equal(request.headers["Parle-Client-Instance"], MCP_CLIENT_INSTANCE_ID);
    assert.equal(request.headers["Parle-Integration-Name"], "@parlehq/codex-plugin");
    assert.equal(request.headers["Parle-Integration-Version"], "0.2.3");
  }
  assert.throws(
    () => createMcpAgentClient({ env: { PARLE_INTEGRATION_VERSION: "1.0.0" } }),
    /requires PARLE_INTEGRATION_NAME/,
  );
});

test("account-tool errors preserve actionable invitation denial fields", async () => {
  const denial = Object.assign(new Error("Parle API 403: forbidden. Reason: unhardened. Next action: set a password, then enroll a second factor"), {
    status: 403,
    code: "forbidden",
    reason: "unhardened",
    nextAction: "set a password, then enroll a second factor",
  });
  const server = createParleMcpServer({}, { mintPrincipalInvite: async () => { throw denial; } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-unit", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_mint_principal_invite", arguments: {
      roomId: "019f7b46-178f-7a5a-9f7b-b4af2e045261",
      principalHandle: "kljensen",
      confirmMutation: true,
      reason: "Invite Kyle",
    } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 403);
    assert.equal(result.structuredContent.code, "forbidden");
    assert.equal(result.structuredContent.reason, "unhardened");
    assert.equal(result.structuredContent.nextAction, "set a password, then enroll a second factor");
  } finally {
    await client.close();
    await server.close();
  }
});

test("watch launcher uses shared profile resolution and preserves direct config", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-mcp-watch-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-mcp-watch-cwd-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[watch]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_watch_secret\napi_base = https://profile.example\n", { mode: 0o600 });
    const profile = resolveWatcherEnvironment(cwd, { HOME: home, PARLE_PROFILE: "watch", SAFE_KEEP: "yes" });
    assert.equal(profile.PARLE_ROOM_ID, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
    assert.equal(profile.PARLE_ROOM_AGENT_TOKEN, "parle_agt_watch_secret");
    assert.equal(profile.PARLE_API_BASE, "https://profile.example");
    assert.equal(profile.SAFE_KEEP, "yes");
    assert.equal(profile.PARLE_PROFILE, undefined);
    assert.equal(profile.PARLE_WATCH_CLIENT_INSTANCE_ID, MCP_CLIENT_INSTANCE_ID);
    const explicitProfile = resolveWatcherEnvironment(cwd, { HOME: home, PARLE_PROFILE: "stale-selector" }, undefined, "watch");
    assert.equal(explicitProfile.PARLE_ROOM_AGENT_TOKEN, "parle_agt_watch_secret");
    assert.equal(explicitProfile.PARLE_PROFILE, undefined);
    assert.throws(
      () => resolveWatcherEnvironment(cwd, { HOME: home, PARLE_PROFILE: "watch", PARLE_ROOM_ID: "stale-direct" }),
      /conflicts with direct configuration/,
    );

    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_default_secret\n", { mode: 0o600 });
    const defaultProfile = resolveWatcherEnvironment(cwd, { HOME: home });
    assert.equal(defaultProfile.PARLE_ROOM_AGENT_TOKEN, "parle_agt_default_secret");

    const direct = resolveWatcherEnvironment(cwd, { PARLE_ROOM_ID: "room-direct", PARLE_ROOM_AGENT_TOKEN: "direct-token", PARLE_API_BASE: "https://direct.example" });
    assert.equal(direct.PARLE_ROOM_ID, "room-direct");
    assert.equal(direct.PARLE_ROOM_AGENT_TOKEN, "direct-token");
    assert.equal(direct.PARLE_API_BASE, "https://direct.example");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parle_setup returns routine not-configured diagnostics as a successful tool result", async () => {
  const server = createParleMcpServer({
    setup: () => ({ ok: false, configured: false, missing: ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-setup-diagnostic", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_setup", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.configured, false);
    assert.deepEqual(result.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("parle_setup preserves unexpected failures as MCP tool errors", async () => {
  const server = createParleMcpServer({
    setup: () => { throw new Error("profile catalog parse failed"); },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-setup-error", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_setup", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.match(result.structuredContent.error, /profile catalog parse failed/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-memory server maps read, send, and errors through fake client", async () => {
  const calls = [];
  const fakeClient = {
    status: () => ({ ok: true }),
    setup: () => ({ ok: true }),
    connect: async () => { calls.push(["connect"]); return { connected: true, sessionAddress: "@p.a.s1", roomHandle: "room-one", agentSessionId: "as-1", cursor: 3 }; },
    guidance: async () => ({ ok: true }),
    readProjection: async (params) => { calls.push(["read", params]); return { messages: [], cursorAfter: 3 }; },
    readInbox: async () => ({ messages: [] }),
    affordances: async () => ({ affordances: [] }),
    send: async (params) => { calls.push(["send", params]); return { event_id: "evt-1", idempotencyKey: params.idempotencyKey, deliveryStatus: { state: "accepted_scan_skipped", message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion." } }; },
    switchProfile: async (profile) => { calls.push(["switch", profile]); return { switched: true, profile, cursor: 42, agentSessionId: "as-target", roomHandle: "target-room" }; },
  };
  const fakeAccount = {
    hardenAccount: async (params) => { calls.push(["harden-account", params]); return { action: params.action, state: "needs_password", next: "human helper" }; },
    mintPrincipalInvite: async (params) => { calls.push(["mint-invite", params]); return { inviteId: "invite-1", handoffPath: "/private/invite.json" }; },
    claimPrincipalInvite: async (params) => { calls.push(["claim-invite", params]); return { action: params.action, roomId: "room-1" }; },
  };
  const server = createParleMcpServer(fakeClient, fakeAccount);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-unit", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const connect = await client.callTool({ name: "parle_connect", arguments: {} });
    assert.equal(connect.structuredContent.connected, true);
    assert.equal(connect.structuredContent.agentSessionId, "as-1");
    assert.match(connect.structuredContent.compactText, /Session Address:\n@p\.a\.s1/);
    assert.match(connect.content[0].text, /\"agentSessionId\": \"as-1\"/);
    const read = await client.callTool({ name: "parle_read", arguments: { waitSeconds: 1 } });
    assert.equal(read.structuredContent.cursorAfter, 3);
    const send = await client.callTool({ name: "parle_send", arguments: { body: "hello", to: "@p.a.s1", idempotencyKey: "idem-1" } });
    assert.equal(send.structuredContent.idempotencyKey, "idem-1");
    assert.equal(send.structuredContent.deliveryStatus.state, "accepted_scan_skipped");
    const refused = await client.callTool({ name: "parle_switch_profile", arguments: { profile: "target", watcherStopped: false } });
    assert.equal(refused.isError, true);
    assert.match(refused.structuredContent.error, /watcherStopped=true/);
    const switched = await client.callTool({ name: "parle_switch_profile", arguments: { profile: "target", watcherStopped: true } });
    assert.equal(switched.structuredContent.roomHandle, "target-room");
    assert.deepEqual(switched.structuredContent.watcher.launcherArgs, ["--profile", "target", "42", "as-target"]);
    const hardening = await client.callTool({ name: "parle_harden_account", arguments: { action: "status" } });
    assert.equal(hardening.structuredContent.state, "needs_password");
    const minted = await client.callTool({ name: "parle_mint_principal_invite", arguments: { roomId: "room-1", principalHandle: "kyle", confirmMutation: true, reason: "invite" } });
    assert.equal(minted.structuredContent.handoffPath, "/private/invite.json");
    const previewed = await client.callTool({ name: "parle_claim_principal_invite", arguments: { action: "preview", handoffPath: "/private/invite.json" } });
    assert.equal(previewed.structuredContent.action, "preview");
    assert.deepEqual(calls, [
      ["connect"],
      ["read", { waitSeconds: 1 }],
      ["send", { body: "hello", to: "@p.a.s1", idempotencyKey: "idem-1" }],
      ["switch", "target"],
      ["harden-account", { action: "status" }],
      ["mint-invite", { roomId: "room-1", principalHandle: "kyle", confirmMutation: true, reason: "invite" }],
      ["claim-invite", { action: "preview", handoffPath: "/private/invite.json" }],
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-memory server send summarizes delivery state through real client", async () => {
  const clientImpl = new ParleAgentClient({
    env: {
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "opaque-token",
    },
    randomUUID: () => "idem-real-client",
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 150, moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending" } }, 201);
      return json({});
    },
  });
  const server = createParleMcpServer(clientImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-real-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const send = await client.callTool({ name: "parle_send", arguments: { body: "hello" } });
    assert.equal(send.structuredContent.idempotencyKey, "idem-real-client");
    assert.equal(send.structuredContent.deliveryStatus.state, "accepted_scan_skipped");
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-memory server marks ok false send results as MCP tool errors", async () => {
  const fakeClient = {
    status: () => ({}),
    setup: () => ({}),
    guidance: async () => ({}),
    readProjection: async () => ({}),
    readInbox: async () => ({}),
    affordances: async () => ({}),
    send: async () => ({ ok: false, retryable: true, idempotencyKey: "idem-retry", error: "rate limited" }),
  };
  const server = createParleMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-send-errors", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_send", arguments: { body: "hello" } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.idempotencyKey, "idem-retry");
    assert.equal(Object.hasOwn(result.structuredContent, "deliveryStatus"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("in-memory server maps client errors into MCP tool errors", async () => {
  const fakeClient = {
    status: () => ({}),
    setup: () => ({}),
    guidance: async () => ({}),
    readProjection: async () => { throw new Error("boom"); },
    readInbox: async () => ({}),
    affordances: async () => ({}),
    send: async () => ({}),
  };
  const server = createParleMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-errors", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_read", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.match(result.structuredContent.error, /boom/);
  } finally {
    await client.close();
    await server.close();
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function realClientEnv() {
  return { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" };
}

function sessionFetch(counters) {
  return async (url) => {
    counters.total = (counters.total || 0) + 1;
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      counters.sessions = (counters.sessions || 0) + 1;
      return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", address: "@p.a.s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
    if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
    return json({});
  };
}

test("parle_status auto-connects a configured client and reports the attempt", async () => {
  const counters = {};
  const clientImpl = new ParleAgentClient({ env: realClientEnv(), fetch: sessionFetch(counters) });
  const server = createParleMcpServer(clientImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-status-auto", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const first = await client.callTool({ name: "parle_status", arguments: {} });
    assert.equal(first.structuredContent.bootstrapAttempted, true);
    assert.equal(first.structuredContent.runtime.bootstrapped, true);
    assert.equal(first.structuredContent.runtime.bootstrapState, "ready");
    assert.equal(first.structuredContent.runtime.sessionAddress, "@p.a.s1");
    assert.match(first.structuredContent.compactText, /Session Address:\n@p\.a\.s1/);
    assert.match(first.structuredContent.compactText, /Watcher       unknown/);
    assert.match(first.structuredContent.compactText, /Next: arm or verify the watcher\./);
    assert.deepEqual(first.structuredContent.watcher, {
      state: "unknown",
      nextActionKey: "arm-or-verify-watcher",
      nextAction: "arm or verify the watcher",
    });
    assert.equal(counters.sessions, 1);
    const second = await client.callTool({ name: "parle_status", arguments: {} });
    assert.equal(second.structuredContent.bootstrapAttempted, false);
    assert.deepEqual(second.structuredContent.watcher, first.structuredContent.watcher);
    assert.equal(counters.sessions, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("parle_status surfaces an unarmed bridge error as degraded", async () => {
  const counters = {};
  const clientImpl = new ParleAgentClient({ env: realClientEnv(), fetch: sessionFetch(counters) });
  const deliveryBridge = {
    start: async () => {},
    bindHostSession: () => true,
    status: () => ({
      running: false,
      pending: 0,
      baselineSkipped: 0,
      socketPath: "/tmp/parle-test.sock",
      hostSessionBound: true,
      lastError: "Parle wake stream 502: Bad Gateway",
    }),
  };
  const server = createParleMcpServer(clientImpl, undefined, deliveryBridge);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-status-degraded", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_status", arguments: {} });
    assert.match(result.structuredContent.compactText, /Watcher       degraded/);
    assert.match(result.structuredContent.compactText, /Next: inspect the responsive delivery error and restart the host if it does not recover\./);
    assert.equal(result.structuredContent.watcher.state, "degraded");
    assert.equal(result.structuredContent.responsiveDeliveryBridge.lastError, "Parle wake stream 502: Bad Gateway");
  } finally {
    await client.close();
    await server.close();
  }
});

test("parle_status inspect:true is a passive read with no network side effects", async () => {
  const counters = {};
  const clientImpl = new ParleAgentClient({ env: realClientEnv(), fetch: sessionFetch(counters) });
  const server = createParleMcpServer(clientImpl);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-status-inspect", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_status", arguments: { inspect: true } });
    assert.equal(result.structuredContent.bootstrapAttempted, false);
    assert.equal(result.structuredContent.runtime.bootstrapped, false);
    assert.match(result.structuredContent.compactText, /Parle configured, not connected/);
    assert.equal(Object.hasOwn(result.structuredContent, "watcher"), false);
    assert.doesNotMatch(result.structuredContent.compactText, /Watcher/);
    assert.equal(counters.total ?? 0, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("parle_status works against minimal fake clients without lifecycle methods", async () => {
  const fakeClient = {
    status: () => ({ ok: true }),
    setup: () => ({}),
    guidance: async () => ({}),
    readProjection: async () => ({}),
    readInbox: async () => ({}),
    affordances: async () => ({}),
    send: async () => ({}),
  };
  const server = createParleMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-status-fake", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: "parle_status", arguments: {} });
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.bootstrapAttempted, false);
    // No config/runtime shape means no card; never fabricate one from unknown status shapes.
    assert.equal(Object.hasOwn(result.structuredContent, "compactText"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("stdio server lists the fourteen tools and setup works without secrets", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/parle-mcp.js", import.meta.url).pathname],
    // HOME must point somewhere empty: os.homedir() works even without $HOME,
    // and a developer's real ~/.parle/profiles [default] would make setup ok.
    env: { PATH: process.env.PATH || "", HOME: mkdtempSync(join(tmpdir(), "parle-mcp-smoke-home-")) },
    stderr: "pipe",
  });
  const client = new Client({ name: "parle-mcp-smoke", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), expectedTools);
    const setup = await client.callTool({ name: "parle_setup", arguments: {} });
    assert.equal(setup.isError, undefined);
    assert.equal(setup.structuredContent.ok, false);
    assert.equal(setup.structuredContent.configured, false);
    assert.deepEqual(setup.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
    const read = tools.tools.find((tool) => tool.name === "parle_read");
    assert.match(read.description, /Supplying sinceSeq makes the call an audit read by default and does not advance/);
    assert.match(read.description, /set advanceCursor:true; it advances only through returned capped rows, never the response watermark/);
    assert.match(read.description, /advanceCursor:false never advances/);
    assert.match(read.description, /bounded single wait/);
    assert.match(read.description, /Do not loop/);
    assert.match(read.description, /untrusted/);
    const inbox = tools.tools.find((tool) => tool.name === "parle_inbox");
    assert.match(inbox.description, /Supplying sinceSeq makes the call an audit read by default and does not advance/);
    assert.match(inbox.description, /set advanceCursor:true; it advances only through returned capped rows, never the response watermark/);
    assert.match(inbox.description, /parle_send with to set exactly to that message's author\.address/);
    assert.match(inbox.description, /will not wake that peer/);
    assert.match(inbox.description, /do not guess from participant_id or provenance fields/);
    const connectOwnAgent = tools.tools.find((tool) => tool.name === "parle_connect_own_agent");
    assert.match(connectOwnAgent.description, /one owned durable agent per operation/);
    assert.match(connectOwnAgent.description, /create an additional one/);
    assert.match(connectOwnAgent.inputSchema.properties.createAgentHandle.description, /instead of selecting an existing agent/);
    const guidance = tools.tools.find((tool) => tool.name === "parle_guidance");
    assert.equal(guidance.annotations.openWorldHint, undefined);
    const harden = tools.tools.find((tool) => tool.name === "parle_harden_account");
    assert.deepEqual(Object.keys(harden.inputSchema.properties).sort(), ["action", "confirmMutation", "reason"]);
    assert.doesNotMatch(JSON.stringify(harden.inputSchema), /password|recovery|provisioning|path/i);
    const send = tools.tools.find((tool) => tool.name === "parle_send");
    assert.equal(send.annotations.openWorldHint, true);
  } finally {
    await client.close();
  }
});

test("room-scoped tools pass roomId through to the client", async () => {
  const calls = [];
  const fakeClient = {
    status: () => ({ ok: true }),
    setup: () => ({ ok: true }),
    connect: async () => ({ connected: true }),
    guidance: async () => ({ ok: true }),
    readProjection: async (params) => { calls.push(["read", params.roomId]); return { messages: [], roomId: params.roomId }; },
    readInbox: async (params) => { calls.push(["inbox", params.roomId]); return { messages: [], roomId: params.roomId }; },
    affordances: async (params) => { calls.push(["affordances", params?.roomId]); return { affordances: [] }; },
    send: async (params) => { calls.push(["send", params.roomId]); return { event_id: "evt-1", roomId: params.roomId }; },
  };
  const server = createParleMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-rooms", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.callTool({ name: "parle_read", arguments: { roomId: "room-a" } });
    await client.callTool({ name: "parle_inbox", arguments: { roomId: "room-b" } });
    await client.callTool({ name: "parle_affordances", arguments: { roomId: "room-c" } });
    await client.callTool({ name: "parle_send", arguments: { body: "hi", roomId: "room-d" } });
    assert.deepEqual(calls, [["read", "room-a"], ["inbox", "room-b"], ["affordances", "room-c"], ["send", "room-d"]]);
    // Omission stays valid at the tool layer; the client decides whether one
    // configured room makes it unambiguous or fails closed.
    await client.callTool({ name: "parle_read", arguments: {} });
    assert.deepEqual(calls.at(-1), ["read", undefined]);
  } finally {
    await client.close();
    await server.close();
  }
});
