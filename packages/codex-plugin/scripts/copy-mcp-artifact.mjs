import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../dist/parle-mcp.js");

const sourceStat = statSync(source);
if (!sourceStat.isFile() || sourceStat.size === 0) {
  throw new Error(`Missing MCP artifact at ${source}`);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
