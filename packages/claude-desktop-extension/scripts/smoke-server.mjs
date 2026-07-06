import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../server/parle-mcp.js", import.meta.url).pathname],
  env: { PATH: process.env.PATH || "" },
  stderr: "pipe",
});
const client = new Client({ name: "parle-desktop-extension-smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "parle_affordances",
    "parle_guidance",
    "parle_inbox",
    "parle_read",
    "parle_send",
    "parle_setup",
    "parle_status",
  ]);
  const setup = await client.callTool({ name: "parle_setup", arguments: {} });
  assert.equal(setup.structuredContent.ok, false);
  assert.deepEqual(setup.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
} finally {
  await client.close();
}
