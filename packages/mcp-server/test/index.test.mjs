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
import { createParleMcpServer, isDirectRun, resolveWatcherEnvironment } from "../dist/index.js";

const expectedTools = [
  "parle_accept_room_invitation",
  "parle_affordances",
  "parle_claim_principal_invite",
  "parle_connect",
  "parle_connect_own_agent",
  "parle_guidance",
  "parle_inbox",
  "parle_mint_principal_invite",
  "parle_read",
  "parle_send",
  "parle_setup",
  "parle_status",
  "parle_switch_profile",
];

test("direct-run detection handles URL-encoded paths", () => {
  const path = "/tmp/Application Support/parle-mcp.js";
  assert.equal(isDirectRun(pathToFileURL(path).href, path), true);
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
    const minted = await client.callTool({ name: "parle_mint_principal_invite", arguments: { roomId: "room-1", principalId: "principal-1", principalHandle: "kyle", confirmMutation: true, reason: "invite" } });
    assert.equal(minted.structuredContent.handoffPath, "/private/invite.json");
    const previewed = await client.callTool({ name: "parle_claim_principal_invite", arguments: { action: "preview", handoffPath: "/private/invite.json" } });
    assert.equal(previewed.structuredContent.action, "preview");
    assert.deepEqual(calls, [
      ["connect"],
      ["read", { waitSeconds: 1 }],
      ["send", { body: "hello", to: "@p.a.s1", idempotencyKey: "idem-1" }],
      ["switch", "target"],
      ["mint-invite", { roomId: "room-1", principalId: "principal-1", principalHandle: "kyle", confirmMutation: true, reason: "invite" }],
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
    assert.equal(counters.sessions, 1);
    const second = await client.callTool({ name: "parle_status", arguments: {} });
    assert.equal(second.structuredContent.bootstrapAttempted, false);
    assert.equal(counters.sessions, 1);
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

test("stdio server lists the thirteen tools and setup works without secrets", async () => {
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
    assert.equal(setup.structuredContent.ok, false);
    assert.deepEqual(setup.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
    const read = tools.tools.find((tool) => tool.name === "parle_read");
    assert.match(read.description, /bounded single wait/);
    assert.match(read.description, /Do not loop/);
    assert.match(read.description, /untrusted/);
    const guidance = tools.tools.find((tool) => tool.name === "parle_guidance");
    assert.equal(guidance.annotations.openWorldHint, undefined);
    const send = tools.tools.find((tool) => tool.name === "parle_send");
    assert.equal(send.annotations.openWorldHint, true);
  } finally {
    await client.close();
  }
});
