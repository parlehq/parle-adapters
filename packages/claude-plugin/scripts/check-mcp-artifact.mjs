import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../dist/parle-mcp.js");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
if (!sourceBytes.equals(targetBytes)) {
  throw new Error("Claude plugin MCP artifact is stale. Run pnpm -F @parlehq/claude-plugin build after rebuilding @parlehq/mcp-server.");
}

const peersSource = resolve(here, "../../mcp-server/hooks/parle-peers.mjs");
const peersTarget = resolve(here, "../hooks/parle-peers.mjs");
if (!readFileSync(peersSource).equals(readFileSync(peersTarget))) {
  throw new Error("Bundled parle-peers helper is stale. Run the package build after rebuilding @parlehq/mcp-server.");
}

const hookSource = resolve(here, "../../mcp-server/hooks/parle-hook.mjs");
const hookTarget = resolve(here, "../hooks/parle-hook.mjs");
if (!readFileSync(hookSource).equals(readFileSync(hookTarget))) {
  throw new Error("Bundled parle-hook script is stale. Run the package build after rebuilding @parlehq/mcp-server.");
}
