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

test("skill configurator uses native MCP registration and preserves unrelated hooks", async () => {
  const home = join("/tmp", `pcc-configure-${process.pid}`);
  const bin = join(home, "bin");
  const commandCode = join(bin, "cmd");
  const commandLog = join(home, "cmd-args");
  const settingsPath = join(home, ".commandcode", "settings.json");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".commandcode"), { recursive: true, mode: 0o700 });
  writeFileSync(commandCode, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.0.1; exit 0; fi\nif [ "$1 $2 $3" = "mcp get parle" ]; then exit 1; fi\nprintf '%s ' "$@" >> "${commandLog}"\nprintf '\\n' >> "${commandLog}"\necho registered\n`, { mode: 0o700 });
  chmodSync(commandCode, 0o700);
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/tmp/quality-gate" }] }] } }));

  try {
    const configure = resolve("skills/parle/scripts/configure.mjs");
    const result = await run(process.execPath, [configure], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.code, 0, result.stderr);
    const commands = readFileSync(commandLog, "utf8").trim().split("\n");
    assert.match(commands[0], /^mods add --global .*skills\/parle\s*$/);
    assert.match(commands[1], /^mcp add --transport stdio --scope user --env PARLE_HOST_ADAPTER=command-code parle -- node .*skills\/parle\/server\/parle-mcp\.js\s*$/);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.hooks.Stop.some((definition) => definition.hooks.some((hook) => hook.command === "/tmp/quality-gate")), true);
    assert.equal(settings.hooks.Stop.some((definition) => definition.hooks.some((hook) => hook.command.endsWith("/skills/parle/scripts/parle-hook.mjs"))), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skill configurator refuses to replace an existing MCP registration", async () => {
  const home = join("/tmp", `pcc-collision-${process.pid}`);
  const bin = join(home, "bin");
  const commandCode = join(bin, "cmd");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".commandcode"), { recursive: true, mode: 0o700 });
  writeFileSync(commandCode, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.0.1; exit 0; fi\nif [ \"$1 $2 $3\" = \"mcp get parle\" ]; then echo existing; exit 0; fi\nexit 99\n", { mode: 0o700 });
  try {
    const result = await run(process.execPath, [resolve("skills/parle/scripts/configure.mjs")], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /already exists/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("skill unconfigurator removes only its native MCP registration and hook entries", async () => {
  const home = join("/tmp", `pcc-unconfigure-${process.pid}`);
  const bin = join(home, "bin");
  const commandCode = join(bin, "cmd");
  const commandLog = join(home, "cmd-args");
  const settingsPath = join(home, ".commandcode", "settings.json");
  const hook = resolve("skills/parle/scripts/parle-hook.mjs");
  const server = resolve("skills/parle/server/parle-mcp.js");
  const managed = { hooks: [{ type: "command", command: hook, timeout: 5 }] };
  rmSync(home, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, ".commandcode"), { recursive: true, mode: 0o700 });
  writeFileSync(commandCode, `#!/bin/sh\nif [ "$1 $2 $3" = "mcp get parle" ]; then printf 'Args: %s\\nEnvironment:\\n  PARLE_HOST_ADAPTER=command-code\\n' "${server}"; exit 0; fi\nprintf '%s ' "$@" >> "${commandLog}"\nprintf '\\n' >> "${commandLog}"\necho removed\n`, { mode: 0o700 });
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/tmp/quality-gate" }] }, managed], SessionStart: [managed], PreToolUse: [managed], PostToolUse: [managed] } }));
  try {
    const result = await run(process.execPath, [resolve("skills/parle/scripts/unconfigure.mjs")], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.code, 0, result.stderr);
    const commands = readFileSync(commandLog, "utf8").trim().split("\n");
    assert.match(commands[0], /^mods remove --global .*skills\/parle\s*$/);
    assert.equal(commands[1].trim(), "mcp remove --scope user parle");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings, { theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "/tmp/quality-gate" }] }] } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
