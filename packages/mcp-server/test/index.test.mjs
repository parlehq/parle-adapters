import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { pathToFileURL } from "node:url";
import { ParleAgentClient } from "@parlehq/agent-client";
import { createParleMcpServer, isDirectRun } from "../dist/index.js";

const expectedTools = [
  "parle_affordances",
  "parle_connect",
  "parle_guidance",
  "parle_inbox",
  "parle_read",
  "parle_send",
  "parle_setup",
  "parle_status",
];

test("direct-run detection handles URL-encoded paths", () => {
  const path = "/tmp/Application Support/parle-mcp.js";
  assert.equal(isDirectRun(pathToFileURL(path).href, path), true);
});

test("in-memory server maps read, send, and errors through fake client", async () => {
  const calls = [];
  const fakeClient = {
    status: () => ({ ok: true }),
    setup: () => ({ ok: true }),
    connect: async () => { calls.push(["connect"]); return { connected: true, sessionAddress: "@p.a.s1", agentSessionId: "as-1", cursor: 3 }; },
    guidance: async () => ({ ok: true }),
    readProjection: async (params) => { calls.push(["read", params]); return { messages: [], cursorAfter: 3 }; },
    readInbox: async () => ({ messages: [] }),
    affordances: async () => ({ affordances: [] }),
    send: async (params) => { calls.push(["send", params]); return { event_id: "evt-1", idempotencyKey: params.idempotencyKey, deliveryStatus: { state: "accepted_scan_skipped", message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion." } }; },
  };
  const server = createParleMcpServer(fakeClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "parle-mcp-unit", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const connect = await client.callTool({ name: "parle_connect", arguments: {} });
    assert.equal(connect.structuredContent.connected, true);
    assert.equal(connect.structuredContent.agentSessionId, "as-1");
    const read = await client.callTool({ name: "parle_read", arguments: { waitSeconds: 1 } });
    assert.equal(read.structuredContent.cursorAfter, 3);
    const send = await client.callTool({ name: "parle_send", arguments: { body: "hello", to: "@p.a.s1", idempotencyKey: "idem-1" } });
    assert.equal(send.structuredContent.idempotencyKey, "idem-1");
    assert.equal(send.structuredContent.deliveryStatus.state, "accepted_scan_skipped");
    assert.deepEqual(calls, [["connect"], ["read", { waitSeconds: 1 }], ["send", { body: "hello", to: "@p.a.s1", idempotencyKey: "idem-1" }]]);
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

test("stdio server lists the eight v1 tools and setup works without secrets", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/parle-mcp.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH || "" },
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
