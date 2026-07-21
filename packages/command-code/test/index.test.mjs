import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("Command Code wrapper includes safe skill guidance and MCP artifact", () => {
  const skill = readFileSync(resolve(root, "skills/parle/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: parle\ndescription:/);
  assert.match(skill, /mcp__parle__parle_\*/);
  assert.match(skill, /Never read, print, copy, grep/);
  assert.match(skill, /structured `to` field/);
  assert.match(skill, /never a watcher loop/);
  assert.match(skill, /parle_connect/);
  assert.match(skill, /parle_send/);
  assert.match(skill, /\/v\/agent\/wake/);
  assert.match(skill, /Never create a cron/);

  const hook = readFileSync(resolve(root, "skills/parle/scripts/parle-hook.mjs"), "utf8");
  assert.match(hook, /decision: "block"/);
  assert.match(hook, /additionalContext/);
  assert.match(hook, /action: "commit"/);

  const artifact = resolve(root, "skills/parle/server/parle-mcp.js");
  assert.equal(existsSync(artifact), true);
  assert.equal(statSync(artifact).size > 0, true);
});

test("native skill configuration contains no Parle credentials or private config parsing", () => {
  const configure = readFileSync(resolve(root, "skills/parle/scripts/configure.mjs"), "utf8");
  assert.doesNotMatch(configure, /PARLE_ROOM_AGENT_TOKEN/);
  assert.doesNotMatch(configure, /agent_token/);
  assert.doesNotMatch(configure, /Authorization/);
  assert.doesNotMatch(configure, /\.parle\/profiles/);
  assert.match(configure, /"mcp", "add"/);
  assert.match(configure, /"--scope", "user"/);
  assert.match(configure, /PARLE_HOST_ADAPTER=command-code/);
  assert.match(configure, /mergeParleHooks/);
});
