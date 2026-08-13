// Claude host delivery semantics for the hook bridge (parlehq/parle-adapters#117).
// These drive the real hook entrypoint against a stub bridge socket, so they
// cover what the Claude plugin actually ships: binding, route-bearing injection,
// per-event output shape, and acknowledgement that follows successful output.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HOOK = resolve(root, "hooks/parle-hook.mjs");
const ROUTE_ID = "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61";

function stateDir(scope) {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "parle", "hook-bridge", key);
}

// A stub bridge that records every action and answers with a scripted reply.
function startBridge(scope, { messages, commitOk = true }) {
  const dir = stateDir(scope);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}.sock`);
  rmSync(path, { force: true });
  const actions = [];
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
      if (command.action === "bind") return void socket.end(`${JSON.stringify({ ok: true, bound: true })}\n`);
      if (command.action === "take") return void socket.end(`${JSON.stringify({ ok: true, leaseId: "lease-1", messages })}\n`);
      if (command.action === "commit") return void socket.end(`${JSON.stringify(commitOk ? { ok: true, committed: messages.length } : { ok: false })}\n`);
      socket.end(`${JSON.stringify({ ok: false })}\n`);
    });
  });
  return new Promise((resolveReady) => {
    server.listen(path, () => resolveReady({
      actions,
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
    const { stdout } = await runHook(["--bind"], { hook_event_name: "UserPromptSubmit", session_id: "claude-session", cwd });
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
    assert.deepEqual(bridge.actions.map((action) => action.action), ["bind", "take", "commit"]);
  });
});

test("Stop blocks with the delivery so a tool-free turn cannot strand it", async () => {
  await withBridge({ messages: [deliveredRow(9)] }, async ({ cwd }) => {
    const { stdout } = await runHook(["--bind"], { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const output = JSON.parse(stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, new RegExp(`reply_route_id: ${ROUTE_ID}`));
  });
});

test("an empty queue neither blocks Stop nor acknowledges anything", async () => {
  await withBridge({ messages: [] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(["--bind"], { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(bridge.actions.some((action) => action.action === "commit"), false);
  });
});

test("a rejected commit surfaces as a fail-open diagnostic and leaves the row unacknowledged", async () => {
  await withBridge({ messages: [deliveredRow(11)], commitOk: false }, async ({ cwd, bridge }) => {
    const { stdout, stderr } = await runHook(["--bind"], { hook_event_name: "PreToolUse", session_id: "claude-session", cwd });
    // Output is still written: a bridge failure must never break the host turn.
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Parle responsive delivery seq=11/);
    assert.match(stderr, /Parle hook failed open/);
    assert.equal(bridge.actions.filter((action) => action.action === "commit").length, 1);
  });
});

test("a session with no id never leases, so unbound hosts cannot consume delivery", async () => {
  await withBridge({ messages: [deliveredRow(13)] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(["--bind"], { hook_event_name: "UserPromptSubmit", cwd }, { COMMANDCODE_SESSION_ID: "" });
    assert.deepEqual(JSON.parse(stdout), {});
    assert.deepEqual(bridge.actions, []);
  });
});
