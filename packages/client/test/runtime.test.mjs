import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  ParleAgentClient,
  processClientInstanceId,
  isLiveRuntimeSnapshot,
  runtimeDirPath,
  runtimeFilePath,
} from "../dist/index.js";

const ENV = { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token", PARLE_ROOM_HANDLE: "test-room" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function happyFetch(counters = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      counters.sessions = (counters.sessions || 0) + 1;
      return json({ agent_session_id: "as-1", session_credential: "parle_ses_secret1", address: "@p.a.s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (u.includes("/end")) {
      counters.ends = (counters.ends || 0) + 1;
      return json({});
    }
    if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
    if (u.includes("/projection")) return json({ watermark: 7, messages: [] });
    return json({});
  };
}

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "parle-runtime-"));
}

function snapshotFor(pid, overrides = {}) {
  return {
    schemaVersion: 1,
    pid,
    processStartedAt: new Date().toISOString(),
    state: "ready",
    sessionAddress: "@p.a.other",
    agentSessionId: "as-x",
    roomId: "room-1",
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    adapter: { name: "test" },
    ...overrides,
  };
}

function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  return child.pid;
}

test("concurrent bootstrap callers converge on a single session mint", async () => {
  const counters = {};
  const client = new ParleAgentClient({ env: ENV, fetch: happyFetch(counters) });
  await Promise.all([client.connect(), client.connect(), client.ensureBootstrapped()]);
  assert.equal(counters.sessions, 1);
  assert.equal(client.runtime.bootstrapState, "ready");
  assert.equal(client.runtime.cursor, 7);
});

test("bootstrap failure records failed state with backoff and ensureReadySafe respects the window", async () => {
  let nowMs = Date.parse("2026-07-07T00:00:00Z");
  let attempts = 0;
  const client = new ParleAgentClient({
    env: ENV,
    now: () => new Date(nowMs),
    fetch: async () => {
      attempts += 1;
      return json({ error: { code: "boom", message: "server down" } }, 500);
    },
  });
  assert.equal(await client.ensureReadySafe(), true);
  assert.equal(attempts, 1);
  assert.equal(client.runtime.bootstrapState, "failed");
  assert.match(client.runtime.lastBootstrapError, /server down/);
  assert.equal(client.runtime.nextRetryAt, new Date(nowMs + 5000).toISOString());
  // Inside the backoff window: no attempt.
  assert.equal(await client.ensureReadySafe(), false);
  assert.equal(attempts, 1);
  // Past the window: retries, and backoff doubles.
  nowMs += 6000;
  assert.equal(await client.ensureReadySafe(), true);
  assert.equal(attempts, 2);
  assert.equal(client.runtime.nextRetryAt, new Date(nowMs + 10_000).toISOString());
  // Explicit user-paced calls always retry, even inside the window.
  await assert.rejects(() => client.connect());
  assert.equal(attempts, 3);
});

test("ensureReadySafe is a no-op without configuration or when already live", async () => {
  let fetched = 0;
  // HOME must point somewhere empty: with a bare env the catalog path falls
  // back to the real home directory, and a developer's ~/.parle/profiles
  // [default] would make this client configured.
  const unconfigured = new ParleAgentClient({ env: { HOME: tempCwd() }, fetch: async () => { fetched += 1; return json({}); } });
  assert.equal(await unconfigured.ensureReadySafe(), false);
  assert.equal(fetched, 0);
  const counters = {};
  const live = new ParleAgentClient({ env: ENV, fetch: happyFetch(counters) });
  assert.equal(await live.ensureReadySafe(), true);
  assert.equal(await live.ensureReadySafe(), false);
  assert.equal(counters.sessions, 1);
});

test("publishRuntime writes a credential-free 0600 snapshot and endSession removes it", async () => {
  const cwd = tempCwd();
  try {
    const counters = {};
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: happyFetch(counters), publishRuntime: { adapterName: "@parlehq/mcp-server", adapterVersion: "0.4.0" } });
    await client.connect();
    const path = runtimeFilePath(cwd, process.pid);
    assert.ok(existsSync(path));
    const raw = readFileSync(path, "utf8");
    assert.doesNotMatch(raw, /parle_ses_/);
    assert.doesNotMatch(raw, /opaque-token/);
    const snapshot = JSON.parse(raw);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.clientInstanceId, processClientInstanceId());
    assert.equal(snapshot.clientInstanceId, client.clientInstanceId);
    assert.equal(snapshot.sessionAddress, "@p.a.s1");
    assert.equal(snapshot.agentSessionId, "as-1");
    assert.equal(snapshot.roomHandle, "test-room");
    assert.equal(snapshot.adapter.name, "@parlehq/mcp-server");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(runtimeDirPath(cwd)).mode & 0o777, 0o700);
    await client.endSession();
    assert.equal(counters.ends, 1);
    assert.equal(existsSync(path), false);
    assert.equal(client.runtime.bootstrapped, false);
    assert.equal(client.runtime.bootstrapState, "unstarted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bootstrap failure publishes a failed snapshot readers reject", async () => {
  const cwd = tempCwd();
  try {
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: async () => json({}, 500), publishRuntime: { adapterName: "test" } });
    await client.ensureReadySafe();
    const snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.state, "failed");
    assert.ok(snapshot.lastError);
    assert.equal(isLiveRuntimeSnapshot(snapshot, new Date()), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("construction prunes provably stale sibling files and keeps uncertain ones", () => {
  const cwd = tempCwd();
  try {
    const dir = runtimeDirPath(cwd);
    mkdirSync(dir, { recursive: true });
    const gone = deadPid();
    writeFileSync(join(dir, "expired.json"), JSON.stringify(snapshotFor(process.pid + 1, { expiresAt: new Date(Date.now() - 1000).toISOString() })));
    writeFileSync(join(dir, "dead.json"), JSON.stringify(snapshotFor(gone)));
    writeFileSync(join(dir, "uncertain.json"), JSON.stringify(snapshotFor(1)));
    writeFileSync(join(dir, ".tmp-ignored"), "not json");
    new ParleAgentClient({ cwd, env: ENV, publishRuntime: { adapterName: "test" } });
    assert.equal(existsSync(join(dir, "expired.json")), false);
    assert.equal(existsSync(join(dir, "dead.json")), false);
    assert.equal(existsSync(join(dir, "uncertain.json")), true);
    assert.equal(existsSync(join(dir, ".tmp-ignored")), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("isLiveRuntimeSnapshot gates on schema, state, expiry, and pid liveness", () => {
  const now = new Date();
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid), now), true);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { state: "failed" }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { schemaVersion: 2 }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { expiresAt: new Date(now.getTime() + 1000).toISOString() }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { expiresAt: "" }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(deadPid()), now), false);
});

function unreadFetch(counters = {}, rows = () => []) {
  const happy = happyFetch(counters);
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/inbound?")) {
      counters.inbound = (counters.inbound || 0) + 1;
      counters.lastInboundUrl = u;
      return json({ watermark: 7, messages: rows() });
    }
    return happy(url, init);
  };
}

async function runCursorRead({ cursor = 7, messages = [], watermark = 20, params = {} }) {
  const counters = {};
  const happy = happyFetch(counters);
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      if (String(url).includes("/inbound?")) return json({ watermark, messages });
      return happy(url, init);
    },
  });
  await client.connect();
  client.runtime.cursor = cursor;
  client.runtime.unreadCount = 5;
  const result = await client.readInbox(params);
  return { client, result };
}

test("read cursor precedence follows the seven-row contract", async (t) => {
  await t.test("omitted sinceSeq and advanceCursor commits returned rows or an empty response watermark", async () => {
    const returned = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }] });
    assert.equal(returned.result.cursorBefore, 7);
    assert.equal(returned.result.cursorAfter, 9);
    assert.equal(returned.result.advancedCursor, true);
    assert.equal(returned.client.runtime.unreadCount, 0);

    const empty = await runCursorRead({ messages: [], watermark: 20 });
    assert.equal(empty.result.cursorAfter, 20);
    assert.equal(empty.result.advancedCursor, true);
    assert.equal(empty.client.runtime.unreadCount, 0);
  });

  await t.test("explicit true without sinceSeq has the default commit behavior", async () => {
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params: { advanceCursor: true } });
    assert.equal(result.cursorAfter, 9);
    assert.equal(result.advancedCursor, true);
    assert.equal(client.runtime.unreadCount, 0);
  });

  await t.test("explicit false never advances with or without sinceSeq", async () => {
    for (const params of [{ advanceCursor: false }, { sinceSeq: 2, advanceCursor: false }]) {
      const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params });
      assert.equal(result.cursorBefore, 7);
      assert.equal(result.cursorAfter, 7);
      assert.equal(result.advancedCursor, false);
      assert.equal(client.runtime.unreadCount, 5);
    }
  });

  await t.test("explicit sinceSeq defaults to an audit read", async () => {
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params: { sinceSeq: 2 } });
    assert.equal(result.cursorAfter, 7);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.runtime.unreadCount, 5);
  });

  await t.test("explicit sinceSeq plus true commits only returned capped rows and recomputes unread", async () => {
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }, { seq: 10 }], params: { sinceSeq: 2, advanceCursor: true, limitMessages: 2 } });
    assert.equal(result.cursorBefore, 7);
    assert.equal(result.cursorAfter, 9);
    assert.equal(result.advancedCursor, true);
    assert.deepEqual(result.messages.map((row) => row.seq), [8, 9]);
    assert.equal(result.truncated, true);
    assert.equal(client.runtime.unreadCount, 1, "the capped row beyond the committed cursor remains unread");
  });

  await t.test("an empty explicit commit never jumps to the watermark or erases unread state", async () => {
    const { client, result } = await runCursorRead({ messages: [], watermark: 20, params: { sinceSeq: 2, advanceCursor: true } });
    assert.equal(result.cursorBefore, 7);
    assert.equal(result.cursorAfter, 7);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.runtime.unreadCount, 5);
  });

  await t.test("cursor movement is monotonic and a no-op explicit commit preserves unread state", async () => {
    const { client, result } = await runCursorRead({ cursor: 12, messages: [{ seq: 8 }, { seq: 9 }], params: { sinceSeq: 2, advanceCursor: true } });
    assert.equal(result.cursorBefore, 12);
    assert.equal(result.cursorAfter, 12);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.runtime.unreadCount, 5);
  });
});

test("observeUnread counts without advancing the cursor and repeated polls are idempotent", async () => {
  const counters = {};
  const client = new ParleAgentClient({ env: ENV, fetch: unreadFetch(counters, () => [{ seq: 8 }, { seq: 9 }]) });
  await client.connect();
  assert.equal(client.runtime.cursor, 7);
  await client.observeUnread();
  assert.equal(client.runtime.unreadCount, 2);
  assert.equal(client.runtime.cursor, 7);
  assert.match(counters.lastInboundUrl, /since_seq=7&wait=0/);
  await client.observeUnread();
  assert.equal(client.runtime.unreadCount, 2);
  assert.equal(client.runtime.cursor, 7);
  assert.equal(counters.inbound, 2);
  assert.match(counters.lastInboundUrl, /since_seq=7&wait=0/);
});

test("a drain during an in-flight observation discards the stale count", async () => {
  const counters = {};
  let releaseInbound;
  const gate = new Promise((resolve) => { releaseInbound = resolve; });
  const happy = happyFetch(counters);
  let inboundCalls = 0;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/inbound?")) {
        inboundCalls += 1;
        // First inbound request is the observation: hold it while the drain
        // (second inbound request) completes.
        if (inboundCalls === 1) await gate;
        return json({ watermark: 9, messages: [{ seq: 8 }, { seq: 9 }] });
      }
      return happy(url, init);
    },
  });
  await client.connect();
  const observation = client.observeUnread();
  await client.readInbox();
  assert.equal(client.runtime.cursor, 9);
  assert.equal(client.runtime.unreadCount, 0);
  releaseInbound();
  await observation;
  assert.equal(client.runtime.unreadCount, 0, "stale positive count must not resurrect after a drain");
});

test("draining reads republish the remaining count and steady zero writes nothing", async () => {
  const cwd = tempCwd();
  try {
    const counters = {};
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: unreadFetch(counters, () => [{ seq: 8 }]), publishRuntime: { adapterName: "test" } });
    await client.connect();
    await client.observeUnread();
    assert.equal(client.runtime.unreadCount, 1);
    let snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.unreadCount, 1);
    assert.ok(snapshot.unreadAsOf);
    // Drain: readInbox advances the cursor past seq 8 and republishes zero.
    await client.readInbox();
    assert.equal(client.runtime.cursor, 8);
    snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.unreadCount, 0);
    const asOfAfterDrain = snapshot.unreadAsOf;
    // Steady zero: the stub still returns seq 8, now behind the cursor, so the
    // next observation counts zero and must not rewrite the runtime file.
    await client.observeUnread();
    snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.unreadCount, 0);
    assert.equal(snapshot.unreadAsOf, asOfAfterDrain, "steady zero must not rewrite the runtime file");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("observation failures never touch session state", async () => {
  const counters = {};
  let failInbound = false;
  const base = unreadFetch(counters, () => [{ seq: 8 }]);
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      if (String(url).includes("/inbound?") && failInbound) return json({ error: { message: "down" } }, 500);
      return base(url, init);
    },
  });
  await client.connect();
  await client.observeUnread();
  assert.equal(client.runtime.unreadCount, 1);
  failInbound = true;
  await client.observeUnread();
  assert.equal(client.runtime.bootstrapState, "ready");
  assert.equal(client.runtime.unreadCount, 1, "failed observation leaves the prior count to age out");
});

test("unread poll interval parses with a floor, cap, and zero-disable", () => {
  const make = (value) => new ParleAgentClient({ env: { ...ENV, ...(value === undefined ? {} : { PARLE_UNREAD_POLL_INTERVAL_SECONDS: value }) } });
  assert.equal(make(undefined).unreadPollIntervalMs(), 60_000);
  assert.equal(make("0").unreadPollIntervalMs(), 0);
  assert.equal(make("-5").unreadPollIntervalMs(), 0);
  assert.equal(make("garbage").unreadPollIntervalMs(), 0);
  assert.equal(make("5").unreadPollIntervalMs(), 15_000);
  assert.equal(make("7200").unreadPollIntervalMs(), 3_600_000);
});

test("consecutive bootstrap successes never duplicate the unread poll loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cwd = tempCwd();
  try {
    const counters = {};
    const client = new ParleAgentClient({
      cwd,
      env: { ...ENV, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "15" },
      fetch: unreadFetch(counters, () => []),
      publishRuntime: { adapterName: "test" },
    });
    await client.connect();
    // Forced rebootstrap (the 401-recovery path) also lands on the success hook.
    await client.bootstrap(undefined, true);
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(counters.inbound ?? 0, 1, "one poll tick after two bootstraps, not two loops");
    t.mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(counters.inbound, 2, "the chain continues singly");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("misconfigured poll interval surfaces a status warning instead of silently disabling", () => {
  const bad = new ParleAgentClient({ env: { ...ENV, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "garbage" } });
  assert.match(bad.status().warnings.join(" "), /unread polling is disabled/);
  const explicitOff = new ParleAgentClient({ env: { ...ENV, PARLE_UNREAD_POLL_INTERVAL_SECONDS: "0" } });
  assert.equal(explicitOff.status().warnings.length, 0);
  const normal = new ParleAgentClient({ env: ENV });
  assert.equal(normal.status().warnings.length, 0);
});

test("status exposes bootstrap state and keeps the session credential redacted", async () => {
  const client = new ParleAgentClient({ env: ENV, fetch: happyFetch() });
  await client.connect();
  const status = client.status();
  assert.equal(status.runtime.bootstrapState, "ready");
  assert.equal(status.runtime.sessionHandle, "<redacted>");
  assert.doesNotMatch(JSON.stringify(status), /parle_ses_/);
});
