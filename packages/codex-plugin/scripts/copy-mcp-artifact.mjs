import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../dist/parle-mcp.js");
const hookSource = resolve(here, "../../mcp-server/hooks/parle-hook.mjs");
const hookTarget = resolve(here, "../hooks/parle-hook.mjs");

const sourceStat = statSync(source);
const hookSourceStat = statSync(hookSource);
if (!sourceStat.isFile() || sourceStat.size === 0 || !hookSourceStat.isFile() || hookSourceStat.size === 0) {
  throw new Error(`Missing MCP artifact at ${source}`);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
mkdirSync(dirname(hookTarget), { recursive: true });
copyFileSync(hookSource, hookTarget);
chmodSync(hookTarget, 0o755);
