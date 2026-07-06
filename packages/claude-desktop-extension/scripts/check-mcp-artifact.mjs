import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../server/parle-mcp.js");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
if (!sourceBytes.equals(targetBytes)) {
  throw new Error("Claude Desktop MCPB artifact is stale. Run pnpm -F @parlehq/claude-desktop-extension build after rebuilding @parlehq/mcp-server.");
}
