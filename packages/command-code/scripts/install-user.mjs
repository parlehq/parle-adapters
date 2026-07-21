import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergeParleHooks } from "./settings.mjs";

const MINIMUM_COMMAND_CODE = [0, 52, 3];
const ADAPTER_VERSION = "0.1.9";
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const home = homedir();
const sourceArtifact = resolve(packageRoot, "dist/parle-mcp.js");
const sourceSkill = resolve(packageRoot, "skills/parle/SKILL.md");
const sourceHook = resolve(packageRoot, "hooks/parle-hook.mjs");
const installRoot = resolve(home, ".local/share/parle/command-code");
const installedArtifact = resolve(installRoot, "parle-mcp.js");
const installedHook = resolve(installRoot, "parle-hook.mjs");
const installedSkill = resolve(home, ".commandcode/skills/parle/SKILL.md");
const userConfig = resolve(home, ".commandcode/mcp.json");
const userSettings = resolve(home, ".commandcode/settings.json");
const marker = resolve(installRoot, "INSTALLATION");

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

function copyAtomic(source, target, mode = 0o600) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.new-${process.pid}`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
    chmodSync(target, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.new-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function versionTuple(raw) {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : undefined;
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

for (const source of [sourceArtifact, sourceSkill, sourceHook]) {
  if (!existsSync(source)) throw new Error("Command Code adapter is not built. Build the MCP server and adapter first.");
}

const versionResult = spawnSync("cmd", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const installedVersion = versionTuple(`${versionResult.stdout || ""} ${versionResult.stderr || ""}`);
if (versionResult.error || versionResult.status !== 0 || !installedVersion || !versionAtLeast(installedVersion, MINIMUM_COMMAND_CODE)) {
  throw new Error("Command Code 0.52.3 or newer is required for Parle SSE delivery hooks. Update Command Code, then rerun the installer.");
}

const managedInstall = existsSync(marker) && readFileSync(marker, "utf8").startsWith("Managed by @parlehq/command-code-adapter ");
const config = readJson(userConfig);
config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
const existingServer = config.mcpServers.parle;
const knownServer = existingServer?.transport === "stdio"
  && existingServer?.command === "node"
  && JSON.stringify(existingServer?.args) === JSON.stringify([installedArtifact]);
if (existingServer && !knownServer) {
  throw new Error(`A different user-scoped Parle MCP entry already exists in ${userConfig}. Remove or rename it before installing.`);
}
if (existsSync(installedSkill) && !filesEqual(sourceSkill, installedSkill) && !managedInstall) {
  throw new Error(`A different Command Code Parle skill already exists at ${installedSkill}. Remove or rename it before installing.`);
}
if (existingServer?.env?.PARLE_HOST_ADAPTER && existingServer.env.PARLE_HOST_ADAPTER !== "command-code") {
  throw new Error("The existing Parle MCP entry sets a conflicting PARLE_HOST_ADAPTER value.");
}

copyAtomic(sourceArtifact, installedArtifact);
copyAtomic(sourceSkill, installedSkill);
copyAtomic(sourceHook, installedHook, 0o700);

config.mcpServers.parle = {
  ...(existingServer || {}),
  transport: "stdio",
  enabled: existingServer?.enabled !== false,
  command: "node",
  args: [installedArtifact],
  env: { ...(existingServer?.env || {}), PARLE_HOST_ADAPTER: "command-code" },
};
writeJsonAtomic(userConfig, config);
writeJsonAtomic(userSettings, mergeParleHooks(readJson(userSettings), installedHook));
writeFileSync(marker, `Managed by @parlehq/command-code-adapter ${ADAPTER_VERSION}\n`, { mode: 0o600 });

console.log("Installed Parle for Command Code at user scope with SSE responsive delivery hooks.");
console.log("Restart Command Code, then run /mcp or cmd mcp get parle to verify.");
