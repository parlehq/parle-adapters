import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const script = resolve(root, "skills/parle/scripts/parle-watch.sh");

function isolatedEnv(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !key.startsWith("PARLE_") && value !== undefined)),
    ...overrides,
  };
}

function bridgeStateDir(scope, home = homedir()) {
  const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return join(home, ".local", "state", "parle", "hook-bridge", key);
}

async function startBridge(cwd, agentSessionId) {
  const stateDir = bridgeStateDir(cwd);
  const hostDir = join(stateDir, String(process.pid));
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  chmodSync(hostDir, 0o700);
  const socketPath = join(hostDir, `${process.pid}.sock`);
  const actions = [];
  let waiter;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const command = JSON.parse(input.slice(0, newline));
      actions.push(command);
      if (command.action === "status") {
        socket.end(`${JSON.stringify({ ok: true, running: true, hostSessionBound: true, agentSessionId })}\n`);
      } else if (command.action === "wait" && command.agentSessionId === agentSessionId) {
        waiter = socket;
      } else {
        socket.end(`${JSON.stringify({ ok: false, error: "wrong session" })}\n`);
      }
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });
  return {
    actions,
    ready() { waiter?.end(`${JSON.stringify({ ok: true, ready: true })}\n`); },
    async close() { await new Promise((resolveClose) => server.close(resolveClose)); },
  };
}

function runWatch(cwd, args) {
  const child = spawn("sh", [script, ...args], {
    cwd,
    env: isolatedEnv({ HOME: process.env.HOME }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    child,
    exited: new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code))),
    out: () => stdout,
    err: () => stderr,
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}

test("watch waits on the matching local hook bridge and opens no network watcher", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parle-local-watch-")));
  const session = "019f2946-aef5-77ad-a41d-747ce0fd6a11";
  const bridge = await startBridge(cwd, session);
  try {
    const watch = runWatch(cwd, [session]);
    await waitFor(() => bridge.actions.some((action) => action.action === "wait"), "watch did not register its local wait");
    assert.equal(watch.child.exitCode, null);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status", "wait"]);
    bridge.ready();
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /responsive delivery queued/);
  } finally {
    await bridge.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("watch times out a stale listener and reaches the matching nested bridge", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parle-local-watch-stale-")));
  const session = "019f2946-aef5-77ad-a41d-747ce0fd6a12";
  const stateDir = bridgeStateDir(cwd);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const stalePath = join(stateDir, "1.sock");
  const staleSockets = new Set();
  let staleAccepted = false;
  const stale = createServer((socket) => {
    staleAccepted = true;
    staleSockets.add(socket);
    socket.once("close", () => staleSockets.delete(socket));
  });
  await new Promise((resolveListen, reject) => {
    stale.once("error", reject);
    stale.listen(stalePath, resolveListen);
  });
  const bridge = await startBridge(cwd, session);
  try {
    const watch = runWatch(cwd, [session]);
    await waitFor(() => bridge.actions.some((action) => action.action === "wait"), "watch did not continue after the stale listener timeout");
    assert.equal(staleAccepted, true);
    bridge.ready();
    assert.equal(await watch.exited, 0, watch.err());
  } finally {
    for (const socket of staleSockets) socket.destroy();
    await new Promise((resolveClose) => stale.close(resolveClose));
    await bridge.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("watch fails closed when no bridge owns the requested session", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "parle-local-watch-wrong-session-")));
  const bridge = await startBridge(cwd, "session-current");
  try {
    const watch = runWatch(cwd, ["session-stale"]);
    assert.equal(await watch.exited, 2);
    assert.match(watch.err(), /No live Parle hook bridge owns agent session session-stale/);
    assert.deepEqual(bridge.actions.map((action) => action.action), ["status"]);
  } finally {
    await bridge.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("watch rejects obsolete cursor and profile argument forms", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-local-watch-usage-"));
  try {
    for (const args of [[], ["1", "session"], ["--profile", "other", "1", "session"]]) {
      const watch = runWatch(cwd, args);
      assert.equal(await watch.exited, 2);
      assert.match(watch.err(), /Usage: parle-watch\.sh <agent_session_id>/);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
