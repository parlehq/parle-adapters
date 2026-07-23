#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mergeParleHooks } from "./settings.mjs";

const MINIMUM_COMMAND_CODE = [1, 0, 0];
const here = dirname(fileURLToPath(import.meta.url));
const skill = resolve(here, "..");
const hook = resolve(here, "parle-hook.mjs");
const server = resolve(here, "../server/parle-mcp.js");
const mod = resolve(skill, "mods/parle-status.ts");
const modManifest = resolve(skill, "package.json");
const userSettings = resolve(homedir(), ".commandcode/settings.json");

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

for (const path of [hook, server, mod, modManifest]) {
  if (!existsSync(path)) throw new Error(`The installed Parle skill is incomplete: missing ${path}`);
}

const versionResult = spawnSync("cmd", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const installedVersion = versionTuple(`${versionResult.stdout || ""} ${versionResult.stderr || ""}`);
if (versionResult.error || versionResult.status !== 0 || !installedVersion || !versionAtLeast(installedVersion, MINIMUM_COMMAND_CODE)) {
  throw new Error("Command Code 1.0.0 or newer is required for the Parle footer mod and responsive delivery.");
}

const existing = spawnSync("cmd", ["mcp", "get", "parle"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (existing.error) throw new Error(`Command Code could not inspect MCP registration: ${existing.error.message}`);
if (existing.status === 0) {
  throw new Error("A user-visible MCP server named `parle` already exists. Unconfigure or remove it explicitly before installing Parle.");
}

const modResult = spawnSync("cmd", ["mods", "add", "--global", skill], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (modResult.error || modResult.status !== 0) {
  throw new Error(`Command Code could not register the Parle footer mod: ${(modResult.stderr || modResult.stdout || modResult.error?.message || "unknown error").trim()}`);
}

const settings = mergeParleHooks(readJson(userSettings), hook);
const mcpResult = spawnSync("cmd", [
  "mcp", "add",
  "--transport", "stdio",
  "--scope", "user",
  "--env", "PARLE_HOST_ADAPTER=command-code",
  "parle", "--", "node", server,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (mcpResult.error || mcpResult.status !== 0) {
  spawnSync("cmd", ["mods", "remove", "--global", skill], { stdio: "ignore" });
  throw new Error(`Command Code could not register the Parle MCP server: ${(mcpResult.stderr || mcpResult.stdout || mcpResult.error?.message || "unknown error").trim()}`);
}

try {
  writeJsonAtomic(userSettings, settings);
} catch (error) {
  spawnSync("cmd", ["mcp", "remove", "--scope", "user", "parle"], { stdio: "ignore" });
  spawnSync("cmd", ["mods", "remove", "--global", skill], { stdio: "ignore" });
  throw error;
}
console.log(modResult.stdout.trim());
console.log(mcpResult.stdout.trim());
console.log("Configured the installed Parle skill, footer mod, and responsive delivery. Restart Command Code.");
