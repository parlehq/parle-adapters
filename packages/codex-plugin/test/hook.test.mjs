import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

function withoutAmbientParle(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("PARLE_")));
}

function runProcess(executable, args, options, payload) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

function runHook(script, args, env, payload) {
  return runProcess(process.execPath, [script, ...args], { env }, payload);
}

test("Codex launcher is fail-open without a runtime handle", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-parle-launcher-empty-"));
  try {
    const result = await runProcess("/bin/sh", [resolve("hooks/run-parle-hook.sh"), "--scope", "codex-plugin"], {
      env: { ...withoutAmbientParle(), HOME: home, PLUGIN_ROOT: resolve(".") },
    }, { session_id: "codex-thread", hook_event_name: "Stop" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex launcher is fail-open for malformed, dead, and non-executable handles", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-parle-launcher-invalid-"));
  const stateDir = join(home, ".local", "state", "parle", "hook-bridge", "b52cc0f7fef9d88d");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const executable = join(home, "runtime");
  const nonExecutable = join(home, "not-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 90\n", { mode: 0o700 });
  writeFileSync(nonExecutable, "#!/bin/sh\nexit 90\n", { mode: 0o600 });
  symlinkSync(executable, join(stateDir, "malformed.node"));
  symlinkSync(executable, join(stateDir, "99999999.node"));
  symlinkSync(nonExecutable, join(stateDir, `${process.pid}.node`));
  try {
    const result = await runProcess("/bin/sh", [resolve("hooks/run-parle-hook.sh"), "--scope", "codex-plugin"], {
      env: { ...withoutAmbientParle(), HOME: home, PLUGIN_ROOT: resolve(".") },
    }, { session_id: "codex-thread", hook_event_name: "Stop" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`Codex hook command fails open outside a missing or unusable plugin root under ${shell}`, async (context) => {
    if (!existsSync(shell)) {
      context.skip(`${shell} is unavailable`);
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "codex-parle-missing-plugin-root-"));
    const hooks = JSON.parse(readFileSync(resolve("hooks/hooks.json"), "utf8"));
    const unusableRoot = join(home, "unusable-plugin");
    mkdirSync(join(unusableRoot, "hooks"), { recursive: true, mode: 0o700 });
    writeFileSync(join(unusableRoot, "hooks", "run-parle-hook.sh"), "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o600 });
    try {
      for (const [hookEventName, definitions] of Object.entries(hooks.hooks)) {
        const command = definitions[0].hooks[0].command;
        for (const pluginRoot of [undefined, join(home, "deleted-plugin"), unusableRoot]) {
          const env = { ...withoutAmbientParle(), HOME: home };
          if (pluginRoot !== undefined) env.PLUGIN_ROOT = pluginRoot;
          const result = await runProcess(shell, ["-lc", command], { env }, {
            session_id: "codex-thread",
            hook_event_name: hookEventName,
          });
          assert.equal(result.code, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), {});
          assert.equal(result.stdout.trim().split("\n").length, 1);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("Codex launcher deterministically selects the first live runtime handle", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-parle-launcher-order-"));
  const stateDir = join(home, ".local", "state", "parle", "hook-bridge", "b52cc0f7fef9d88d");
  const marker = join(home, "selected");
  const [firstPid, secondPid] = [String(process.pid), String(process.ppid)].sort();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const firstRuntime = join(home, "first-runtime");
  const secondRuntime = join(home, "second-runtime");
  writeFileSync(firstRuntime, `#!/bin/sh\nprintf '%s' first > \"${marker}\"\nprintf '{}\\n'\n`, { mode: 0o700 });
  writeFileSync(secondRuntime, `#!/bin/sh\nprintf '%s' second > \"${marker}\"\nprintf '{}\\n'\n`, { mode: 0o700 });
  symlinkSync(firstRuntime, join(stateDir, `${firstPid}.node`));
  symlinkSync(secondRuntime, join(stateDir, `${secondPid}.node`));
  try {
    const result = await runProcess("/bin/sh", [resolve("hooks/run-parle-hook.sh"), "--scope", "codex-plugin"], {
      env: { ...withoutAmbientParle(), HOME: home, PLUGIN_ROOT: resolve(".") },
    }, { session_id: "codex-thread", hook_event_name: "Stop" });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(readFileSync(marker, "utf8"), "first");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`Codex hook command survives ${shell} login startup and hostile PATH`, async (context) => {
    if (!existsSync(shell)) {
      context.skip(`${shell} is unavailable`);
      return;
    }
    const home = mkdtempSync(join(tmpdir(), "codex-parle-login-shell-"));
    const pluginRoot = join(home, "plugin root");
    const hooksDir = join(pluginRoot, "hooks");
    const distDir = join(pluginRoot, "dist");
    const stateDir = join(home, ".local", "state", "parle", "hook-bridge", "b52cc0f7fef9d88d");
    const hostileBin = join(home, "hostile", "shims");
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    mkdirSync(distDir, { recursive: true, mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(hostileBin, { recursive: true, mode: 0o700 });
    symlinkSync(resolve("hooks/run-parle-hook.sh"), join(hooksDir, "run-parle-hook.sh"));
    symlinkSync(resolve("hooks/parle-hook.mjs"), join(hooksDir, "parle-hook.mjs"));
    symlinkSync(resolve("dist/parle-mcp.js"), join(distDir, "parle-mcp.js"));
    symlinkSync(process.execPath, join(stateDir, `${process.pid}.node`));
    writeFileSync(join(hostileBin, "node"), "#!/bin/sh\nexit 91\n", { mode: 0o700 });
    writeFileSync(join(home, ".bash_profile"), `export PATH=\"${hostileBin}:$PATH\"\nprintf '%s\\n' login-diagnostic >&2\n`);
    writeFileSync(join(home, ".zprofile"), `export PATH=\"${hostileBin}:$PATH\"\nprintf '%s\\n' login-diagnostic >&2\n`);
    const project = join(home, "project");
    mkdirSync(project, { recursive: true, mode: 0o700 });
    writeFileSync(join(project, ".mise.toml"), "[tools]\nnode = \"24\"\n");
    const hooks = JSON.parse(readFileSync(resolve("hooks/hooks.json"), "utf8"));
    const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
    const sessionStartCommand = hooks.hooks.SessionStart[0].hooks[0].command;
    try {
      for (const hookEventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
        const result = await runProcess(shell, ["-lc", command], {
          cwd: project,
          env: {
            ...withoutAmbientParle(),
            HOME: home,
            ZDOTDIR: home,
            PLUGIN_ROOT: pluginRoot,
            PATH: `${hostileBin}:${process.env.PATH}`,
          },
        }, {
          cwd: project,
          session_id: "codex-thread",
          hook_event_name: hookEventName,
        });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {});
      }
      {
        // SessionStart (including Codex 0.146's compact source) is the peers
        // boundary: the block renders even for an empty store so missing
        // context stays actionable.
        const result = await runProcess(shell, ["-lc", sessionStartCommand], {
          cwd: project,
          env: {
            ...withoutAmbientParle(),
            HOME: home,
            ZDOTDIR: home,
            PLUGIN_ROOT: pluginRoot,
            PARLE_ROOM_ID: "019f2946-aef5-77ad-a41d-747ce0fd6a1e",
            PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
            PATH: `${hostileBin}:${process.env.PATH}`,
          },
        }, {
          cwd: project,
          session_id: "codex-thread",
          hook_event_name: "SessionStart",
        });
        assert.equal(result.code, 0, result.stderr);
        const parsed = JSON.parse(result.stdout);
        assert.match(parsed.hookSpecificOutput.additionalContext, /\[Parle known-address context\]/);
        assert.match(parsed.hookSpecificOutput.additionalContext, /No active known addresses/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("Codex Windows launcher argument chain renders SessionStart known-address context without a live bridge", async () => {
  // run-parle-hook.cmd cannot execute on this platform; its contribution is
  // trusted runtime discovery. This drives the exact argv it builds with no
  // hook-bridge state anywhere, proving the SessionStart registry block
  // renders from the script alone.
  const home = mkdtempSync(join(tmpdir(), "codex-parle-windows-chain-"));
  const parleDir = join(home, ".parle");
  mkdirSync(parleDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(parleDir, "registry"), `${JSON.stringify({
    version: 1,
    entries: [{ apiOrigin: "https://api.parle.sh", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", address: "@gilman.galexc.lead", continuity: "durable", expiresAt: "2099-01-01T00:00:00.000Z" }],
  }, null, 2)}\n`, { mode: 0o600 });
  const env = { ...withoutAmbientParle(), HOME: home, PARLE_ROOM_ID: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", PARLE_ROOM_AGENT_TOKEN: "parle_agt_test" };
  delete env.PARLE_PROFILES_PATH;
  try {
    const launcher = readFileSync(resolve("hooks/run-parle-hook.cmd"), "utf8");
    assert.match(launcher, /"%PLUGIN_ROOT%\\hooks\\parle-hook\.mjs" %\*/);
    const result = await runHook(resolve("hooks/parle-hook.mjs"), ["--scope", "codex-plugin", "--known-address-context"], env, {
      cwd: "/tmp/codex-project",
      session_id: "codex-thread",
      hook_event_name: "SessionStart",
      source: "compact",
    });
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.hookSpecificOutput.additionalContext, /\[Parle known-address context\]/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /@gilman\.galexc\.lead/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /durable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const hookEventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
  test(`Codex ${hookEventName} hook returns valid JSON when no delivery is queued`, async () => {
    const home = join("/tmp", `codex-parle-empty-hook-${hookEventName}-${process.pid}`);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      const script = resolve("hooks/parle-hook.mjs");
      const result = await runHook(script, ["--scope", "codex-plugin"], { ...withoutAmbientParle(), HOME: home }, {
        cwd: "/tmp/codex-project",
        session_id: "codex-thread",
        hook_event_name: hookEventName,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: "malformed input", args: ["--scope", "codex-plugin"], input: "{" },
  { name: "unknown argument", args: ["--unknown"], input: {} },
]) {
  test(`Codex hook fails open on ${scenario.name}`, async () => {
    const result = await runHook(resolve("hooks/parle-hook.mjs"), scenario.args, withoutAmbientParle(), scenario.input);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /failed open/);
  });
}

test("Codex hook preserves one valid output when commit fails", async () => {
  const home = mkdtempSync("/tmp/codex-parle-commit-");
  const scope = "codex-plugin";
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  const stateDir = join(home, ".local", "state", "parle", "hook-bridge", key);
  const socketPath = join(stateDir, `${process.pid}.sock`);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(input.slice(0, newline));
      if (command.action === "take") {
        socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-1", messages: [{ seq: 8, event_id: "evt-8", content: "server-framed content" }] })}\n`);
      } else if (command.action === "commit") {
        socket.end(`${JSON.stringify({ ok: false, error: "ack failed" })}\n`);
      }
    });
  });
  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolveListen);
    });
    chmodSync(socketPath, 0o600);
    const result = await runHook(resolve("hooks/parle-hook.mjs"), ["--scope", scope], { ...withoutAmbientParle(), HOME: home }, {
      cwd: "/tmp/codex-project",
      session_id: "codex-thread",
      hook_event_name: "PostToolUse",
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(result.stderr, /failed open/);
    assert.equal(result.stdout.trim().split("\n").length, 1);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(home, { recursive: true, force: true });
  }
});

for (const hookEventName of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
  test(`Codex ${hookEventName} hook injects a pre-bound delivery and commits after output`, async () => {
    const home = join("/tmp", `codex-parle-hook-${hookEventName}-${process.pid}`);
    const scope = "codex-plugin";
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
    const stateDir = join(home, ".local", "state", "parle", "hook-bridge", key);
    const socketPath = join(stateDir, `${process.pid}.sock`);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    let committed = false;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const command = JSON.parse(input.slice(0, newline));
        if (command.action === "take") {
          assert.equal(command.sessionId, "codex-thread");
          socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-1", messages: [{ seq: 4, event_id: "evt-4", content: "trusted preamble\n«FENCE BEGIN TOKEN»\nuntrusted peer body\n«FENCE END TOKEN»", clientReplyPresentation: { lines: ["reply_route_id: 018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61", "reply_instruction: call parle_reply"] } }] })}\n`);
        } else if (command.action === "commit") {
          committed = command.leaseId === "lease-1";
          socket.end(`${JSON.stringify({ ok: true, committed: 1 })}\n`);
        } else {
          socket.end(`${JSON.stringify({ ok: false })}\n`);
        }
      });
    });
    try {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolveListen);
      });
      chmodSync(socketPath, 0o600);
      const script = resolve("hooks/parle-hook.mjs");
      const result = await runHook(script, ["--scope", scope], { ...withoutAmbientParle(), HOME: home }, {
        cwd: "/tmp/codex-project",
        session_id: "codex-thread",
        hook_event_name: hookEventName,
        ...(hookEventName === "Stop" ? { stop_hook_active: false } : {}),
      });
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      if (hookEventName === "Stop") {
        assert.equal(output.decision, "block");
        assert.match(output.reason, /server-framed room message/);
        assert.match(output.reason, /«FENCE BEGIN TOKEN»/);
        assert.match(output.reason, /reply_route_id: 018f9c1e/);
        assert.match(output.reason, /call parle_reply/);
      } else {
        assert.equal(output.hookSpecificOutput.hookEventName, hookEventName);
        assert.match(output.hookSpecificOutput.additionalContext, /server-framed room message/);
        assert.match(output.hookSpecificOutput.additionalContext, /reply_route_id: 018f9c1e/);
        assert.match(output.hookSpecificOutput.additionalContext, /call parle_reply/);
        assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
      }
      assert.equal(committed, true);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  test(`Codex hook correlates to the owning process through the ${shell} login-shell chain, binds the thread, and delivers (#174)`, async (context) => {
    if (!existsSync(shell)) {
      context.skip(`${shell} is unavailable`);
      return;
    }
    // This test process stands in for Codex: it owns the bridge directory
    // keyed by its pid, and the hook reaches it from three processes down
    // (login shell -> launcher -> node) by walking ancestry.
    const home = mkdtempSync("/tmp/codex-parle-ancestry-");
    const pluginRoot = join(home, "plugin");
    const hooksDir = join(pluginRoot, "hooks");
    const stateDir = join(home, ".local", "state", "parle", "hook-bridge", "b52cc0f7fef9d88d");
    const hostDir = join(stateDir, String(process.pid));
    const ownerPid = process.pid + 1;
    const socketPath = join(hostDir, `${ownerPid}.sock`);
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    symlinkSync(resolve("hooks/run-parle-hook.sh"), join(hooksDir, "run-parle-hook.sh"));
    symlinkSync(resolve("hooks/parle-hook.mjs"), join(hooksDir, "parle-hook.mjs"));
    symlinkSync(process.execPath, join(stateDir, `${process.pid}.node`));
    const commands = [];
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const command = JSON.parse(input.slice(0, newline));
        commands.push(command);
        if (command.action === "status") {
          socket.end(`${JSON.stringify({ ok: true, running: true, ownerPid, hostParentPid: process.pid, currentParentPid: process.pid, hostSessionBound: false, waiterAttached: false, agentSessionId: "as-1" })}\n`);
        } else if (command.action === "bind") {
          socket.end(`${JSON.stringify({ ok: true, bound: true })}\n`);
        } else if (command.action === "take") {
          socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-174", messages: [{ seq: 12, event_id: "evt-12", content: "server-framed content" }] })}\n`);
        } else if (command.action === "commit") {
          socket.end(`${JSON.stringify({ ok: true, committed: 1 })}\n`);
        } else {
          socket.end(`${JSON.stringify({ ok: false })}\n`);
        }
      });
    });
    const hooks = JSON.parse(readFileSync(resolve("hooks/hooks.json"), "utf8"));
    try {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolveListen);
      });
      chmodSync(socketPath, 0o600);
      for (const [hookEventName, expectedBind] of [["SessionStart", { allowReplace: true }], ["UserPromptSubmit", { allowReplace: false }], ["PostToolUse", undefined]]) {
        commands.length = 0;
        const command = hooks.hooks[hookEventName][0].hooks[0].command;
        const result = await runProcess(shell, ["-lc", command], {
          cwd: home,
          env: { ...withoutAmbientParle(), HOME: home, ZDOTDIR: home, PLUGIN_ROOT: pluginRoot },
        }, { cwd: home, session_id: "codex-thread-174", hook_event_name: hookEventName });
        assert.equal(result.code, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.hookSpecificOutput.hookEventName, hookEventName, result.stderr);
        assert.match(output.hookSpecificOutput.additionalContext, /server-framed content/);
        assert.deepEqual(commands.map((entry) => entry.action), expectedBind ? ["status", "bind", "take", "commit"] : ["status", "take", "commit"], hookEventName);
        if (expectedBind) {
          assert.equal(commands[1].sessionId, "codex-thread-174");
          assert.equal(commands[1].allowReplace, expectedBind.allowReplace, `${hookEventName} binding`);
        }
        assert.equal(commands.at(-1).leaseId, "lease-174");
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("Codex hook without a live bridge fails soft under direct-parent so SessionStart context still renders (#174)", async () => {
  const home = mkdtempSync("/tmp/codex-parle-nobridge-");
  const parleDir = join(home, ".parle");
  mkdirSync(parleDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(parleDir, "registry"), `${JSON.stringify({
    version: 1,
    entries: [{ apiOrigin: "https://api.parle.sh", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", address: "@gilman.galexc.lead", continuity: "durable", expiresAt: "2099-01-01T00:00:00.000Z" }],
  }, null, 2)}\n`, { mode: 0o600 });
  const env = { ...withoutAmbientParle(), HOME: home, PARLE_ROOM_ID: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", PARLE_ROOM_AGENT_TOKEN: "parle_agt_test" };
  delete env.PARLE_PROFILES_PATH;
  try {
    const start = await runHook(resolve("hooks/parle-hook.mjs"), ["--scope", "codex-plugin", "--direct-parent", "--shell-launched", "--bind", "--known-address-context"], env, {
      cwd: "/tmp/codex-project",
      session_id: "codex-thread",
      hook_event_name: "SessionStart",
    });
    assert.equal(start.code, 0, start.stderr);
    assert.doesNotMatch(start.stderr, /failed open/);
    assert.match(JSON.parse(start.stdout).hookSpecificOutput.additionalContext, /@gilman\.galexc\.lead/);
    const prompt = await runHook(resolve("hooks/parle-hook.mjs"), ["--scope", "codex-plugin", "--direct-parent", "--shell-launched", "--bind"], env, {
      cwd: "/tmp/codex-project",
      session_id: "codex-thread",
      hook_event_name: "UserPromptSubmit",
    });
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.deepEqual(JSON.parse(prompt.stdout), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
