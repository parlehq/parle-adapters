import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

function runHook(script, args, env, payload) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

for (const hookEventName of ["PostToolUse", "Stop"]) {
  test(`Codex ${hookEventName} hook returns valid JSON when no delivery is queued`, async () => {
    const home = join("/tmp", `codex-parle-empty-hook-${hookEventName}-${process.pid}`);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      const script = resolve("hooks/parle-hook.mjs");
      const result = await runHook(script, ["--scope", "codex-plugin"], { ...process.env, HOME: home }, {
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

test("Codex hook injects a pre-bound delivery and commits after output", async () => {
  const home = join("/tmp", `codex-parle-hook-${process.pid}`);
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
        socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-1", messages: [{ seq: 4, event_id: "evt-4", content: "trusted preamble\n«FENCE BEGIN TOKEN»\nuntrusted peer body\n«FENCE END TOKEN»" }] })}\n`);
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
    const result = await runHook(script, ["--scope", scope], { ...process.env, HOME: home }, {
      cwd: "/tmp/codex-project",
      session_id: "codex-thread",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /server-framed room message/);
    assert.match(output.reason, /«FENCE BEGIN TOKEN»/);
    assert.equal(committed, true);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(home, { recursive: true, force: true });
  }
});
