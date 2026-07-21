import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { removeParleHooks } from "./settings.mjs";

const home = homedir();
const installRoot = resolve(home, ".local/share/parle/command-code");
const installedArtifact = resolve(installRoot, "parle-mcp.js");
const installedHook = resolve(installRoot, "parle-hook.mjs");
const installedSkillRoot = resolve(home, ".commandcode/skills/parle");
const userConfig = resolve(home, ".commandcode/mcp.json");
const userSettings = resolve(home, ".commandcode/settings.json");

function readJson(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.new-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const config = readJson(userConfig);
const server = config.mcpServers?.parle;
if (server) {
  const managed = server.transport === "stdio" && server.command === "node" && JSON.stringify(server.args) === JSON.stringify([installedArtifact]);
  if (!managed) throw new Error("Refusing to remove a Parle MCP entry that is not managed by this adapter.");
  delete config.mcpServers.parle;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  writeJsonAtomic(userConfig, config);
}

if (existsSync(userSettings)) writeJsonAtomic(userSettings, removeParleHooks(readJson(userSettings), installedHook));
rmSync(installedSkillRoot, { recursive: true, force: true });
rmSync(installRoot, { recursive: true, force: true });
console.log("Removed the managed Parle Command Code adapter, hooks, skill, and MCP entry.");
