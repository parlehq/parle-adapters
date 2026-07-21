#!/usr/bin/env node
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { removeParleHooks } from "./settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hook = resolve(here, "parle-hook.mjs");
const server = resolve(here, "../server/parle-mcp.js");
const userSettings = resolve(homedir(), ".commandcode/settings.json");

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

const inspection = spawnSync("cmd", ["mcp", "get", "parle"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (inspection.error || inspection.status !== 0) {
  throw new Error("The user-scoped Parle MCP registration is missing. Refusing a partial or ambiguous uninstall.");
}
if (!inspection.stdout.includes(server) || !inspection.stdout.includes("PARLE_HOST_ADAPTER=command-code")) {
  throw new Error("The MCP server named `parle` is not owned by this installed skill. Refusing to remove it.");
}

const originalSettings = existsSync(userSettings) ? JSON.parse(readFileSync(userSettings, "utf8")) : {};
const nextSettings = removeParleHooks(originalSettings, hook);
if (existsSync(userSettings)) writeJsonAtomic(userSettings, nextSettings);

const result = spawnSync("cmd", ["mcp", "remove", "--scope", "user", "parle"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.error || result.status !== 0) {
  if (existsSync(userSettings)) writeJsonAtomic(userSettings, originalSettings);
  throw new Error(`Command Code could not remove the Parle MCP server: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
}

console.log(result.stdout.trim());
console.log("Removed Parle MCP and hook configuration. Run `cmd skills remove parle --global --yes` to remove the skill files, then restart Command Code.");
