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
    "parle_add_own_agent_seat",
    "parle_affordances",
    "parle_alias_delivery",
    "parle_claim_principal_invite",
    "parle_connect",
    "parle_connect_own_agent",
    "parle_create_own_agent",
    "parle_create_room",
    "parle_delete_own_agent",
    "parle_delete_profile",
    "parle_end_own_session",
    "parle_guidance",
    "parle_harden_account",
    "parle_inbox",
    "parle_login",
    "parle_mint_principal_invite",
    "parle_onboard",
    "parle_owned_alias_delivery",
    "parle_owned_alias_release",
    "parle_read",
    "parle_reply",
    "parle_room_capacity_recovery",
    "parle_room_participants",
    "parle_rooms",
    "parle_saved_start",
    "parle_send",
    "parle_session_alias",
    "parle_setup",
    "parle_status",
    "parle_switch_profile",
  ]);
  const harden = tools.tools.find((tool) => tool.name === "parle_harden_account");
  assert.deepEqual(Object.keys(harden.inputSchema.properties).sort(), ["action", "confirmMutation", "reason"]);
  assert.doesNotMatch(JSON.stringify(harden.inputSchema), /password|recovery|provisioning|path/i);
  const setup = await client.callTool({ name: "parle_setup", arguments: {} });
  assert.equal(setup.structuredContent.ok, false);
  assert.deepEqual(setup.structuredContent.missing, ["PARLE_ROOM_ID", "PARLE_ROOM_AGENT_TOKEN"]);
} finally {
  await client.close();
}
