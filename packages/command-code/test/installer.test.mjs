import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function run(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("user installer upgrades a managed MCP entry and preserves unrelated hooks", async () => {
  const home = join("/tmp", `pcc-install-${process.pid}`);
  const bin = join(home, "bin");
  const commandCode = join(bin, "cmd");
  const configPath = join(home, ".commandcode", "mcp.json");
  const settingsPath = join(home, ".commandcode", "settings.json");
  const installedArtifact = join(home, ".local", "share", "parle", "command-code", "parle-mcp.js");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".commandcode"), { recursive: true, mode: 0o700 });
  writeFileSync(commandCode, "#!/bin/sh\necho 0.52.3\n", { mode: 0o700 });
  chmodSync(commandCode, 0o700);
  writeFileSync(configPath, JSON.stringify({ mcpServers: { parle: { transport: "stdio", enabled: true, command: "node", args: [installedArtifact] } }, unrelated: true }));
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/tmp/quality-gate" }] }] } }));

  try {
    const installer = resolve("scripts/install-user.mjs");
    const result = await run(process.execPath, [installer], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.unrelated, true);
    assert.equal(config.mcpServers.parle.env.PARLE_HOST_ADAPTER, "command-code");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.Stop.some((definition) => definition.hooks.some((hook) => hook.command === "/tmp/quality-gate")), true);
    assert.equal(settings.hooks.Stop.some((definition) => definition.hooks.some((hook) => hook.command.endsWith("/parle-hook.mjs"))), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
