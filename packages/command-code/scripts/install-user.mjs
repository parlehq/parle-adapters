import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const home = homedir();
const sourceArtifact = resolve(packageRoot, "dist/parle-mcp.js");
const sourceSkill = resolve(packageRoot, "skills/parle/SKILL.md");
const installedArtifact = resolve(home, ".local/share/parle/command-code/parle-mcp.js");
const installedSkill = resolve(home, ".commandcode/skills/parle/SKILL.md");
const userConfig = resolve(home, ".commandcode/mcp.json");

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function filesEqual(left, right) {
  return existsSync(left) && readFileSync(left).equals(readFileSync(right));
}

function copyAtomic(source, target) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.new-${process.pid}`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (!existsSync(sourceArtifact) || !existsSync(sourceSkill)) {
  throw new Error("Command Code adapter is not built. Build the MCP server and adapter first.");
}

const config = readJson(userConfig);
const existingServer = config.mcpServers?.parle;
const expectedArgs = [installedArtifact];
const serverMatches = existingServer?.transport === "stdio"
  && existingServer?.command === "node"
  && JSON.stringify(existingServer?.args) === JSON.stringify(expectedArgs);

if (existingServer && !serverMatches) {
  throw new Error(`A different user-scoped Parle MCP entry already exists in ${userConfig}. Remove or rename it before installing.`);
}
if (existsSync(installedSkill) && !filesEqual(sourceSkill, installedSkill)) {
  throw new Error(`A different Command Code Parle skill already exists at ${installedSkill}. Remove or rename it before installing.`);
}

copyAtomic(sourceArtifact, installedArtifact);
copyAtomic(sourceSkill, installedSkill);

if (!existingServer) {
  const result = spawnSync("cmd", ["mcp", "add", "-s", "user", "parle", "--", "node", installedArtifact], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`Command Code could not register the Parle MCP server: ${detail}`);
  }
}

writeFileSync(resolve(home, ".local/share/parle/command-code/INSTALLATION"), "Managed by @parlehq/command-code-adapter 0.1.3\n", { mode: 0o600 });
console.log("Installed Parle for Command Code at user scope.");
console.log("Restart Command Code, then run /mcp or cmd mcp get parle to verify.");
