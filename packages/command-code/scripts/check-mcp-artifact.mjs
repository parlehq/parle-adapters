import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../skills/parle/server/parle-mcp.js");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
if (!sourceBytes.equals(targetBytes)) {
  throw new Error("Command Code MCP artifact is stale. Rebuild the MCP server and Command Code adapter.");
}
