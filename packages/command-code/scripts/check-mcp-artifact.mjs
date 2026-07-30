import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../skills/parle/server/parle-mcp.js");
const hookSource = resolve(here, "../../mcp-server/hooks/parle-hook.mjs");
const hookTarget = resolve(here, "../skills/parle/scripts/parle-hook.mjs");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
const hookSourceBytes = readFileSync(hookSource);
const hookTargetBytes = readFileSync(hookTarget);
if (!sourceBytes.equals(targetBytes) || !hookSourceBytes.equals(hookTargetBytes)) {
  throw new Error("Command Code MCP or hook artifact is stale. Rebuild the MCP server and Command Code adapter.");
}
