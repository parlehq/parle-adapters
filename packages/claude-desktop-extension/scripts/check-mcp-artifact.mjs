import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../mcp-server/dist/parle-mcp.js");
const target = resolve(here, "../server/parle-mcp.js");

const sourceBytes = readFileSync(source);
const targetBytes = readFileSync(target);
const manifest = JSON.parse(readFileSync(resolve(here, "../manifest.json"), "utf8"));
const packageManifest = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
if (manifest.version !== packageManifest.version) throw new Error("Claude Desktop manifest and package versions differ.");
if (manifest.server?.mcp_config?.env?.PARLE_INTEGRATION_NAME !== "@parlehq/claude-desktop-extension") throw new Error("Claude Desktop integration name is missing.");
if (manifest.server?.mcp_config?.env?.PARLE_INTEGRATION_VERSION !== manifest.version) throw new Error("Claude Desktop integration version is stale.");
if (!sourceBytes.equals(targetBytes)) {
  throw new Error("Claude Desktop MCPB artifact is stale. Run pnpm -F @parlehq/claude-desktop-extension build after rebuilding @parlehq/mcp-server.");
}
