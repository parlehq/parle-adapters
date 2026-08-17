// Claude host delivery semantics for the hook bridge (parlehq/parle-adapters#117).
// These drive the real hook entrypoint against a stub bridge socket, so they
// cover what the Claude plugin actually ships: binding, route-bearing injection,
// per-event output shape, and acknowledgement that follows successful output.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HOOK = resolve(root, "hooks/parle-hook.mjs");
const CLAUDE_ARGS = ["--bind", "--direct-parent"];
const ROUTE_ID = "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61";

function stateDir(scope) {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "parle", "hook-bridge", key);
}

let nextOwnerPid = 900_000_000;

// A stub bridge that records every action and answers with a scripted reply.
function startBridge(scope, { messages, commitOk = true, hostParentPid = process.pid, reportedParentPid = hostParentPid, initialSessionId } = {}) {
  const ownerPid = nextOwnerPid++;
  const dir = join(stateDir(scope), String(hostParentPid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${ownerPid}.sock`);
  rmSync(path, { force: true });
  const actions = [];
  let boundSessionId = initialSessionId;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      actions.push(command);
      if (command.action === "status") {
        return void socket.end(`${JSON.stringify({ ok: true, running: true, ownerPid, hostParentPid: reportedParentPid, currentParentPid: reportedParentPid })}\n`);
      }
      if (command.action === "bind") {
        const ok = !boundSessionId || boundSessionId === command.sessionId || command.allowReplace === true;
        if (ok) boundSessionId = command.sessionId;
        return void socket.end(`${JSON.stringify({ ok, bound: Boolean(boundSessionId) })}\n`);
      }
      if (command.action === "take" && command.sessionId === boundSessionId) return void socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-1", messages })}\n`);
      if (command.action === "commit" && command.sessionId === boundSessionId) return void socket.end(`${JSON.stringify(commitOk ? { ok: true, committed: messages.length } : { ok: false })}\n`);
      socket.end(`${JSON.stringify({ ok: false })}\n`);
    });
  });
  return new Promise((resolveReady) => {
    server.listen(path, () => resolveReady({
      actions,
      path,
      async stop() {
        await new Promise((done) => server.close(done));
        rmSync(path, { force: true });
      },
    }));
  });
}

function runHook(args, payload, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(process.execPath, [HOOK, ...args], { env: { ...process.env, ...env } },
      (error, stdout, stderr) => error ? reject(error) : resolveRun({ stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function prepareHookHost(args = CLAUDE_ARGS) {
  const wrapper = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, [process.env.PARLE_TEST_HOOK, ...JSON.parse(process.env.PARLE_TEST_HOOK_ARGS)], { env: process.env });
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on("exit", (code) => { process.exitCode = code; });
  `;
  const host = spawn(process.execPath, ["-e", wrapper], {
    env: { ...process.env, PARLE_TEST_HOOK: HOOK, PARLE_TEST_HOOK_ARGS: JSON.stringify(args) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    pid: host.pid,
    run(payload) {
      let stdout = "";
      let stderr = "";
      host.stdout.on("data", (chunk) => (stdout += chunk));
      host.stderr.on("data", (chunk) => (stderr += chunk));
      host.stdin.end(JSON.stringify(payload));
      return new Promise((resolveRun, reject) => {
        host.once("error", reject);
        host.once("exit", (code) => code === 0 ? resolveRun({ stdout, stderr }) : reject(new Error(stderr || `hook host exited ${code}`)));
      });
    },
  };
}

function deliveredRow(seq) {
  return {
    seq,
    event_id: `evt-${seq}`,
    content: "trusted preamble\n«FENCE BEGIN TOKEN»\nuntrusted peer body\n«FENCE END TOKEN»",
    clientReplyPresentation: {
      routeState: "available",
      lines: [`reply_route_id: ${ROUTE_ID}`, "reply_instruction: call parle_reply with replyRouteId"],
    },
  };
}

async function withBridge(options, body) {
  const cwd = mkdtempSync(join(tmpdir(), "parle-claude-delivery-"));
  const bridge = await startBridge(cwd, options);
  try {
    return await body({ cwd, bridge });
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("an injected delivery carries the opaque reply route into model context", async () => {
  await withBridge({ messages: [deliveredRow(7)] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd });
    const output = JSON.parse(stdout);

    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, new RegExp(`reply_route_id: ${ROUTE_ID}`));
    assert.match(context, /call parle_reply with replyRouteId/);
    // Server framing must survive injection intact, fences included.
    assert.match(context, /«FENCE BEGIN TOKEN»/);
    assert.match(context, /untrusted/);
    assert.match(context, /Parle responsive delivery seq=7 event_id=evt-7/);

    // Bind precedes the lease, and the row is acknowledged only after output.
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  });
});

test("Stop blocks with the delivery so a tool-free turn cannot strand it", async () => {
  await withBridge({ messages: [deliveredRow(9)] }, async ({ cwd }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const output = JSON.parse(stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, new RegExp(`reply_route_id: ${ROUTE_ID}`));
  });
});

test("an empty queue neither blocks Stop nor acknowledges anything", async () => {
  await withBridge({ messages: [] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(bridge.actions.some((action) => action.action === "commit"), false);
  });
});

test("a rejected commit surfaces as a fail-open diagnostic and leaves the row unacknowledged", async () => {
  await withBridge({ messages: [deliveredRow(11)], commitOk: false }, async ({ cwd, bridge }) => {
    const { stdout, stderr } = await runHook(CLAUDE_ARGS, { hook_event_name: "PreToolUse", session_id: "claude-session", cwd });
    // Output is still written: a bridge failure must never break the host turn.
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Parle responsive delivery seq=11/);
    assert.match(stderr, /Parle hook failed open/);
    assert.equal(bridge.actions.filter((action) => action.action === "commit").length, 1);
  });
});

test("a session with no id never leases and ignores the retired Command Code fallback", async () => {
  await withBridge({ messages: [deliveredRow(13)] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "UserPromptSubmit", cwd }, { COMMANDCODE_SESSION_ID: "legacy-session" });
    assert.deepEqual(JSON.parse(stdout), {});
    assert.deepEqual(bridge.actions, []);
  });
});

test("subagent hooks perform no bridge IPC while agent_type alone remains eligible", async () => {
  await withBridge({ messages: [deliveredRow(14)] }, async ({ cwd, bridge }) => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
      const subagent = await runHook(CLAUDE_ARGS, { hook_event_name: event, session_id: "claude-session", agent_id: "agent-1", cwd });
      assert.deepEqual(JSON.parse(subagent.stdout), {});
    }
    assert.deepEqual(bridge.actions, []);

    const mainThread = await runHook(CLAUDE_ARGS, { hook_event_name: "PreToolUse", session_id: "claude-session", agent_type: "Explore", cwd });
    assert.match(JSON.parse(mainThread.stdout).hookSpecificOutput.additionalContext, /seq=14/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  });
});

test("two top-level Claude hosts in one cwd consume only their own bridge in either hook order", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-claude-two-hosts-"));
  const hostA = prepareHookHost();
  const hostB = prepareHookHost();
  const bridgeA = await startBridge(cwd, { hostParentPid: hostA.pid, messages: [deliveredRow(21)] });
  const bridgeB = await startBridge(cwd, { hostParentPid: hostB.pid, messages: [deliveredRow(22)] });
  try {
    const second = await hostB.run({ hook_event_name: "UserPromptSubmit", session_id: "session-b", cwd });
    assert.match(JSON.parse(second.stdout).hookSpecificOutput.additionalContext, /seq=22/);
    assert.deepEqual(bridgeA.actions, []);
    assert.deepEqual(bridgeB.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);

    const first = await hostA.run({ hook_event_name: "UserPromptSubmit", session_id: "session-a", cwd });
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /seq=21/);
    assert.deepEqual(bridgeA.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  } finally {
    await Promise.all([bridgeA.stop(), bridgeB.stop()]);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a stale unresponsive sibling does not block replacement bridge recovery or get deleted", async () => {
  await withBridge({ messages: [deliveredRow(23)] }, async ({ cwd, bridge }) => {
    const stalePath = join(stateDir(cwd), String(process.pid), "899999999.sock");
    const staleServer = createServer((socket) => socket.destroy());
    await new Promise((resolveListen, reject) => {
      staleServer.once("error", reject);
      staleServer.listen(stalePath, resolveListen);
    });
    try {
      const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "PostToolUse", session_id: "claude-session", cwd });
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /seq=23/);
      assert.equal(existsSync(stalePath), true);
      assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
    } finally {
      await new Promise((done) => staleServer.close(done));
      rmSync(stalePath, { force: true });
    }
  });
});

test("an empty matched bridge never falls through to another top-level host", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-claude-empty-isolation-"));
  const current = await startBridge(cwd, { messages: [] });
  const other = await startBridge(cwd, { hostParentPid: process.pid + 10_000, messages: [deliveredRow(24)] });
  try {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.deepEqual(current.actions.map((action) => action.action), ["status", "bind", "take"]);
    assert.deepEqual(other.actions, []);
  } finally {
    await Promise.all([current.stop(), other.stop()]);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("multiple responding bridges or a responding parent mismatch fail closed before binding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-claude-ambiguous-"));
  const first = await startBridge(cwd, { messages: [deliveredRow(24)] });
  const second = await startBridge(cwd, { messages: [deliveredRow(25)] });
  try {
    const ambiguous = await runHook(CLAUDE_ARGS, { hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(ambiguous.stdout), {});
    assert.match(ambiguous.stderr, /found 2 matching endpoints/);
    assert.deepEqual(first.actions.map((action) => action.action), ["status"]);
    assert.deepEqual(second.actions.map((action) => action.action), ["status"]);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }

  const mismatched = await startBridge(cwd, { messages: [deliveredRow(26)], reportedParentPid: process.pid + 1 });
  try {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /process correlation mismatch/);
    assert.deepEqual(mismatched.actions.map((action) => action.action), ["status"]);
  } finally {
    await mismatched.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("only SessionStart may replace a different live host-session binding", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-claude-rebind-"));
  const bridge = await startBridge(cwd, { messages: [deliveredRow(27)], initialSessionId: "old-session" });
  try {
    const ordinary = await runHook(CLAUDE_ARGS, { hook_event_name: "UserPromptSubmit", session_id: "new-session", cwd });
    assert.deepEqual(JSON.parse(ordinary.stdout), {});
    assert.match(ordinary.stderr, /rejected host session binding/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind"]);

    bridge.actions.length = 0;
    const sessionStart = await runHook(CLAUDE_ARGS, { hook_event_name: "SessionStart", session_id: "new-session", cwd });
    assert.match(JSON.parse(sessionStart.stdout).hookSpecificOutput.additionalContext, /seq=27/);
    assert.equal(bridge.actions[1].allowReplace, true);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  } finally {
    await bridge.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
