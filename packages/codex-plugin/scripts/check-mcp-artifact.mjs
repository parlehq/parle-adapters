import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../dist/parle-mcp.js");
const hookSource = resolve(here, "../../mcp-server/hooks/parle-hook.mjs");
const hookTarget = resolve(here, "../hooks/parle-hook.mjs");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
const hookSourceBytes = readFileSync(hookSource);
const hookTargetBytes = readFileSync(hookTarget);
if (!sourceBytes.equals(targetBytes) || !hookSourceBytes.equals(hookTargetBytes)) {
  throw new Error("Codex plugin MCP or hook artifact is stale. Rebuild @parlehq/mcp-server, then build @parlehq/codex-plugin.");
}

const peersSource = resolve(here, "../../mcp-server/hooks/parle-peers.mjs");
const peersTarget = resolve(here, "../hooks/parle-peers.mjs");
if (!readFileSync(peersSource).equals(readFileSync(peersTarget))) {
  throw new Error("Bundled parle-peers helper is stale. Run the package build after rebuilding @parlehq/mcp-server.");
}
