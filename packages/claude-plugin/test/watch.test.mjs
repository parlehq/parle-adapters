import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const script = resolve(root, "skills/parle/scripts/parle-watch.sh");

// The liveness check shells out to python3 and probes pids with kill(pid, 0);
// skip cleanly where the sandbox denies either.
const havePython = spawnSync("python3", ["-c", "import os; os.kill(os.getpid(), 0)"]).status === 0;

function stubServer(body) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function writeSnapshot(cwd, agentSessionId, overrides = {}) {
  const dir = join(cwd, ".parle", "runtime");
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    schemaVersion: 1,
    pid: process.pid,
    processStartedAt: new Date().toISOString(),
    state: "ready",
    sessionAddress: "@p.a.s1",
    agentSessionId,
    roomId: "room-1",
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    adapter: { name: "test" },
    ...overrides,
  };
  writeFileSync(join(dir, `${snapshot.pid}.json`), JSON.stringify(snapshot));
}

function runWatch(cwd, apiBase, args, extraEnv = {}) {
  const child = spawn("sh", [script, ...args], {
    cwd,
    env: {
      ...process.env,
      PARLE_API_BASE: apiBase,
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  return { child, exited, out: () => stdout, err: () => stderr };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function assertStillWatching(watch) {
  await sleep(1200);
  assert.equal(watch.child.exitCode, null, `watch exited early: ${watch.err()}${watch.out()}`);
  watch.child.kill("SIGKILL");
  await watch.exited;
}

test("watch exits 3 when live snapshots exist without the watched session", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-other");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    const code = await watch.exited;
    assert.equal(code, 3);
    assert.match(watch.err(), /no longer live/);
    assert.match(watch.err(), /parle_connect/);
  } finally {
    server.close();
  }
});

test("watch ignores expired snapshots of its session when deciding DEAD", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  // A snapshot for the watched session that is already expired must not count
  // as live, and an other-session snapshot with a live pid forces the DEAD verdict.
  writeSnapshot(cwd, "session-mine", { expiresAt: new Date(Date.now() - 1000).toISOString(), pid: 99999999 });
  writeSnapshot(cwd, "session-other");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    const code = await watch.exited;
    assert.equal(code, 3);
  } finally {
    server.close();
  }
});

test("watch keeps holding while its session snapshot is live", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-mine");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    await assertStillWatching(runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]));
  } finally {
    server.close();
  }
});

test("watch keeps holding when no snapshots exist (indeterminate)", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    await assertStillWatching(runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]));
  } finally {
    server.close();
  }
});

test("PARLE_WATCH_SESSION_LIVENESS=0 disables the liveness exit", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-other");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    await assertStillWatching(runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"], { PARLE_WATCH_SESSION_LIVENESS: "0" }));
  } finally {
    server.close();
  }
});

test("watch still exits 0 on relevant activity with a live snapshot", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-mine");
  const server = await stubServer({
    messages: [{ seq: 2, author: { agent_session_id: "session-other" }, addressing: { kind: "unaddressed" } }],
    watermark: 2,
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    const code = await watch.exited;
    assert.equal(code, 0);
    assert.match(watch.out(), /relevant activity/);
  } finally {
    server.close();
  }
});
