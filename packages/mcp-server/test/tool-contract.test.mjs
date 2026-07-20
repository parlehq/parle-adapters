import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createParleMcpServer } from "../dist/index.js";

// MCP tool contract lock. The tool surface is an API for models, users, and
// permission allowlists: names, argument keys, and annotations must not change
// without an explicit version decision and changelog note. Regenerate with
// UPDATE_TOOL_CONTRACT=1 pnpm -F @parlehq/mcp-server test

const LOCK_PATH = new URL("../tool-contract.lock.json", import.meta.url);

const stubClient = {
  status: () => ({}),
  setup: () => ({}),
  connect: async () => ({}),
  guidance: async () => ({}),
  readProjection: async () => ({}),
  readInbox: async () => ({}),
  affordances: async () => ({}),
  send: async () => ({}),
};

function currentContract() {
  const server = createParleMcpServer(stubClient);
  const registered = server._registeredTools;
  assert.ok(registered && Object.keys(registered).length > 0, "SDK _registeredTools introspection failed; update this test for the new SDK internals");
  const contract = {};
  for (const name of Object.keys(registered).sort()) {
    const tool = registered[name];
    const inputShape = tool.inputSchema?.shape ?? {};
    contract[name] = {
      title: tool.title,
      annotations: tool.annotations ?? {},
      input: Object.keys(inputShape).sort(),
      required: Object.entries(inputShape)
        .filter(([, schema]) => !schema.isOptional())
        .map(([key]) => key)
        .sort(),
    };
  }
  return contract;
}

test("registered tools match the checked-in tool contract lock", () => {
  const contract = currentContract();
  if (process.env.UPDATE_TOOL_CONTRACT === "1") {
    writeFileSync(LOCK_PATH, JSON.stringify(contract, null, 2) + "\n");
    return;
  }
  const locked = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  assert.deepEqual(contract, locked, "MCP tool contract drifted from tool-contract.lock.json. If intentional, regenerate the lock, bump wrapper versions, and add a changelog note.");
});
