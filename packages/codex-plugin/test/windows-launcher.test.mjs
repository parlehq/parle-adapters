import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

// Behavioral proof for the Codex Windows wiring: these tests run
// the exact commandWindows string from hooks.json through cmd's /d /s /c
// execution shape - the same wrapping Codex applies - against the real
// run-parle-hook.cmd, with a plugin root containing spaces, a hostile cwd and
// PATH, and no hook-bridge state anywhere. They execute only on Windows; the
// POSIX suite covers the sh launcher.
const onWindows = process.platform === "win32";

function withoutAmbientParle(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PARLE_")));
}

const commandWindows = (() => {
  const hooks = JSON.parse(readFileSync(resolve(pkgRoot, "hooks/hooks.json"), "utf8"));
  const literal = hooks.hooks.SessionStart[0].hooks[0].commandWindows;
  // Strip the leading interpreter: Codex hands the full literal to cmd, and
  // spawn(..., { shell: true }) re-applies exactly that cmd /d /s /c wrapper.
  return literal.replace(/^cmd \/d \/s \/c "/, "").replace(/"$/, "");
})();

function runLauncher({ env, cwd }, payload) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(commandWindows, [], { shell: true, env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "codex-parle-win-"));
  // The plugin root deliberately contains a space to exercise quoting through
  // the whole cmd chain.
  const pluginRoot = join(base, "plugin root");
  const hooksDir = join(pluginRoot, "hooks");
  const distDir = join(pluginRoot, "dist");
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  for (const name of ["parle-hook.mjs", "run-parle-hook.cmd"]) {
    cpSync(resolve(pkgRoot, "hooks", name), join(hooksDir, name));
  }
  cpSync(resolve(pkgRoot, "dist", "parle-mcp.js"), join(distDir, "parle-mcp.js"));
  const home = join(base, "home");
  mkdirSync(join(home, ".parle"), { recursive: true });
  writeFileSync(join(home, ".parle", "registry"), `${JSON.stringify({
    version: 1,
    entries: [{ apiOrigin: "https://api.parle.sh", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", address: "@gilman.galexc.lead", continuity: "durable", expiresAt: "2099-01-01T00:00:00.000Z" }],
  }, null, 2)}\n`);
  // Hostile PATH entry and a hostile cwd holding a real, runnable node.exe at
  // a relative location: if the launcher ever resolved a relative override or
  // consulted PATH, this runtime would execute and render.
  const hostilePath = join(base, "hostile-path");
  const hostileCwd = join(base, "hostile-cwd");
  mkdirSync(hostilePath, { recursive: true });
  mkdirSync(join(hostileCwd, "evil"), { recursive: true });
  cpSync(process.execPath, join(hostileCwd, "node.exe"));
  cpSync(process.execPath, join(hostileCwd, "evil", "node.exe"));
  cpSync(process.execPath, join(hostilePath, "node.exe"));
  const empty = join(base, "empty");
  mkdirSync(empty, { recursive: true });
  return { base, pluginRoot, home, hostilePath, hostileCwd, empty };
}

// Windows environment names are case-insensitive, and the inherited block
// often uses different casing (LOCALAPPDATA vs LocalAppData). A plain object
// spread would leave both variants in the child block and cmd could resolve
// the inherited one, so every override first deletes all case-variants.
function setEnvCaseInsensitive(env, key, value) {
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
  }
  if (value !== undefined) env[key] = value;
}

// cmd.exe re-derives %ProgramFiles% from ProgramW6432 when they disagree,
// so neutralizing the fallback locations must override that root too.
function emptyFallbacks(fixture) {
  return {
    ProgramFiles: fixture.empty,
    "ProgramFiles(x86)": fixture.empty,
    ProgramW6432: fixture.empty,
    LocalAppData: fixture.empty,
  };
}

function launcherEnv(fixture, overrides = {}) {
  const env = withoutAmbientParle();
  const values = {
    PLUGIN_ROOT: fixture.pluginRoot,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    PATH: `${fixture.hostilePath};${process.env.PATH ?? ""}`,
    PARLE_ROOM_ID: "019f2946-aef5-77ad-a41d-747ce0fd6a1e",
    PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) setEnvCaseInsensitive(env, key, value);
  setEnvCaseInsensitive(env, "PARLE_PROFILES_PATH", undefined);
  if (!("PARLE_HOOK_RUNTIME" in overrides)) setEnvCaseInsensitive(env, "PARLE_HOOK_RUNTIME", undefined);
  return env;
}

const sessionStart = { cwd: "C:\\codex-project", session_id: "codex-thread", hook_event_name: "SessionStart", source: "compact" };

function runRaw(command, { env, cwd }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [], { shell: true, env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("Windows child cmd sees the overridden fallback locations", { skip: !onWindows }, async (t) => {
  const fixture = setup();
  try {
    const env = launcherEnv(fixture, emptyFallbacks(fixture));
    const probe = await runRaw('echo PF=[%ProgramFiles%] X86=[%ProgramFiles(x86)%] LAD=[%LocalAppData%] RT=[%PARLE_HOOK_RUNTIME%]', { env, cwd: fixture.hostileCwd });
    t.diagnostic(`env probe: ${JSON.stringify(probe.stdout)}`);
    assert.match(probe.stdout, new RegExp(`PF=\\[${fixture.empty.replace(/[\\.]/g, "\\$&")}\\]`));
    // Trace the launcher with echo enabled so a wrong branch is visible in
    // the CI log: same launcher minus its @echo off line.
    const traced = join(fixture.pluginRoot, "hooks", "traced.cmd");
    writeFileSync(traced, readFileSync(join(fixture.pluginRoot, "hooks", "run-parle-hook.cmd"), "utf8").replace(/^@echo off\r?\n/, ""));
    const trace = await runRaw(`"${traced}" --scope codex-plugin`, { env, cwd: fixture.hostileCwd });
    t.diagnostic(`launcher trace stdout: ${JSON.stringify(trace.stdout.slice(0, 4000))}`);
    t.diagnostic(`launcher trace stderr: ${JSON.stringify(trace.stderr.slice(0, 2000))}`);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("Windows commandWindows renders SessionStart known-address context via an absolute override", { skip: !onWindows }, async () => {
  const fixture = setup();
  try {
    // Fallback locations are pointed at an empty directory, so a render here
    // can only have come through the absolute override.
    const result = await runLauncher({
      env: launcherEnv(fixture, { PARLE_HOOK_RUNTIME: process.execPath, ...emptyFallbacks(fixture) }),
      cwd: fixture.hostileCwd,
    }, sessionStart);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[Parle known-address context\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /@gilman\.galexc\.lead/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /durable/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("Windows commandWindows renders SessionStart known-address context via the %ProgramFiles% fallback", { skip: !onWindows }, async () => {
  const fixture = setup();
  try {
    // A constructed Program Files (with a space in the path) holding the real
    // runtime proves the fixed-absolute-path fallback renders with no
    // override and no bridge state.
    const programFiles = join(fixture.base, "Program Files");
    mkdirSync(join(programFiles, "nodejs"), { recursive: true });
    cpSync(process.execPath, join(programFiles, "nodejs", "node.exe"));
    const result = await runLauncher({
      env: launcherEnv(fixture, {
        ...emptyFallbacks(fixture),
        ProgramFiles: programFiles,
        ProgramW6432: programFiles,
      }),
      cwd: fixture.hostileCwd,
    }, sessionStart);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /@gilman\.galexc\.lead/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /durable/);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

for (const override of ["node.exe", "evil\\node.exe", "C:evil\\node.exe"]) {
  test(`Windows launcher rejects the relative runtime override ${override}`, { skip: !onWindows }, async () => {
    const fixture = setup();
    try {
      // The override resolves to a real runnable node.exe relative to the
      // hostile cwd; every fallback location is empty. A launcher that
      // resolved relative values would render registry context here, so the
      // fail-open {} is the rejection proof.
      const result = await runLauncher({
        env: launcherEnv(fixture, { PARLE_HOOK_RUNTIME: override, ...emptyFallbacks(fixture) }),
        cwd: fixture.hostileCwd,
      }, sessionStart);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  });
}

test("Windows launcher fails open when no trusted runtime exists", { skip: !onWindows }, async () => {
  const fixture = setup();
  try {
    const result = await runLauncher({
      env: launcherEnv(fixture, emptyFallbacks(fixture)),
      cwd: fixture.hostileCwd,
    }, sessionStart);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test("Windows launcher falls through an absolute but missing override to the fallbacks", { skip: !onWindows }, async () => {
  const fixture = setup();
  try {
    // Mirrors run-parle-hook.sh: an absolute override that does not exist is
    // skipped, not fatal; with empty fallbacks the launcher fails open.
    const missing = join(fixture.empty, "nope", "node.exe");
    assert.equal(existsSync(missing), false);
    const result = await runLauncher({
      env: launcherEnv(fixture, { PARLE_HOOK_RUNTIME: missing, ...emptyFallbacks(fixture) }),
      cwd: fixture.hostileCwd,
    }, sessionStart);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});
