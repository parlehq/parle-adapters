import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const script = resolve(root, "skills/parle/scripts/parle-watch.sh");
const workerScript = resolve(root, "skills/parle/scripts/parle-watch-worker.sh");

// The liveness check shells out to python3 and probes pids with kill(pid, 0);
// skip cleanly where the sandbox denies either.
const havePython = spawnSync("python3", ["-c", "import os; os.kill(os.getpid(), 0)"]).status === 0;

// PID-reuse hardening verifies process start times via /proc or ps etime;
// tests for it self-skip where neither is available (hardened sandboxes).
function canVerifyStart() {
  try {
    if (execFileSync("ps", ["-o", "etime=", "-p", String(process.pid)], { encoding: "utf8" }).trim()) return true;
  } catch {
    // fall through to /proc
  }
  return existsSync(`/proc/${process.pid}/stat`);
}
const haveStartVerify = canVerifyStart();

function isolatedTestEnv(overrides = {}, ambient = process.env) {
  const env = Object.fromEntries(Object.entries(ambient).filter(([key, value]) => !key.startsWith("PARLE_") && value !== undefined));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function stubServer(body, onRequest) {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://watch.test");
      onRequest?.(req, url);
      let response;
      if (req.method === "POST" && url.pathname === "/v/agent/sessions") {
        response = {
          agent_session_id: "019f2946-aef5-77ad-a41d-747ce0fd6a11",
          session_credential: "parle_ses_watch_private",
          address: "@p.a.watcher",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        };
      } else if (req.method === "POST" && url.pathname.endsWith("/participants")) {
        response = { participant_id: "019f2946-aef5-77ad-a41d-747ce0fd6a12", room_handle: "watch-room" };
      } else if (req.method === "POST" && url.pathname.endsWith("/end")) {
        res.writeHead(204, { Connection: "close" });
        res.end();
        return;
      } else if (url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "0") {
        response = { messages: [], watermark: 1 };
      } else {
        response = typeof body === "function" ? body(req) : body;
      }
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function writeSnapshot(cwd, agentSessionId, overrides = {}) {
  const dir = join(cwd, ".parle", "runtime");
  mkdirSync(dir, { recursive: true });
  const snapshot = {
    schemaVersion: 2,
    pid: process.pid,
    // The real start of this process, as the client writes it: a fabricated
    // "now" would trip the PID-reuse start-time check once the suite has run
    // longer than the tolerance. Snapshots for other pids (process.ppid)
    // override this with undefined so the unverifiable claim is omitted.
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    clientInstanceId: "019f2946-aef5-47ad-a41d-747ce0fd6a14",
    state: "ready",
    sessionAddress: "@p.a.s1",
    agentSessionId,
    rooms: [{ roomId: "room-1", state: "ready" }],
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    adapter: { name: "test" },
    ...overrides,
  };
  const path = join(dir, `${snapshot.pid}.json`);
  const temporary = join(dir, `.snapshot-${snapshot.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(snapshot));
  renameSync(temporary, path);
}

function runWatch(cwd, apiBase, args, extraEnv = {}) {
  const env = isolatedTestEnv({
    PARLE_API_BASE: apiBase,
    PARLE_ROOM_ID: "room-1",
    PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
    PARLE_ALLOW_INSECURE_LOCAL: "1",
    ...extraEnv,
  });
  const child = spawn("sh", [script, ...args], {
    cwd,
    env,
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

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail(message);
}

function runWorkerScenario(outputs) {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-outcomes-"));
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const scenarioPath = join(cwd, "scenario.json");
  const statePath = join(cwd, "state");
  const requestLog = join(cwd, "requests.log");
  const sleepLog = join(cwd, "sleeps.log");
  const helper = join(cwd, "helper.mjs");
  writeFileSync(scenarioPath, JSON.stringify(outputs));
  writeFileSync(helper, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const outputs = JSON.parse(readFileSync(process.env.WATCH_SCENARIO, "utf8"));
const index = existsSync(process.env.WATCH_STATE) ? Number(readFileSync(process.env.WATCH_STATE, "utf8")) : 0;
writeFileSync(process.env.WATCH_STATE, String(index + 1));
appendFileSync(process.env.WATCH_REQUEST_LOG, String(process.argv[4] || "25") + "\\n");
process.stdout.write(outputs[Math.min(index, outputs.length - 1)]);
`);
  writeFileSync(join(bin, "sleep"), `#!/bin/sh\nprintf '%s\\n' "$1" >> "$WATCH_SLEEP_LOG"\n`);
  chmodSync(join(bin, "sleep"), 0o755);
  const child = spawn("sh", [workerScript, "1"], {
    cwd,
    env: isolatedTestEnv({
      PATH: `${bin}:${process.env.PATH}`,
      PARLE_API_BASE: "https://api.example",
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
      PARLE_WATCH_AGENT_SESSION: "parle_ses_test",
      PARLE_WATCH_CLIENT_INSTANCE_ID: "019f2946-aef5-47ad-a41d-747ce0fd6a13",
      PARLE_VERSION: "2026-08-05",
      PARLE_WATCH_REQUEST_HELPER: helper,
      PARLE_WATCH_PARENT_PID: String(process.pid),
      PARLE_WATCH_SESSION_LIVENESS: "0",
      WATCH_SCENARIO: scenarioPath,
      WATCH_STATE: statePath,
      WATCH_REQUEST_LOG: requestLog,
      WATCH_SLEEP_LOG: sleepLog,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return {
    exited: new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code))),
    out: () => stdout,
    err: () => stderr,
    requests: () => existsSync(requestLog) ? readFileSync(requestLog, "utf8").trim().split("\n") : [],
    sleeps: () => existsSync(sleepLog) ? readFileSync(sleepLog, "utf8").trim().split("\n") : [],
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

async function assertStillWatching(watch) {
  await sleep(1200);
  assert.equal(watch.child.exitCode, null, `watch exited early: ${watch.err()}${watch.out()}`);
  watch.child.kill("SIGKILL");
  await watch.exited;
}

test("watch fixtures strip ambient Parle config before applying explicit overrides", () => {
  const env = isolatedTestEnv(
    { PARLE_ROOM_ID: "fixture-room", PARLE_PROFILE: "explicit-profile" },
    { PATH: "/test/bin", PARLE_PROFILE: "ambient-profile", PARLE_SESSION_ALIAS: "ambient-route" },
  );
  assert.deepEqual(env, { PATH: "/test/bin", PARLE_ROOM_ID: "fixture-room", PARLE_PROFILE: "explicit-profile" });
});

test("invalid launcher forms fail with one usage line before network or worker activity", async () => {
  let requests = 0;
  const server = await stubServer({ messages: [], watermark: 1 }, () => { requests += 1; });
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-invalid-"));
  const usage = "Usage: parle-watch.sh [--profile <name>] <since_seq> [my_agent_session_id [my_participant_id]]";
  writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=poison\nPARLE_ROOM_ID=conflict\n");
  try {
    for (const args of [[], ["--unknown"], ["--profile=x", "7"], ["--profile"], ["--profile", "target"], ["--profile", "--bad", "7"], [""], [" "], ["abc"], ["-1"], ["+1"], ["1.5"], ["1e3"], ["50", "--profile"], ["7", ""], ["7", "as-1", ""], ["7", "as-1", "participant-1", "extra"], ["--profile", "target", "abc"], ["--profile", "target", "7", "--sid"], ["--profile", "target", "7", "as-1", "participant-1", "extra"]]) {
      const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, args);
      assert.equal(await watch.exited, 2);
      assert.equal(watch.out(), "");
      assert.equal(watch.err(), `${usage}\n`);
    }
    assert.equal(requests, 0);
    assert.equal(existsSync(join(cwd, ".parle", "runtime")), false);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

const deadline = '000\n{"watcher_local":{"outcome":"held_deadline"}}';
const transport = '000\n{"watcher_local":{"outcome":"network_failure"}}';
const malformed = '000\n{"watcher_local":{"outcome":"malformed_response"}}';
const relevant = '200\n{"messages":[{"seq":2}],"watermark":2}';

test("one or two helper deadlines do not consume failures or trigger a health probe", async () => {
  const watch = runWorkerScenario([deadline, deadline, relevant]);
  try {
    assert.equal(await watch.exited, 0, watch.err());
    assert.deepEqual(watch.requests(), ["hold", "hold", "hold"]);
    assert.deepEqual(watch.sleeps(), []);
  } finally {
    watch.cleanup();
  }
});

test("three helper deadlines trigger one healthy wait=0 probe before held polling resumes", async () => {
  const healthy = '200\n{"messages":[],"watermark":1}';
  const watch = runWorkerScenario([deadline, deadline, deadline, healthy, relevant]);
  try {
    assert.equal(await watch.exited, 0, watch.err());
    assert.deepEqual(watch.requests(), ["hold", "hold", "hold", "probe", "hold"]);
    assert.deepEqual(watch.sleeps(), []);
  } finally {
    watch.cleanup();
  }
});

test("a healthy probe processes a relevant row instead of discarding it", async () => {
  const watch = runWorkerScenario([deadline, deadline, deadline, relevant]);
  try {
    assert.equal(await watch.exited, 0, watch.err());
    assert.deepEqual(watch.requests(), ["hold", "hold", "hold", "probe"]);
    assert.match(watch.out(), /relevant activity/);
  } finally {
    watch.cleanup();
  }
});

test("a failed deadline health probe enters the ordinary five-failure path", async () => {
  const watch = runWorkerScenario([deadline, deadline, deadline, transport, transport, transport, transport, transport]);
  try {
    assert.equal(await watch.exited, 2);
    assert.deepEqual(watch.requests(), ["hold", "hold", "hold", "probe", "hold", "hold", "hold", "hold"]);
    assert.deepEqual(watch.sleeps(), ["5", "10", "15", "20"]);
    assert.match(watch.err(), /5 consecutive network failures/);
  } finally {
    watch.cleanup();
  }
});

test("malformed responses and a malformed deadline probe consume the ordinary failure budget", async () => {
  const malformedWatch = runWorkerScenario([malformed, malformed, malformed, malformed, malformed]);
  try {
    assert.equal(await malformedWatch.exited, 2);
    assert.match(malformedWatch.err(), /5 consecutive network failures/);
  } finally {
    malformedWatch.cleanup();
  }

  const malformedProbe = runWorkerScenario([deadline, deadline, deadline, malformed, malformed, malformed, malformed, malformed]);
  try {
    assert.equal(await malformedProbe.exited, 2);
    assert.deepEqual(malformedProbe.requests(), ["hold", "hold", "hold", "probe", "hold", "hold", "hold", "hold"]);
    assert.match(malformedProbe.err(), /5 consecutive network failures/);
  } finally {
    malformedProbe.cleanup();
  }
});

test("retryable and terminal HTTP outcomes keep their canonical shell behavior", async () => {
  const retryable = '429\n{"error":{"action":"retry_with_backoff","code":"rate_limited","retry_after_ms":1234}}';
  const retryWatch = runWorkerScenario([retryable, relevant]);
  try {
    assert.equal(await retryWatch.exited, 0, retryWatch.err());
    assert.deepEqual(retryWatch.sleeps(), ["2"]);
    assert.match(retryWatch.err(), /retrying after 2s/);
  } finally {
    retryWatch.cleanup();
  }

  const terminal = '401\n{"error":{"action":"reauthorize","code":"invalid_token"}}';
  const terminalWatch = runWorkerScenario([terminal]);
  try {
    assert.equal(await terminalWatch.exited, 2);
    assert.deepEqual(terminalWatch.sleeps(), []);
    assert.match(terminalWatch.err(), /reauthorize/);
  } finally {
    terminalWatch.cleanup();
  }

  const terminalAfterDeadlines = runWorkerScenario([deadline, deadline, terminal, relevant]);
  try {
    assert.equal(await terminalAfterDeadlines.exited, 2);
    assert.deepEqual(terminalAfterDeadlines.requests(), ["hold", "hold", "hold"]);
    assert.deepEqual(terminalAfterDeadlines.sleeps(), []);
    assert.match(terminalAfterDeadlines.err(), /reauthorize/);
  } finally {
    terminalAfterDeadlines.cleanup();
  }
});

test("watch resolves a named profile on every manual re-arm without exposing its token", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-profile-project-"));
  const home = mkdtempSync(join(tmpdir(), "parle-watch-profile-home-"));
  const seenAuth = [];
  const server = await stubServer((req) => {
    seenAuth.push(req.headers.authorization);
    return { messages: [{ seq: 2, author: { agent_session_id: "session-other" }, addressing: { kind: "unaddressed" } }], watermark: 2 };
  });
  const profilePath = join(home, ".parle", "profiles");
  const roomId = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const firstToken = "parle_agt_profile_first_secret";
  const secondToken = "parle_agt_profile_second_secret";
  try {
    mkdirSync(dirname(profilePath), { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=claude\n");
    writeFileSync(profilePath, `[claude]\nroom_id = ${roomId}\nagent_token = ${firstToken}\napi_base = http://127.0.0.1:${server.address().port}\n`, { mode: 0o600 });
    const cleanEnv = { HOME: home, PARLE_API_BASE: undefined, PARLE_ROOM_ID: undefined, PARLE_ROOM_AGENT_TOKEN: undefined, PARLE_PROFILE: undefined };
    const first = runWatch(cwd, "unused", ["1"], cleanEnv);
    assert.equal(await first.exited, 0, first.err());
    assert.equal(first.out().includes(firstToken), false);
    assert.equal(first.err().includes(firstToken), false);

    writeFileSync(profilePath, `[claude]\nroom_id = ${roomId}\nagent_token = ${secondToken}\napi_base = http://127.0.0.1:${server.address().port}\n`, { mode: 0o600 });
    const second = runWatch(cwd, "unused", ["1"], cleanEnv);
    assert.equal(await second.exited, 0, second.err());
    assert.equal(second.out().includes(secondToken), false);
    assert.equal(second.err().includes(secondToken), false);
    assert.deepEqual(seenAuth, [`Bearer ${firstToken}`, `Bearer ${secondToken}`]);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("watch --profile selects the switched profile and freezes its token outside argv", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-switched-project-"));
  const home = mkdtempSync(join(tmpdir(), "parle-watch-switched-home-"));
  const seenAuth = [];
  const seenSessions = [];
  const requests = [];
  const sessionBodies = [];
  const server = await stubServer((req) => {
    seenAuth.push(req.headers.authorization);
    seenSessions.push(req.headers["parle-agent-session"]);
    return { messages: [{ seq: 2, author: { agent_session_id: "session-other" }, addressing: { kind: "unaddressed" } }], watermark: 2 };
  }, (req, url) => {
    requests.push(`${req.method} ${url.pathname}?wait=${url.searchParams.get("wait") || ""}`);
    if (req.method === "POST" && url.pathname === "/v/agent/sessions") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => sessionBodies.push(body));
    }
  });
  const oldToken = "parle_agt_old_profile_secret";
  const targetToken = "parle_agt_target_profile_secret";
  try {
    mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=old\n");
    writeFileSync(join(home, ".parle", "profiles"), `[old]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = ${oldToken}\napi_base = http://127.0.0.1:${server.address().port}\n\n[target]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = ${targetToken}\napi_base = http://127.0.0.1:${server.address().port}\n`, { mode: 0o600 });
    const watch = runWatch(cwd, "unused", ["--profile", "target", "1"], { HOME: home, PARLE_API_BASE: undefined, PARLE_ROOM_ID: undefined, PARLE_ROOM_AGENT_TOKEN: undefined, PARLE_PROFILE: undefined, PARLE_SESSION_ALIAS: "primary-route" });
    assert.equal(await watch.exited, 0, watch.err());
    assert.deepEqual(seenAuth, [`Bearer ${targetToken}`]);
    assert.deepEqual(seenSessions, ["parle_ses_watch_private"]);
    assert.deepEqual(sessionBodies, ["{}"], "dedicated watcher must not claim the primary session alias");
    assert.deepEqual(requests, [
      "POST /v/agent/sessions?wait=",
      "POST /v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045261/participants?wait=",
      "GET /v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045261/projection?wait=0",
      "GET /v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045261/projection?wait=25",
      "POST /v/agent/sessions/019f2946-aef5-77ad-a41d-747ce0fd6a11/end?wait=",
    ]);
    assert.equal(watch.out().includes(targetToken), false);
    assert.equal(watch.out().includes("parle_ses_watch_private"), false);
    assert.equal(watch.err().includes(targetToken), false);
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(watch.child.pid)], { encoding: "utf8" });
    assert.equal((ps.stdout || "").includes(targetToken), false);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("launcher restarts only its worker when the dedicated watcher credential rolls", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-credential-rollover-"));
  const firstSessionId = "019f2946-aef5-77ad-a41d-747ce0fd6a21";
  const secondSessionId = "019f2946-aef5-77ad-a41d-747ce0fd6a22";
  const firstCredential = "parle_ses_watch_first_private";
  const secondCredential = "parle_ses_watch_second_private";
  let sessionCreates = 0;
  let firstWorkerPolls = 0;
  let secondWorkerPolls = 0;
  let filteredSecondPolls = 0;
  let firstInvalidated = false;
  let activity = "hold";
  let releaseSecondSession;
  const ended = [];
  const sendJson = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://watch.test");
    const credential = req.headers["parle-agent-session"];
    if (req.method === "POST" && url.pathname === "/v/agent/sessions") {
      sessionCreates += 1;
      const respond = () => sendJson(res, 201, sessionCreates === 1 ? {
        agent_session_id: firstSessionId,
        session_credential: firstCredential,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        address: "@p.a.watch-first",
      } : {
        agent_session_id: secondSessionId,
        session_credential: secondCredential,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        address: "@p.a.watch-second",
      });
      if (sessionCreates === 1 || firstWorkerPolls > 0) respond();
      else if (sessionCreates === 2) releaseSecondSession = respond;
      else sendJson(res, 500, { error: { action: "stop", code: "restart_storm" } });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/participants")) {
      assert.ok(credential === firstCredential || credential === secondCredential);
      sendJson(res, 201, { participant_id: credential === firstCredential ? "participant-first" : "participant-second", room_handle: "watch-room" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v/agent/wake") {
      assert.equal(credential, secondCredential);
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(": ready\n\n");
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/responsive-delivery")) {
      assert.equal(credential, secondCredential);
      sendJson(res, 200, { delivery: { cursor_scope: "session", last_acked_seq: 0 }, messages: [] });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/end")) {
      const sessionId = url.pathname.split("/").at(-2);
      ended.push([sessionId, credential]);
      if (sessionId === firstSessionId) firstInvalidated = true;
      res.writeHead(204, { Connection: "close" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/projection")) {
      const wait = url.searchParams.get("wait");
      if (credential === firstCredential) {
        if (firstInvalidated) {
          sendJson(res, 401, { error: { action: "rebootstrap", code: "agent_session_ended" } });
          return;
        }
        if (wait === "25") {
          firstWorkerPolls += 1;
          sendJson(res, 200, { messages: [], watermark: 1 });
          const release = releaseSecondSession;
          releaseSecondSession = undefined;
          if (release) setImmediate(release);
          return;
        }
        sendJson(res, 200, { messages: [], watermark: 1 });
        return;
      }
      assert.equal(credential, secondCredential);
      assert.equal(wait, "25");
      secondWorkerPolls += 1;
      let body = { messages: [], watermark: 1 };
      if (activity === "filtered") {
        filteredSecondPolls += 1;
        body = { messages: [{ seq: 2, author: { agent_session_id: "session-other" }, addressing: { kind: "direct", target_agent_session_id: "another-primary-session" } }], watermark: 2 };
      } else if (activity === "relevant") {
        body = { messages: [{ seq: 3, author: { agent_session_id: "session-other" }, addressing: { kind: "direct", target_agent_session_id: "primary-session" } }], watermark: 3 };
      }
      setTimeout(() => sendJson(res, 200, body), 20);
      return;
    }
    sendJson(res, 404, { error: { action: "fix_client", code: "unexpected_path" } });
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    const watch = runWatch(cwd, apiBase, ["1", "primary-session"], {
      PARLE_WAKE_BASE: apiBase,
      PARLE_WATCH_SESSION_LIVENESS: "0",
    });
    await waitFor(() => firstWorkerPolls > 0, "first worker never polled with its initial credential");
    await waitFor(() => secondWorkerPolls >= 2, "replacement worker did not continue polling with the successor credential");
    await waitFor(() => firstInvalidated, "rollover did not retire the first dedicated watcher session");
    assert.equal(watch.child.exitCode, null, `launcher returned during internal rollover: ${watch.err()}${watch.out()}`);
    assert.equal(sessionCreates, 2, "one rollover must produce one replacement session");
    assert.equal(watch.out().includes(firstCredential) || watch.out().includes(secondCredential), false);
    assert.equal(watch.err().includes(firstCredential) || watch.err().includes(secondCredential), false);

    activity = "filtered";
    await waitFor(() => filteredSecondPolls > 0, "replacement worker did not apply the primary-session filter");
    await sleep(100);
    assert.equal(watch.child.exitCode, null, "other-session direct must remain filtered after credential rollover");

    activity = "relevant";
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /relevant activity/);
    assert.deepEqual(ended, [
      [firstSessionId, firstCredential],
      [secondSessionId, secondCredential],
    ]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("external termination is final and ends the current dedicated session once", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-external-stop-"));
  let sessionCreates = 0;
  let heldRequests = 0;
  let endCalls = 0;
  const server = await stubServer({ messages: [], watermark: 1 }, (req, url) => {
    if (req.method === "POST" && url.pathname === "/v/agent/sessions") sessionCreates += 1;
    if (req.method === "GET" && url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "25") heldRequests += 1;
    if (req.method === "POST" && url.pathname.endsWith("/end")) endCalls += 1;
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1"], { PARLE_WATCH_SESSION_LIVENESS: "0" });
    await waitFor(() => heldRequests > 0, "watcher worker did not start before external termination");
    watch.child.kill("SIGTERM");
    assert.equal(await watch.exited, 128);
    assert.equal(sessionCreates, 1, "external termination must not respawn the worker or mint another session");
    assert.equal(endCalls, 1, "external termination must end the current session once");
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("one-argument watch preserves direct config and wakes on the caller's own row", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-direct-"));
  const token = "parle_agt_direct_argv_secret";
  let auth;
  const server = await stubServer((req) => {
    auth = req.headers.authorization;
    return { messages: [{ seq: 2, author: { agent_session_id: "caller-session" } }], watermark: 2 };
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1"], { PARLE_ROOM_AGENT_TOKEN: token });
    assert.equal(await watch.exited, 0);
    assert.equal(auth, `Bearer ${token}`);
    assert.equal(watch.out().includes(token), false);
    assert.equal(watch.err().includes(token), false);
    const sources = [
      readFileSync(script, "utf8"),
      readFileSync(resolve(root, "skills/parle/scripts/parle-watch-worker.sh"), "utf8"),
    ].join("\n");
    assert.doesNotMatch(sources, /Authorization: Bearer \$PARLE_ROOM_AGENT_TOKEN/);
    assert.doesNotMatch(sources, /mktemp/);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("privacy-flat own room-wide rows stay filtered by participant id", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-self-filter-"));
  const session = "session-mine";
  const participant = "participant-mine";
  writeSnapshot(cwd, session, { rooms: [{ roomId: "room-1", participantId: participant, state: "ready" }] });
  const server = await stubServer({
    messages: [
      { seq: 2, author: { agent_session_id: null, participant_id: participant }, addressing: { kind: "unaddressed" } },
      { seq: 3, author: { agent_session_id: null, participant_id: participant }, addressing: { kind: "broadcast" } },
    ],
    watermark: 3,
  });
  try {
    await assertStillWatching(runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", session, participant]));
    await assertStillWatching(runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", session, participant], { PARLE_WATCH_SESSION_LIVENESS: "0" }));
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("privacy-flat peer unaddressed row remains relevant with participant filtering", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-peer-filter-"));
  const server = await stubServer({
    messages: [{ seq: 2, author: { agent_session_id: null, participant_id: "participant-other" }, addressing: { kind: "unaddressed" } }],
    watermark: 2,
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine", "participant-mine"], { PARLE_WATCH_SESSION_LIVENESS: "0" });
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /relevant activity/);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("two-argument watch fails open when participant identity is unavailable", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-self-filter-fallback-"));
  const session = "session-mine";
  writeSnapshot(cwd, session);
  const server = await stubServer({
    messages: [{ seq: 2, author: { agent_session_id: null, participant_id: "participant-mine" }, addressing: { kind: "unaddressed" } }],
    watermark: 2,
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", session]);
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /relevant activity/);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("watch holds with a note when the watched session was never present (era gate)", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-other");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    await sleep(1200);
    assert.equal(watch.child.exitCode, null, `watch exited early: ${watch.err()}${watch.out()}`);
    assert.match(watch.err(), /has never appeared/);
    assert.match(watch.err(), /PARLE_WATCH_SESSION_LIVENESS=0/);
    assert.equal(watch.err().split("has never appeared").length, 2, "note must print exactly once");
    watch.child.kill("SIGKILL");
    await watch.exited;
  } finally {
    server.close();
  }
});

test("watch exits 3 when its session was present and then removed", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-mine");
  writeSnapshot(cwd, "session-other", { pid: process.ppid, processStartedAt: undefined });
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    await sleep(400);
    rmSync(join(cwd, ".parle", "runtime", `${process.pid}.json`));
    const code = await watch.exited;
    assert.equal(code, 3);
    assert.match(watch.err(), /was live in this host's runtime snapshots and is now gone/);
    assert.match(watch.err(), /parle_connect/);
    assert.match(watch.err(), /remaining TTL/);
    assert.match(watch.err(), /parle-watch forensics: watched=session-mine verdict=DEAD/);
    assert.match(watch.err(), /mine=no/);
  } finally {
    server.close();
  }
});

test("watch follows the same live runtime through proactive rollover and updates its filters", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-rollover-"));
  const oldSession = "session-old";
  const newSession = "session-new";
  const oldParticipant = "participant-old";
  const newParticipant = "participant-new";
  let phase = "hold";
  let heldRequests = 0;
  let filteredResponses = 0;
  writeSnapshot(cwd, oldSession, { rooms: [{ roomId: "room-1", participantId: oldParticipant, state: "ready" }] });
  const server = await stubServer((req) => {
    if (phase === "filtered") {
      filteredResponses += 1;
      return {
        messages: [
          { seq: 2, author: { agent_session_id: null, participant_id: newParticipant }, addressing: { kind: "unaddressed" } },
          { seq: 3, author: { agent_session_id: null, participant_id: "participant-other" }, addressing: { kind: "direct", target_agent_session_id: oldSession } },
        ],
        watermark: 3,
      };
    }
    if (phase === "wake") {
      return {
        messages: [{ seq: 4, author: { agent_session_id: null, participant_id: "participant-other" }, addressing: { kind: "direct", target_agent_session_id: newSession } }],
        watermark: 4,
      };
    }
    return { messages: [], watermark: 1 };
  }, (_req, url) => {
    if (url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "25") heldRequests += 1;
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", oldSession, oldParticipant]);
    await waitFor(() => heldRequests >= 2, "watch did not observe the old live runtime");

    // Production runtime publication uses the same atomic replacement: the
    // path, pid, process start, and client instance stay fixed while both room
    // identities change after the candidate commits.
    writeSnapshot(cwd, newSession, { rooms: [{ roomId: "room-1", participantId: newParticipant, state: "ready" }] });
    await waitFor(() => watch.err().includes(`followed primary runtime rollover from ${oldSession} to ${newSession}`), "watch did not follow the verified runtime transition");
    assert.equal(watch.child.exitCode, null, watch.err());

    phase = "filtered";
    await waitFor(() => filteredResponses > 0, "watch did not receive the post-rollover rows");
    await sleep(150);
    assert.equal(watch.child.exitCode, null, "new self row and old-session direct should both be filtered after rollover");

    phase = "wake";
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /relevant activity/);
    assert.doesNotMatch(watch.err(), /verdict=/);
  } finally {
    server.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("watch classifies an in-flight projection under a verified successor snapshot", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-inflight-primary-"));
  const oldSession = "session-inflight-old";
  const newSession = "session-inflight-new";
  let heldResponse;
  writeSnapshot(cwd, oldSession);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://watch.test");
    let response;
    if (req.method === "POST" && url.pathname === "/v/agent/sessions") {
      response = {
        agent_session_id: "019f2946-aef5-77ad-a41d-747ce0fd6a31",
        session_credential: "parle_ses_watch_inflight_private",
        address: "@p.a.watcher",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    } else if (req.method === "POST" && url.pathname.endsWith("/participants")) {
      response = { participant_id: "019f2946-aef5-77ad-a41d-747ce0fd6a32" };
    } else if (req.method === "POST" && url.pathname.endsWith("/end")) {
      res.writeHead(204, { Connection: "close" });
      res.end();
      return;
    } else if (url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "0") {
      response = { messages: [], watermark: 1 };
    } else if (url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "25") {
      heldResponse = res;
      return;
    } else {
      response = { error: { action: "fix_client", code: "unexpected_path" } };
    }
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", oldSession]);
    await waitFor(() => Boolean(heldResponse), "watch did not hold an in-flight primary projection");
    writeSnapshot(cwd, newSession);
    heldResponse.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    heldResponse.end(JSON.stringify({
      messages: [{ seq: 2, author: { agent_session_id: "session-other" }, addressing: { kind: "direct", target_agent_session_id: newSession } }],
      watermark: 2,
    }));
    assert.equal(await watch.exited, 0, watch.err());
    assert.match(watch.out(), /relevant activity/);
    assert.match(watch.err(), /after an in-flight projection/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an observed old snapshot that expires without rewrite exits 3 as failed rollover evidence", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-expiry-"));
  let heldRequests = 0;
  writeSnapshot(cwd, "session-mine");
  const server = await stubServer({ messages: [], watermark: 1 }, (_req, url) => {
    if (url.pathname.endsWith("/projection") && url.searchParams.get("wait") === "25") heldRequests += 1;
  });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    await waitFor(() => heldRequests > 0, "watch did not observe the old snapshot live before expiry");
    writeSnapshot(cwd, "session-mine", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const code = await watch.exited;
    assert.equal(code, 3);
    assert.match(watch.err(), /failed proactive rollover evidence/);
    assert.doesNotMatch(watch.err(), /expected pre-expiry rollover/);
    assert.match(watch.err(), /parle-watch forensics: watched=session-mine verdict=MINE_EXPIRED/);
    assert.match(watch.err(), /mine=yes/);
  } finally {
    server.close();
  }
});

test("a dead writer pid on the own snapshot exits 3 even with no siblings", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  // Unexpired and ready, but the publishing process is gone: affirmative exit,
  // no sibling snapshot needed and no prior live observation required.
  writeSnapshot(cwd, "session-mine", { pid: 99999999 });
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    const code = await watch.exited;
    assert.equal(code, 3);
    assert.match(watch.err(), /no longer running/);
    assert.match(watch.err(), /verdict=MINE_PIDDEAD/);
  } finally {
    server.close();
  }
});

test("a recycled writer pid (start-time mismatch) exits 3 as pid-dead", { skip: (!havePython && "python3/kill unavailable") || (!haveStartVerify && "no /proc or ps for start-time verification") }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  // The pid answers kill(pid, 0) (it is this test process), but the snapshot
  // claims a writer that started long ago: a verifiable start-time mismatch
  // means the pid was recycled and the real writer is gone.
  writeSnapshot(cwd, "session-mine", { processStartedAt: new Date(Date.now() - 7 * 86_400_000).toISOString() });
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    const code = await watch.exited;
    assert.equal(code, 3);
    assert.match(watch.err(), /no longer running/);
    assert.match(watch.err(), /verdict=MINE_PIDDEAD/);
    assert.match(watch.err(), /startcheck=mismatched/);
  } finally {
    server.close();
  }
});

test("a non-ready own snapshot holds with a one-time note while the host retries", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  // Bootstrap retry in progress: own snapshot present but state != ready must
  // hold as inconclusive even while a live sibling would otherwise force DEAD.
  writeSnapshot(cwd, "session-mine", { state: "starting" });
  writeSnapshot(cwd, "session-other", { pid: process.ppid, processStartedAt: undefined });
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    await sleep(1200);
    assert.equal(watch.child.exitCode, null, `watch exited early: ${watch.err()}${watch.out()}`);
    assert.match(watch.err(), /not in the ready state/);
    assert.equal(watch.err().split("not in the ready state").length, 2, "note must print exactly once");
    watch.child.kill("SIGKILL");
    await watch.exited;
  } finally {
    server.close();
  }
});

test("watch survives one transient DEAD liveness cycle", { skip: !havePython && "python3/kill unavailable" }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-watch-"));
  writeSnapshot(cwd, "session-other");
  const server = await stubServer({ messages: [], watermark: 1 });
  try {
    const watch = runWatch(cwd, `http://127.0.0.1:${server.address().port}`, ["1", "session-mine"]);
    await sleep(250);
    writeSnapshot(cwd, "session-mine");
    await assertStillWatching(watch);
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
