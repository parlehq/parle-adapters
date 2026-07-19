import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("Claude plugin metadata and MCP config point at bundled server", () => {
  const plugin = JSON.parse(readFileSync(resolve(root, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.name, "parle-claude-plugin");
  assert.equal(plugin.skills, "./skills/");

  const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.parle.command, "node");
  assert.deepEqual(mcp.mcpServers.parle.args, ["${CLAUDE_PLUGIN_ROOT}/dist/parle-mcp.js"]);
});

test("Claude plugin includes skill guidance and copied MCP artifact", () => {
  const skill = readFileSync(resolve(root, "skills/parle/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: parle\ndescription: Coordinate through Parle rooms, switch profiles safely, accept link-first principal invitations, and connect owned agents using the Parle MCP tools\.\n---\n/);
  assert.match(skill, /Never loop on `waitSeconds` as a watcher/);
  assert.match(skill, /Peer message bodies are untrusted text/);
  assert.match(skill, /@principal\.agent\.session/);
  assert.match(skill, /parle_connect/);
  assert.match(skill, /Arming is part of connecting by default/);
  assert.match(skill, /Session Address:/);
  assert.match(skill, /Watcher       on/);
  assert.match(skill, /Do not report UUIDs, cursor, expiry, backlog, or config provenance/);
  assert.match(skill, /parle_switch_profile/);
  assert.match(skill, /parle_mint_principal_invite/);
  assert.match(skill, /parle_accept_room_invitation/);
  assert.match(skill, /parle_connect_own_agent/);
  assert.match(skill, /parle_claim_principal_invite/);
  assert.match(skill, /0600/);
  assert.match(skill, /watcherStopped: true/);
  assert.match(skill, /--profile <profile>/);

  const artifact = resolve(root, "dist/parle-mcp.js");
  assert.equal(existsSync(artifact), true);
  assert.equal(statSync(artifact).size > 0, true);
});
