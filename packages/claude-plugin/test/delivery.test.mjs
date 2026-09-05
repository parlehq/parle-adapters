// Claude host delivery semantics for the hook bridge (parlehq/parle-adapters#117).
// These drive the real hook entrypoint against a stub bridge socket, so they
// cover what the Claude plugin actually ships: binding, route-bearing injection,
// per-event output shape, and acknowledgement that follows successful output.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HOOK = resolve(root, "hooks/parle-hook.mjs");
const MCP_BRIDGE_MODULE = pathToFileURL(resolve(root, "../mcp-server/dist/hook-delivery-bridge.js")).href;
const CLAUDE_ARGS = ["--bind", "--direct-parent", "--stop-additional-context"];
const ROUTE_ID = "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61";
// The bridge's loopback Monitor wake address, handed out only inside take.
const WAKE_URL = "ws://127.0.0.1:41873/Q2xhdWRlIE1vbml0b3Igd2FrZSB0b2tlbg";

function stateDir(scope) {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "parle", "hook-bridge", key);
}

function cleanupFixture(cwd) {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(stateDir(cwd), { recursive: true, force: true });
}

let nextOwnerPid = 900_000_000;

// A stub bridge that records every action and answers with a scripted reply.
function startBridge(scope, { messages, agentSessionId = "parle-agent-session", bindDelayMs = 0, busy = false, commitDelayMs = 0, commitOk = true, hostParentPid = process.pid, reportedParentPid = hostParentPid, initialSessionId, statusDelayMs = 0, takeDelayMs = 0, waiterAttached = false, idleWakeSuspended = false, idleWakeSuspensionAnnounced = false, suspendOnTake = false, legacyTake = false, legacyAnnounce = false, announceDelayMs = 0, suspensionCommitOk = true, idleWakeUrl } = {}) {
  const ownerPid = nextOwnerPid++;
  const dir = join(stateDir(scope), String(hostParentPid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${ownerPid}.sock`);
  rmSync(path, { force: true });
  const actions = [];
  let boundSessionId = initialSessionId;
  let suspensionAnnounced = idleWakeSuspensionAnnounced;
  let suspended = idleWakeSuspended;
  let suspensionClaim;
  const snapshot = () => ({ ok: true, running: true, waiterAttached, idleWakeSuspended: suspended, idleWakeSuspensionAnnounced: suspensionAnnounced, agentSessionId, ownerPid, hostParentPid: reportedParentPid, currentParentPid: reportedParentPid });
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
        return void setTimeout(() => socket.end(`${JSON.stringify(snapshot())}\n`), statusDelayMs);
      }
      if (command.action === "bind") {
        const ok = !boundSessionId || boundSessionId === command.sessionId || command.allowReplace === true;
        if (ok) boundSessionId = command.sessionId;
        return void setTimeout(() => socket.end(`${JSON.stringify({ ok, bound: Boolean(boundSessionId) })}\n`), bindDelayMs);
      }
      if (command.action === "take" && command.sessionId === boundSessionId) {
        // The third detach landing between the discovery probe and take.
        if (suspendOnTake) suspended = true;
        const taken = busy ? { ok: true, busy: true, messages: [] } : { ok: true, leaseId: "lease-1", messages };
        // An older bridge omits the take-time status snapshot.
        if (!legacyTake) taken.status = snapshot();
        // A bridge with a Monitor wake hands the bound session its address.
        if (idleWakeUrl) taken.idleWakeUrl = idleWakeUrl;
        return void setTimeout(() => socket.end(`${JSON.stringify(taken)}\n`), takeDelayMs);
      }
      if (command.action === "announce-suspension" && command.sessionId === boundSessionId) {
        const owed = suspended && !suspensionAnnounced && !suspensionClaim;
        // An older bridge ignores claim:true and marks the announcement final
        // in one step, returning no claimId.
        if (legacyAnnounce) {
          if (owed) suspensionAnnounced = true;
          return void setTimeout(() => socket.end(`${JSON.stringify({ ok: true, owed })}\n`), announceDelayMs);
        }
        if (owed) suspensionClaim = "claim-1";
        return void setTimeout(() => socket.end(`${JSON.stringify({ ok: true, owed, ...(owed ? { claimId: suspensionClaim } : {}) })}\n`), announceDelayMs);
      }
      if (command.action === "commit-suspension" && command.sessionId === boundSessionId) {
        const ok = suspensionCommitOk && Boolean(suspensionClaim) && command.claimId === suspensionClaim;
        if (ok) {
          suspensionAnnounced = true;
          suspensionClaim = undefined;
        }
        return void socket.end(`${JSON.stringify(ok ? { ok: true, announced: true } : { ok: false })}\n`);
      }
      if (command.action === "commit" && command.sessionId === boundSessionId) {
        return void setTimeout(() => socket.end(`${JSON.stringify(commitOk ? { ok: true, committed: messages.length } : { ok: false })}\n`), commitDelayMs);
      }
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

function prepareHookHost(scope, args = CLAUDE_ARGS) {
  const wrapper = `
    const { spawn } = require("node:child_process");
    const probe = spawn(process.execPath, ["--input-type=module", "-e", process.env.PARLE_TEST_MCP_PROBE], { env: process.env });
    probe.stderr.pipe(process.stderr);
    probe.on("exit", (probeCode) => {
      if (probeCode !== 0) return void (process.exitCode = probeCode);
      const child = spawn(process.execPath, [process.env.PARLE_TEST_HOOK, ...JSON.parse(process.env.PARLE_TEST_HOOK_ARGS)], { env: process.env });
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      child.on("exit", (code) => { process.exitCode = code; });
    });
  `;
  const probe = `
    import { hookBridgeHostDir } from ${JSON.stringify(MCP_BRIDGE_MODULE)};
    console.error("MCP_PROBE " + JSON.stringify({ ppid: process.ppid, dir: hookBridgeHostDir(${JSON.stringify(scope)}) }));
  `;
  const host = spawn(process.execPath, ["-e", wrapper], {
    env: { ...process.env, PARLE_TEST_HOOK: HOOK, PARLE_TEST_HOOK_ARGS: JSON.stringify(args), PARLE_TEST_MCP_PROBE: probe },
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
    cleanupFixture(cwd);
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
    // The bind names its hook event so the bridge can end an idle-wake
    // suspension episode when a human prompt arrives.
    assert.equal(bridge.actions[1].hookEventName, "UserPromptSubmit");
  });
});

test("Stop injects delivery as non-error context so a tool-free turn cannot strand it", async () => {
  await withBridge({ messages: [deliveredRow(9)] }, async ({ cwd }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const output = JSON.parse(stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(Object.hasOwn(output, "decision"), false);
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`reply_route_id: ${ROUTE_ID}`));
  });
});

test("an empty queue neither blocks Stop nor acknowledges anything", async () => {
  await withBridge({ messages: [] }, async ({ cwd, bridge }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(stdout), {});
    assert.equal(bridge.actions.some((action) => action.action === "commit"), false);
  });
});

const MONITOR_LINE = `Parle idle wake is not attached. Call the Monitor tool once with ws: { url: "${WAKE_URL}" }, persistent: true, description: "Parle responsive delivery". Do not use Bash, do not run a watcher script, and do not call it again while that Monitor task is running.`;

test("Stop asks once for the Monitor attachment only for an empty unarmed bridge that hands out its wake url", async () => {
  await withBridge({ messages: [], idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(Object.hasOwn(output, "decision"), false);
    assert.equal(output.hookSpecificOutput.additionalContext, MONITOR_LINE);
    // No launcher, no shell command, no plugin path: the url is the whole address.
    assert.doesNotMatch(result.stdout, /run_in_background|parle-watch|CLAUDE_PLUGIN_ROOT|shell &/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take"]);
  });

  // A bridge without a Monitor wake hands out no url: the hook asks for
  // nothing and parle_status keeps reporting idle_wake_unarmed.
  await withBridge({ messages: [] }, async ({ cwd, bridge }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take"]);
  });

  // Only the bridge's own loopback address is ever repeated to the model.
  await withBridge({ messages: [], idleWakeUrl: "ws://example.invalid:1/token" }, async ({ cwd }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  for (const [options, payload] of [
    [{ messages: [], idleWakeUrl: WAKE_URL, busy: true }, { hook_event_name: "Stop", session_id: "claude-session" }],
    [{ messages: [], idleWakeUrl: WAKE_URL, waiterAttached: true }, { hook_event_name: "Stop", session_id: "claude-session" }],
    [{ messages: [], idleWakeUrl: WAKE_URL, agentSessionId: "" }, { hook_event_name: "Stop", session_id: "claude-session" }],
    [{ messages: [], idleWakeUrl: WAKE_URL }, { hook_event_name: "Stop", session_id: "claude-session", stop_hook_active: true }],
  ]) {
    await withBridge(options, async ({ cwd, bridge }) => {
      const result = await runHook(CLAUDE_ARGS, { ...payload, cwd });
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(result.stdout.includes(WAKE_URL), false);
      assert.deepEqual(bridge.actions.map((action) => action.action), payload.stop_hook_active ? [] : ["status", "bind", "take"]);
    });
  }
});

test("the wake url appears only inside the Stop attachment instruction", async () => {
  // Other boundaries drain delivery but never carry the address.
  await withBridge({ messages: [deliveredRow(8)], idleWakeUrl: WAKE_URL }, async ({ cwd }) => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
      const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: event, session_id: "claude-session", cwd });
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /seq=8/);
      assert.equal(stdout.includes(WAKE_URL), false, `${event} must not carry the wake url`);
    }
  });
  await withBridge({ messages: [], idleWakeUrl: WAKE_URL }, async ({ cwd }) => {
    const { stdout } = await runHook(CLAUDE_ARGS, { hook_event_name: "PreToolUse", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(stdout), {});
  });
});

const SUSPENDED_LINE = "Parle idle wake suspended: the Monitor attachment keeps closing; it resumes at the next prompt.";

test("a suspended idle wake is announced once at Stop instead of re-attached", async () => {
  const args = CLAUDE_ARGS;
  const suspended = SUSPENDED_LINE;
  await withBridge({ messages: [], idleWakeSuspended: true, idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const raw = (await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout;
    const first = JSON.parse(raw);
    assert.equal(first.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(first.hookSpecificOutput.additionalContext, suspended);
    assert.equal(raw.includes(WAKE_URL), false, "a suspended Stop withholds the address");
    // The claim is committed only after output was written.
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension"]);
    assert.equal(bridge.actions[3].claim, true, "the hook negotiates a claim explicitly");
    assert.equal(bridge.actions[4].claimId, "claim-1");

    // The bridge marked the episode announced: the next Stop says nothing.
    bridge.actions.length = 0;
    const second = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(second.stdout), {});
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take"]);
  });

  await withBridge({ messages: [], idleWakeSuspended: true, idleWakeSuspensionAnnounced: true, idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.doesNotMatch(result.stdout, /idle wake is not attached/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take"]);
  });

  // Queued delivery still injects first; the suspension adds no re-arm request.
  await withBridge({ messages: [deliveredRow(15)], idleWakeSuspended: true, idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const output = JSON.parse((await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /Parle responsive delivery seq=15/);
    assert.doesNotMatch(context, /idle wake is not attached/);
    assert.ok(context.endsWith(suspended));
    assert.ok(context.indexOf("seq=15") < context.indexOf("idle wake suspended"));
    // The cheap local suspension commit precedes the delivery acknowledgement.
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension", "commit"]);
  });
});

test("a new hook against an older bridge treats an owed answer without a claimId as already announced", async () => {
  const args = CLAUDE_ARGS;
  await withBridge({ messages: [], idleWakeSuspended: true, legacyAnnounce: true }, async ({ cwd, bridge }) => {
    const first = JSON.parse((await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout);
    assert.equal(first.hookSpecificOutput.additionalContext, SUSPENDED_LINE);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension"], "no commit is attempted against a bridge that already marked it final");

    bridge.actions.length = 0;
    const second = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(second.stdout), {});
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take"]);
  });
});

test("delivery acknowledgement and suspension commit fail independently after output", async () => {
  const args = CLAUDE_ARGS;
  // A rejected delivery commit still leaves the announcement committed.
  await withBridge({ messages: [deliveredRow(17)], idleWakeSuspended: true, commitOk: false }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /seq=17/);
    assert.ok(context.endsWith(SUSPENDED_LINE));
    assert.match(result.stderr, /did not acknowledge the injected batch/);
    assert.doesNotMatch(result.stderr, /idle-wake suspension/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension", "commit"]);

    bridge.actions.length = 0;
    const next = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.doesNotMatch(JSON.parse(next.stdout).hookSpecificOutput.additionalContext, /idle wake suspended/, "the announcement does not repeat");
  });

  // A rejected suspension commit still acknowledges the delivery.
  await withBridge({ messages: [deliveredRow(18)], idleWakeSuspended: true, suspensionCommitOk: false }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /seq=18/);
    assert.match(result.stderr, /did not commit the idle-wake suspension announcement/);
    assert.doesNotMatch(result.stderr, /did not acknowledge/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension", "commit"]);
  });

  // A timed-out suspension commit still leaves budget for the delivery commit.
  await withBridge({ messages: [deliveredRow(19)], idleWakeSuspended: true, suspensionCommitOk: false, commitDelayMs: 200 }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.match(result.stderr, /did not commit the idle-wake suspension announcement/);
    assert.equal(bridge.actions.filter((action) => action.action === "commit").length, 1);
  });
});

test("Stop decides suspension from the take-time status, falling back to the discovery probe for an older bridge", async () => {
  const args = CLAUDE_ARGS;
  // The third detach lands between the discovery probe and take: the probe
  // said unsuspended, the take snapshot says suspended, and no re-arm is asked.
  await withBridge({ messages: [], suspendOnTake: true, idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const output = JSON.parse((await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout);
    assert.equal(output.hookSpecificOutput.additionalContext, SUSPENDED_LINE);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /idle wake is not attached/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension"]);
  });

  // An older bridge omits the snapshot; the discovery probe still governs.
  await withBridge({ messages: [], legacyTake: true, idleWakeSuspended: true }, async ({ cwd, bridge }) => {
    const output = JSON.parse((await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout);
    assert.equal(output.hookSpecificOutput.additionalContext, SUSPENDED_LINE);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension"]);
  });
  await withBridge({ messages: [], legacyTake: true, idleWakeUrl: WAKE_URL }, async ({ cwd }) => {
    const output = JSON.parse((await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd })).stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /idle wake is not attached/);
  });
});

test("a lost announcement claim is never committed and does not cost the Stop its delivery", async () => {
  const args = CLAUDE_ARGS;
  // The bridge records the claim but its response is lost (socket timeout);
  // the hook fails open on the announcement only, injects the batch, and
  // commits nothing for the suspension, so the bridge's claim expires owed.
  await withBridge({ messages: [deliveredRow(16)], idleWakeSuspended: true, announceDelayMs: 1500 }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /Parle responsive delivery seq=16/);
    assert.doesNotMatch(context, /idle wake suspended/);
    assert.doesNotMatch(context, /idle wake is not attached/);
    assert.match(result.stderr, /Parle hook failed open: timeout/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit"]);
  });

  // A rejected suspension commit is a fail-open diagnostic after output.
  await withBridge({ messages: [], idleWakeSuspended: true, suspensionCommitOk: false }, async ({ cwd, bridge }) => {
    const result = await runHook(args, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, SUSPENDED_LINE);
    assert.match(result.stderr, /did not commit the idle-wake suspension announcement/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "announce-suspension", "commit-suspension"]);
  });
});

test("an active Stop fence performs no delivery IPC or acknowledgement", async () => {
  await withBridge({ messages: [deliveredRow(10)] }, async ({ cwd, bridge }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", stop_hook_active: true, cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.deepEqual(bridge.actions, []);
  });
});

test("a Stop-delivered batch stays first and carries re-attachment through the same bounded continuation", async () => {
  await withBridge({ messages: [deliveredRow(10)], idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const output = JSON.parse(result.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
    assert.equal(Object.hasOwn(output, "decision"), false);
    assert.match(context, /Parle responsive delivery seq=10/);
    assert.ok(context.endsWith(`\n\n${MONITOR_LINE}`));
    assert.ok(context.indexOf("Parle responsive delivery seq=10") < context.indexOf("Parle idle wake is not attached"));
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  });
});

test("the retired launcher argument is unknown and fails open before bridge IPC", async () => {
  await withBridge({ messages: [], idleWakeUrl: WAKE_URL }, async ({ cwd, bridge }) => {
    const result = await runHook([...CLAUDE_ARGS, "--idle-wake-launcher", "/plugin/parle-watch.sh"], { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /Unknown Parle hook argument: --idle-wake-launcher/);
    assert.deepEqual(bridge.actions, []);
  });
});

test("a slow successful commit completes within the remaining bounded hook budget", async () => {
  await withBridge({ messages: [deliveredRow(11)], statusDelayMs: 200, bindDelayMs: 200, takeDelayMs: 200, commitDelayMs: 1200 }, async ({ cwd, bridge }) => {
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Parle responsive delivery seq=11/);
    assert.equal(result.stderr, "");
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
  });
});

test("slow pre-commit IPC shrinks the commit deadline below the host hook window", async () => {
  await withBridge({ messages: [deliveredRow(12)], statusDelayMs: 800, bindDelayMs: 800, takeDelayMs: 800, commitDelayMs: 2500 }, async ({ cwd, bridge }) => {
    const startedAt = Date.now();
    const result = await runHook(CLAUDE_ARGS, { hook_event_name: "Stop", session_id: "claude-session", cwd });
    const elapsedMs = Date.now() - startedAt;
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Parle responsive delivery seq=12/);
    assert.match(result.stderr, /Parle hook failed open: timeout/);
    assert.ok(elapsedMs >= 4000 && elapsedMs < 4900, `hook should stop inside its 5s host window, took ${elapsedMs}ms`);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
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

test("MCP and hook children derive the same parent and isolate two hosts in both hook orders", async () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const cwd = mkdtempSync(join(tmpdir(), "parle-claude-two-hosts-"));
    const hosts = { a: prepareHookHost(cwd), b: prepareHookHost(cwd) };
    const bridges = {
      a: await startBridge(cwd, { hostParentPid: hosts.a.pid, messages: [deliveredRow(21)] }),
      b: await startBridge(cwd, { hostParentPid: hosts.b.pid, messages: [deliveredRow(22)] }),
    };
    try {
      for (const label of order) {
        const result = await hosts[label].run({ hook_event_name: "UserPromptSubmit", session_id: `session-${label}`, cwd });
        const seq = label === "a" ? 21 : 22;
        assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, new RegExp(`seq=${seq}`));
        const probe = JSON.parse(result.stderr.match(/MCP_PROBE (\{.*\})/)[1]);
        assert.equal(probe.ppid, hosts[label].pid);
        assert.equal(probe.dir, join(stateDir(cwd), String(hosts[label].pid)));
        assert.deepEqual(bridges[label].actions.map((action) => action.action), ["status", "bind", "take", "commit"]);
        const other = label === "a" ? "b" : "a";
        if (!order.slice(0, order.indexOf(label)).includes(other)) assert.deepEqual(bridges[other].actions, []);
      }
    } finally {
      await Promise.all([bridges.a.stop(), bridges.b.stop()]);
      cleanupFixture(cwd);
    }
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
    chmodSync(stalePath, 0o000);
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
    cleanupFixture(cwd);
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
    cleanupFixture(cwd);
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
    cleanupFixture(cwd);
  }
});
