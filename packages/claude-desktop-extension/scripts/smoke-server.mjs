import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../server/parle-mcp.js", import.meta.url).pathname],
  // HOME must point somewhere empty: os.homedir() works even without $HOME,
  // and a developer's real ~/.parle/profiles [default] would make setup ok.
  env: { PATH: process.env.PATH || "", HOME: mkdtempSync(join(tmpdir(), "parle-desktop-smoke-home-")) },
  stderr: "pipe",
});
const client = new Client({ name: "parle-desktop-extension-smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
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
  ]);
  const setup = await client.callTool({ name: "parle_setup", arguments: {} });
  assert.equal(setup.structuredContent.ok, false);
  assert.deepEqual(setup.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
} finally {
  await client.close();
}
