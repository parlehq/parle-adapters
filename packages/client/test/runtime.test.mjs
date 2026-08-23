import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  MIN_READ_LIMIT_BYTES,
  READ_LIMIT_BYTES,
  ParleAgentClient,
  capProjectionMessages,
  clampReadLimitBytes,
  processClientInstanceId,
  isLiveRuntimeSnapshot,
  pruneRuntimeFiles,
  responsiveDeliveryRuntimeDirPath,
  responsiveDeliveryRuntimeFilePath,
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
    // Entry carries the ADR-0106 held-safe baseline: the bootstrap cursor comes
    // from here, never from a cursor-zero history read.
    if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 7 }, 201);
    if (u.includes("/projection")) return json({ generation: "g0", watermark: 7, next_since_seq: 7, has_more: false, messages: [] });
    return json({});
  };
}

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "parle-runtime-"));
}

function snapshotFor(pid, overrides = {}) {
  return {
    schemaVersion: 2,
    pid,
    processStartedAt: new Date().toISOString(),
    state: "ready",
    sessionAddress: "@p.a.other",
    agentSessionId: "as-x",
    rooms: [{ roomId: "room-1", state: "ready" }],
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

test("client construction prunes shared runtime state even without publication", () => {
  const cwd = tempCwd();
  try {
    const now = new Date();
    const gone = deadPid();
    const runtimeDir = runtimeDirPath(cwd);
    const responsiveDir = responsiveDeliveryRuntimeDirPath(cwd);
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    mkdirSync(responsiveDir, { recursive: true, mode: 0o700 });
    writeFileSync(runtimeFilePath(cwd, gone), JSON.stringify(snapshotFor(gone, { expiresAt: new Date(now.getTime() - 1).toISOString() })), { mode: 0o600 });
    writeFileSync(responsiveDeliveryRuntimeFilePath(cwd, gone), JSON.stringify({
      schemaVersion: 1,
      pid: gone,
      processStartedAt: new Date(now.getTime() - 60_000).toISOString(),
      publisher: { name: "test", clientInstanceId: "dead-instance" },
      target: { agentSessionId: "dead-session" },
      state: "watching",
      updatedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() - 1).toISOString(),
    }), { mode: 0o600 });

    new ParleAgentClient({ cwd, env: ENV, now: () => now });

    assert.equal(existsSync(runtimeFilePath(cwd, gone)), false);
    assert.equal(existsSync(responsiveDeliveryRuntimeFilePath(cwd, gone)), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("concurrent bootstrap callers converge on a single session mint", async () => {
  const counters = {};
  const client = new ParleAgentClient({ env: ENV, fetch: happyFetch(counters) });
  await Promise.all([client.connect(), client.connect(), client.ensureBootstrapped()]);
  assert.equal(counters.sessions, 1);
  assert.equal(client.runtime.bootstrapState, "ready");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7);
});

test("bootstrap failure records failed state with backoff and ensureReadySafe respects the window", async () => {
  let nowMs = Date.parse("2026-08-01T00:00:00Z");
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
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(snapshot.state, "ready");
    assert.deepEqual(snapshot.rooms, [{ roomId: "room-1", roomHandle: "test-room", participantId: "part-1", state: "ready" }]);
    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.clientInstanceId, processClientInstanceId());
    assert.equal(snapshot.clientInstanceId, client.clientInstanceId);
    assert.equal(snapshot.sessionAddress, "@p.a.s1");
    assert.equal(snapshot.agentSessionId, "as-1");
    assert.equal(snapshot.rooms[0].roomHandle, "test-room");
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

test("bootstrap failure publishes a failed snapshot without a generic error alias", async () => {
  const cwd = tempCwd();
  try {
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: async () => json({}, 500), publishRuntime: { adapterName: "test" } });
    await client.ensureReadySafe();
    const snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.state, "failed");
    assert.equal(Object.hasOwn(snapshot, "lastError"), false);
    assert.equal(isLiveRuntimeSnapshot(snapshot, new Date()), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("status and runtime publication omit only a duplicated bootstrap error", async () => {
  const cwd = tempCwd();
  try {
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: happyFetch(), publishRuntime: { adapterName: "test" } });
    await client.connect();
    client.runtime.lastBootstrapError = "replacement deferred";
    client.runtime.lastError = "replacement deferred";
    assert.equal(client.status().runtime.lastBootstrapError, "replacement deferred");
    assert.equal(Object.hasOwn(client.status().runtime, "lastError"), false);

    await client.observeUnread();
    let snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(Object.hasOwn(snapshot, "lastError"), false);

    client.runtime.lastError = "distinct lifecycle failure";
    assert.equal(client.status().runtime.lastError, "distinct lifecycle failure");
    client.roomRuntime(client.cfg.roomId.value).unreadCount = undefined;
    await client.observeUnread();
    snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.lastError, "distinct lifecycle failure");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime pruning requires expiry and dead ownership and bounds each sweep", () => {
  const cwd = tempCwd();
  try {
    const dir = runtimeDirPath(cwd);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = new Date();
    const gone = deadPid();
    writeFileSync(join(dir, "expired-dead.json"), JSON.stringify(snapshotFor(gone, { expiresAt: new Date(now.getTime() - 1000).toISOString() })), { mode: 0o600 });
    writeFileSync(join(dir, "expired-live.json"), JSON.stringify(snapshotFor(process.pid, { expiresAt: new Date(now.getTime() - 1000).toISOString() })), { mode: 0o600 });
    writeFileSync(join(dir, "fresh-dead.json"), JSON.stringify(snapshotFor(gone)), { mode: 0o600 });
    writeFileSync(join(dir, "uncertain.json"), JSON.stringify(snapshotFor(1, { expiresAt: new Date(now.getTime() - 1000).toISOString() })), { mode: 0o600 });
    writeFileSync(join(dir, ".tmp-ignored"), "not json");
    let inspections = 0;
    pruneRuntimeFiles(cwd, now, { inspectPid: (pid) => { inspections += 1; return pid === gone ? "dead" : pid === process.pid ? "alive" : "uncertain"; }, maxInspections: 1, maxRemovals: 1 });
    assert.equal(inspections, 2, "one candidate is checked before and after quarantine");
    assert.equal(existsSync(join(dir, "expired-dead.json")), false);
    assert.equal(existsSync(join(dir, "expired-live.json")), true);
    assert.equal(existsSync(join(dir, "fresh-dead.json")), true);
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
  // Hard cut: v2 only. Neither the retired v1 nor a future schema reads live.
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { schemaVersion: 1 }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { schemaVersion: 3 }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { expiresAt: new Date(now.getTime() + 1000).toISOString() }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(process.pid, { expiresAt: "" }), now), false);
  assert.equal(isLiveRuntimeSnapshot(snapshotFor(deadPid()), now), false);
});

function unreadFetch(counters = {}, rows = () => [], heldCount) {
  const happy = happyFetch(counters);
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/inbound?")) {
      counters.inbound = (counters.inbound || 0) + 1;
      counters.lastInboundUrl = u;
      return json({ watermark: 7, messages: rows(), ...(typeof heldCount === "number" ? { held_backlog: { held_count: heldCount } } : {}) });
    }
    return happy(url, init);
  };
}

async function runCursorRead({ cursor = 7, messages = [], watermark = 20, params = {}, heldCount, initialHeldCount, nextSinceSeq, hasMore = false, generation }) {
  const counters = {};
  const happy = happyFetch(counters);
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      if (String(url).includes("/inbound?")) {
        return json({
          watermark,
          messages,
          has_more: hasMore,
          ...(typeof nextSinceSeq === "number" ? { next_since_seq: nextSinceSeq } : {}),
          ...(generation ? { generation } : {}),
          ...(typeof heldCount === "number" ? { held_backlog: { held_count: heldCount } } : {}),
        });
      }
      return happy(url, init);
    },
  });
  await client.connect();
  // Cursors live on the room runtime; runtime.cursor is its single-room projection.
  const seed = client.roomRuntime(client.cfg.roomId.value);
  seed.cursor = cursor;
  seed.unreadCount = 5;
  if (typeof initialHeldCount === "number") seed.heldBacklogCount = initialHeldCount;
  const result = await client.readInbox(params);
  return { client, result };
}

test("read cursor precedence follows the seven-row contract", async (t) => {
  await t.test("omitted sinceSeq and advanceCursor commits page progress, never the watermark", async () => {
    const returned = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], nextSinceSeq: 9 });
    assert.equal(returned.result.cursorBefore, 7);
    assert.equal(returned.result.cursorAfter, 9);
    assert.equal(returned.result.advancedCursor, true);
    assert.equal(returned.client.roomRuntime(returned.client.cfg.roomId.value).unreadCount, 0);

    // A progress-only page: blocked, own-authored, or differently addressed
    // rows were consumed, so the cursor follows next_since_seq with no rows.
    const progressOnly = await runCursorRead({ messages: [], watermark: 20, nextSinceSeq: 15 });
    assert.equal(progressOnly.result.cursorAfter, 15);
    assert.equal(progressOnly.result.advancedCursor, true);
    assert.equal(progressOnly.client.roomRuntime(progressOnly.client.cfg.roomId.value).unreadCount, 0);

    // The watermark is participant-wide disclosure authorization, not this
    // response's progress: an empty page without progress moves nothing.
    const empty = await runCursorRead({ messages: [], watermark: 20 });
    assert.equal(empty.result.cursorAfter, 7);
    assert.equal(empty.result.advancedCursor, false);
    assert.equal(empty.client.roomRuntime(empty.client.cfg.roomId.value).unreadCount, 0);
  });

  await t.test("an envelope without next_since_seq is a complete delta ending at the last returned row", async () => {
    // ADR-0106 item 9, the permanent rollback valve: an old-shape response is
    // complete, and its next cursor is response-local — never the watermark,
    // which a concurrent read can push past rows this response did not carry.
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], watermark: 40 });
    assert.equal(result.cursorAfter, 9);
    assert.equal(result.hasMore, false);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 9);
  });

  await t.test("explicit true without sinceSeq has the default commit behavior", async () => {
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params: { advanceCursor: true } });
    assert.equal(result.cursorAfter, 9);
    assert.equal(result.advancedCursor, true);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 0);
  });

  await t.test("explicit false never advances with or without sinceSeq", async () => {
    for (const params of [{ advanceCursor: false }, { sinceSeq: 2, advanceCursor: false }]) {
      const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params });
      assert.equal(result.cursorBefore, 7);
      assert.equal(result.cursorAfter, 7);
      assert.equal(result.advancedCursor, false);
      assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 5);
    }
  });

  await t.test("explicit sinceSeq defaults to an audit read and refreshes held diagnostics", async () => {
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }], params: { sinceSeq: 2 }, initialHeldCount: 1, heldCount: 0 });
    assert.equal(result.cursorAfter, 7);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 5);
    assert.equal(client.status().runtime.rooms[0].heldBacklogCount, 0);
  });

  await t.test("explicit sinceSeq plus true commits only returned capped rows and recomputes unread", async () => {
    // next_since_seq reaches past the local cap: progress must stop at the last
    // row the caller actually saw or the dropped row is skipped forever.
    const { client, result } = await runCursorRead({ messages: [{ seq: 8 }, { seq: 9 }, { seq: 10 }], nextSinceSeq: 10, params: { sinceSeq: 2, advanceCursor: true, limitMessages: 2 } });
    assert.equal(result.cursorBefore, 7);
    assert.equal(result.cursorAfter, 9);
    assert.equal(result.advancedCursor, true);
    assert.deepEqual(result.messages.map((row) => row.seq), [8, 9]);
    assert.equal(result.truncated, true);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 1, "the capped row beyond the committed cursor remains unread");
  });

  await t.test("an empty explicit commit never jumps to the watermark or erases unread state", async () => {
    const { client, result } = await runCursorRead({ messages: [], watermark: 20, params: { sinceSeq: 2, advanceCursor: true } });
    assert.equal(result.cursorBefore, 7);
    assert.equal(result.cursorAfter, 7);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 5);
  });

  await t.test("cursor movement is monotonic and a no-op explicit commit preserves unread state", async () => {
    const { client, result } = await runCursorRead({ cursor: 12, messages: [{ seq: 8 }, { seq: 9 }], params: { sinceSeq: 2, advanceCursor: true } });
    assert.equal(result.cursorBefore, 12);
    assert.equal(result.cursorAfter, 12);
    assert.equal(result.advancedCursor, false);
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 5);
  });
});

// ADR-0106 / parlehq/parle#927: bounded room reads.

test("fresh bootstrap starts at the entry baseline and never reads room history", async () => {
  const urls = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_secret1", address: "@p.a.s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      // A deep room: 7751 authored events, the #922 evidence shape.
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 7751 }, 201);
      if (u.includes("/projection")) return json({ generation: "g0", watermark: 9999, next_since_seq: 7751, has_more: false, messages: [], held_backlog: { held_count: 3 } });
      return json({});
    },
  });
  await client.connect();
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7751, "the cursor is the entry baseline");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).heldBacklogCount, 3, "the held marker still reaches the connection card");
  const projections = urls.filter((u) => u.includes("/projection"));
  assert.equal(projections.length, 1, "one page, not a history sweep");
  assert.match(projections[0], /since_seq=7751/);
  assert.equal(projections.some((u) => /since_seq=0(&|$)/.test(u)), false, "never from cursor zero");
});

test("rebootstrap preserves the established cursor against a moved baseline", async () => {
  let sessions = 0;
  const entries = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) {
        sessions += 1;
        return json({ agent_session_id: `as-${sessions}`, session_credential: `parle_ses_s${sessions}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      // The room head moved a long way while this process was reading. A
      // rebootstrap must NOT jump the cursor to the newer baseline.
      if (u.endsWith("/participants")) {
        entries.push(u);
        return json({ participant_id: "part-1", generation: "g0", baseline_seq: entries.length === 1 ? 7 : 900 }, 201);
      }
      if (u.includes("/projection")) return json({ generation: "g0", watermark: 900, next_since_seq: 7, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  assert.equal(room.cursor, 7);
  room.cursor = 12;
  await client.bootstrap(undefined, true);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 12, "the established cursor survives, baseline 900 does not replace it");
  assert.equal(entries.length, 2);
});

test("recovery of a degraded room preserves an established cursor", async () => {
  const client = new ParleAgentClient({ env: ENV, fetch: happyFetch({}) });
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  room.cursor = 30;
  room.state = "degraded";
  assert.equal(await client.recoverRoom(room.roomId), true);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 30, "recovery reconciles entry without resetting the cursor");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).state, "ready");
});

test("a generation change at room entry discards the established cursor for the new baseline", async () => {
  let sessions = 0;
  const entries = [];
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) {
        sessions += 1;
        return json({ agent_session_id: `as-${sessions}`, session_credential: `parle_ses_s${sessions}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      // The stream was restored between the two entries: the second entry
      // reports a different generation, so the cursor carried from the first
      // names rows in a stream that no longer exists.
      if (u.endsWith("/participants")) {
        entries.push(u);
        return json({ participant_id: "part-1", generation: entries.length === 1 ? "g0" : "g1", baseline_seq: entries.length === 1 ? 700 : 4 }, 201);
      }
      if (u.includes("/projection")) return json({ generation: entries.length === 1 ? "g0" : "g1", watermark: 0, next_since_seq: entries.length === 1 ? 700 : 4, has_more: false, messages: [] });
      if (u.includes("/inbound")) return json({ generation: "g1", watermark: 0, next_since_seq: 4, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  assert.equal(room.cursor, 700);
  room.cursor = 800;
  await client.bootstrap(undefined, true);
  const after = client.roomRuntime(client.cfg.roomId.value);
  assert.equal(after.cursor, 4, "a retired cursor takes the new stream's baseline instead of being preserved");
  assert.equal(after.streamGeneration, "g1");
  // The reset happened at entry, where there was no read result to carry it;
  // the next read reports it and clears it.
  const read = await client.readInbox();
  assert.equal(read.streamReset, true);
  assert.match(read.note, /stream generation changed/);
  const second = await client.readInbox();
  assert.equal(second.streamReset, undefined, "the marker is reported once");
});

test("a reset between entry and the bootstrap page discards the baseline it invalidated", async () => {
  // The stream is replaced in the window between room entry and the validation
  // read: entry hands back g0 and a deep baseline, the page comes back under
  // g1. Adopting g1 while keeping the g0 baseline would strand the room AND
  // make every later reset undetectable, because the stored generation would
  // then match forever.
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 900 }, 201);
      if (u.includes("/projection")) return json({ generation: "g1", watermark: 12, next_since_seq: 12, has_more: false, messages: [{ seq: 6 }, { seq: 9 }] });
      if (u.includes("/inbound")) return json({ generation: "g1", watermark: 12, next_since_seq: 5, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  assert.equal(room.streamGeneration, "g1");
  // The validation page discards its rows, so the cursor parks immediately
  // before the earliest row it disclosed rather than taking its progress.
  assert.equal(room.cursor, 5, "the retired baseline is replaced without skipping the discarded rows");
  const read = await client.readInbox();
  assert.equal(read.streamReset, true, "the entry-window reset is reported by the first read");
});

test("a reset with no rows on the bootstrap page takes that page's own progress", async () => {
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 900 }, 201);
      if (u.includes("/projection")) return json({ generation: "g1", watermark: 40, next_since_seq: 11, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 11);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).streamGeneration, "g1");
});

test("a rollover that preserves the cursor also preserves the held-backlog warning", async () => {
  // The preserved cursor skips the bootstrap page, so nothing re-reads the
  // diagnostic. Dropping it would turn every ordinary rollover into a silent
  // all-clear on a room that still has rows awaiting scan.
  let sessions = 0;
  let projections = 0;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) {
        sessions += 1;
        return json({ agent_session_id: `as-${sessions}`, session_credential: `parle_ses_s${sessions}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      }
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 7 }, 201);
      if (u.includes("/projection")) {
        projections += 1;
        return json({ generation: "g0", watermark: 7, next_since_seq: 7, has_more: false, messages: [], held_backlog: { held_count: 2 } });
      }
      return json({});
    },
  });
  await client.connect();
  assert.equal(client.roomRuntime(client.cfg.roomId.value).heldBacklogCount, 2);
  await client.bootstrap(undefined, true);
  assert.equal(projections, 1, "the preserved cursor still skips the bootstrap page");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).heldBacklogCount, 2, "the standing warning survives the rollover");
  assert.equal(client.connectionSummary().rooms[0].heldBacklogCount, 2);
});

test("a drain over an entry-time reset consumes its page instead of repeating it", async () => {
  let entries = 0;
  let inbounds = 0;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) {
        entries += 1;
        return json({ participant_id: "part-1", generation: entries === 1 ? "g0" : "g1", baseline_seq: entries === 1 ? 7 : 4 }, 201);
      }
      if (u.includes("/projection")) return json({ generation: entries === 1 ? "g0" : "g1", watermark: 7, next_since_seq: entries === 1 ? 7 : 4, has_more: false, messages: [] });
      if (u.includes("/inbound")) {
        inbounds += 1;
        // The reset was already adopted at entry, so these pages belong to the
        // CURRENT stream and their continuation is trustworthy.
        return json({ generation: "g1", watermark: 9, next_since_seq: 5, has_more: false, messages: inbounds === 1 ? [{ seq: 5, event_id: "e5" }] : [] });
      }
      return json({});
    },
  });
  await client.connect();
  await client.bootstrap(undefined, true);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 4);

  const first = await client.drainInbox();
  assert.equal(first.streamReset, true, "the entry-time reset is still reported at the boundary");
  assert.deepEqual(first.messages.map((row) => row.seq), [5]);
  assert.equal(first.cursorAfter, 5, "the page it returned is consumed, not discarded");

  const second = await client.drainInbox();
  assert.deepEqual(second.messages, [], "the next drain does not repeat the rows the first one returned");
  assert.equal(second.cursorAfter, 5);
});

test("recovery discards a cursor the entry generation retired", async () => {
  let entries = 0;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) {
        entries += 1;
        return json({ participant_id: "part-1", generation: entries === 1 ? "g0" : "g1", baseline_seq: entries === 1 ? 7 : 2 }, 201);
      }
      if (u.includes("/projection")) return json({ generation: entries === 1 ? "g0" : "g1", watermark: 0, next_since_seq: entries === 1 ? 7 : 2, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  room.cursor = 50;
  room.state = "degraded";
  assert.equal(await client.recoverRoom(room.roomId), true);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 2, "the retired cursor is replaced by the new stream's baseline");
});

test("a stream generation change resets the cursor to the position the server reports", async () => {
  const { client, result } = await runCursorRead({ cursor: 700, messages: [], generation: "g1", nextSinceSeq: 3 });
  assert.equal(result.streamReset, true);
  assert.equal(result.cursorAfter, 3, "a retired generation's cursor is not carried forward");
  assert.equal(result.nextCursor, 3, "the continuation is the new stream's position, not the retired 700");
  assert.match(result.note, /stream generation changed/);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 3);

  // With rows in the reset page the continuation is still the new stream's own
  // coordinate; anchoring at the retired cursor would strand the reader at 700.
  const withRows = await runCursorRead({ cursor: 700, messages: [{ seq: 2 }], generation: "g1", nextSinceSeq: 2 });
  assert.equal(withRows.result.nextCursor, 2);
  assert.equal(withRows.result.cursorAfter, 2);
});

test("a delayed response from a retired generation is fenced, not read as another reset", async () => {
  // Reads overlap. A response minted before a reset can land after the reset
  // was adopted, and its generation differs from the stored one exactly the way
  // a genuine change does — so without a fence it would drag the cursor and the
  // stored generation back to coordinates that no longer exist.
  let generation = "g0";
  let nextSince = 7;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 7 }, 201);
      if (u.includes("/projection")) return json({ generation: "g0", watermark: 7, next_since_seq: 7, has_more: false, messages: [] });
      if (u.includes("/inbound")) return json({ generation, watermark: 900, next_since_seq: nextSince, has_more: false, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const roomId = client.cfg.roomId.value;
  assert.equal(client.roomRuntime(roomId).streamGeneration, "g0");

  // The reset lands and is adopted.
  generation = "g1";
  nextSince = 3;
  const reset = await client.readInbox();
  assert.equal(reset.streamReset, true);
  assert.equal(client.roomRuntime(roomId).cursor, 3);
  assert.equal(client.roomRuntime(roomId).streamGeneration, "g1");

  // The delayed g0 response finally arrives.
  generation = "g0";
  nextSince = 700;
  const delayed = await client.readInbox();
  assert.equal(delayed.staleGeneration, true);
  assert.equal(delayed.streamReset, undefined, "a retired generation is not another reset");
  assert.equal(delayed.cursorAfter, 3, "the retired response moves nothing");
  assert.equal(delayed.nextCursor, 3);
  assert.equal(delayed.hasMore, false);
  assert.match(delayed.note, /minted before a stream reset/);
  assert.equal(client.roomRuntime(roomId).cursor, 3);
  assert.equal(client.roomRuntime(roomId).streamGeneration, "g1", "the stored generation never reverts");
  assert.equal(client.roomRuntime(roomId).staleGenerationReads, 1);

  // A genuinely new generation still resets: the fence only knows what this
  // room has HELD, so it can never mistake a forward move for a stale one.
  generation = "g2";
  nextSince = 5;
  const forward = await client.readInbox();
  assert.equal(forward.staleGeneration, undefined);
  assert.equal(forward.streamReset, true);
  assert.equal(client.roomRuntime(roomId).cursor, 5);
  assert.equal(client.roomRuntime(roomId).streamGeneration, "g2");

  // ...and g1, now retired too, is fenced on arrival.
  generation = "g1";
  nextSince = 3;
  const alsoStale = await client.readInbox();
  assert.equal(alsoStale.staleGeneration, true);
  assert.equal(client.roomRuntime(roomId).cursor, 5);
  assert.equal(client.roomRuntime(roomId).staleGenerationReads, 2);
});

test("a drain refuses a retired generation's page instead of mixing in a dead stream", async () => {
  let generation = "g0";
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1", generation: "g0", baseline_seq: 7 }, 201);
      if (u.includes("/projection")) return json({ generation: "g0", watermark: 7, next_since_seq: 7, has_more: false, messages: [] });
      if (u.includes("/inbound")) return json({ generation, watermark: 900, next_since_seq: generation === "g0" ? 700 : 3, has_more: false, messages: [{ seq: generation === "g0" ? 600 : 2 }] });
      return json({});
    },
  });
  await client.connect();
  const roomId = client.cfg.roomId.value;
  generation = "g1";
  await client.readInbox();
  assert.equal(client.roomRuntime(roomId).cursor, 3);
  client.roomRuntime(roomId).unreadCount = 4;

  generation = "g0";
  const drained = await client.drainInbox();
  assert.equal(drained.staleGeneration, true);
  assert.equal(drained.complete, false, "a fenced drain is never a complete delta");
  assert.deepEqual(drained.messages, [], "the retired stream's rows are not mixed into the result");
  assert.equal(drained.cursorAfter, 3);
  assert.match(drained.note, /already retired/);
  assert.equal(client.roomRuntime(roomId).unreadCount, 4, "a drain that learned nothing does not rewrite unread");
});

test("a page the local cap cut is never reported as the end of the delta", async () => {
  // The server called its page complete, but the local response cap dropped a
  // row from it, so the cursor stopped short and more genuinely remains.
  const { client, result } = await runCursorRead({
    messages: [{ seq: 8 }, { seq: 9 }, { seq: 10 }],
    nextSinceSeq: 10,
    hasMore: false,
    params: { limitMessages: 2 },
  });
  assert.equal(result.has_more, false, "the server's own field is reported unchanged");
  assert.equal(result.hasMore, true, "but the caller is told rows remain");
  assert.equal(result.droppedRows, true);
  assert.equal(result.cursorAfter, 9);
  assert.match(result.note, /dropped by the local response cap/);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 9);
});

test("unread is never published as zero while rows remain past the page", async () => {
  const withMore = await runCursorRead({ messages: [{ seq: 8 }], nextSinceSeq: 8, hasMore: true });
  assert.equal(withMore.result.cursorAfter, 8);
  assert.equal(
    withMore.client.roomRuntime(withMore.client.cfg.roomId.value).unreadCount,
    1,
    "a page-local count of zero would claim the room was caught up mid-backlog",
  );

  const caughtUp = await runCursorRead({ messages: [{ seq: 8 }], nextSinceSeq: 8, hasMore: false });
  assert.equal(caughtUp.client.roomRuntime(caughtUp.client.cfg.roomId.value).unreadCount, 0);
});

function pagedInboxClient(page) {
  const urls = [];
  let index = 0;
  const happy = happyFetch({});
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/inbound?")) {
        urls.push(u);
        const body = page(index);
        index += 1;
        return json(body);
      }
      return happy(url, init);
    },
  });
  return { client, urls };
}

test("an explicit drain follows has_more across pages and commits page progress", async () => {
  const pages = [
    { generation: "g0", watermark: 500, messages: [{ seq: 8 }], next_since_seq: 20, has_more: true },
    { generation: "g0", watermark: 500, messages: [{ seq: 25 }], next_since_seq: 30, has_more: true },
    { generation: "g0", watermark: 500, messages: [{ seq: 31 }], next_since_seq: 31, has_more: false },
  ];
  const { client, urls } = pagedInboxClient((i) => pages[Math.min(i, pages.length - 1)]);
  await client.connect();
  const result = await client.drainInbox();
  assert.equal(result.pagesRead, 3);
  assert.equal(result.complete, true);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.messages.map((row) => row.seq), [8, 25, 31]);
  assert.equal(result.cursorBefore, 7);
  assert.equal(result.cursorAfter, 31);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 31);
  // Each continuation is the previous page's own progress, never the
  // participant-wide watermark of 500.
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get("since_seq")), ["7", "20", "30"]);
});

test("a drain stops at a stream generation boundary instead of paging across it", async () => {
  const pages = [
    { generation: "g0", watermark: 500, messages: [{ seq: 8 }], next_since_seq: 20, has_more: true },
    { generation: "g1", watermark: 3, messages: [{ seq: 2 }], next_since_seq: 2, has_more: true },
  ];
  const { client } = pagedInboxClient((i) => pages[Math.min(i, pages.length - 1)]);
  await client.connect();
  const result = await client.drainInbox();
  assert.equal(result.pagesRead, 2);
  assert.equal(result.streamReset, true);
  assert.equal(result.complete, false, "a boundary is never reported as a complete delta");
  assert.equal(result.cursorAfter, 2, "the cursor lands on the new stream, not the retired one");
  assert.match(result.note, /stream generation changed mid-drain/);
});

function pagedProjectionClient(page) {
  const urls = [];
  let index = 0;
  const happy = happyFetch({});
  let bootstrapped = false;
  const client = new ParleAgentClient({
    env: ENV,
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes("/projection")) {
        // The first projection request is the bootstrap page; the test's own
        // pages start after it.
        if (!bootstrapped) { bootstrapped = true; return happy(url, init); }
        urls.push(u);
        const body = page(index);
        index += 1;
        return json(body);
      }
      return happy(url, init);
    },
  });
  return { client, urls };
}

test("a projection read never raises the inbound unread floor", async () => {
  // Projection carries own-authored rows and room history. A continuation of
  // purely self-authored rows must not raise an attention count that no inbox
  // read could ever clear.
  const { client } = pagedProjectionClient(() => ({
    generation: "g0",
    watermark: 900,
    messages: [{ seq: 8, event_id: "mine" }],
    next_since_seq: 8,
    has_more: true,
  }));
  await client.connect();
  const result = await client.readProjection();
  assert.equal(result.hasMore, true);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 0, "a projection page says nothing about inbound attention");

  // The same page shape on the inbox surface DOES raise the floor.
  const inbox = await runCursorRead({ messages: [{ seq: 8 }], nextSinceSeq: 8, hasMore: true });
  assert.equal(inbox.client.roomRuntime(inbox.client.cfg.roomId.value).unreadCount, 1);
});

test("an incomplete inbox drain never leaves unread standing at zero", async () => {
  const { client } = pagedInboxClient((i) => ({
    generation: "g0",
    watermark: 900,
    messages: [{ seq: 10 + i * 3 }, { seq: 11 + i * 3 }, { seq: 12 + i * 3 }],
    next_since_seq: 12 + i * 3,
    has_more: true,
  }));
  await client.connect();
  const room = client.roomRuntime(client.cfg.roomId.value);
  room.unreadCount = 0;
  const result = await client.drainInbox({ limitMessages: 5 });
  assert.equal(result.complete, false);
  assert.equal(
    client.roomRuntime(client.cfg.roomId.value).unreadCount,
    1,
    "a zero would claim the inbox was drained when the cursor sits mid-backlog",
  );
});

test("a complete drain clears an unread count an earlier read left standing", async () => {
  const inbox = pagedInboxClient(() => ({ generation: "g0", watermark: 900, messages: [{ seq: 8 }], next_since_seq: 8, has_more: false }));
  await inbox.client.connect();
  inbox.client.roomRuntime(inbox.client.cfg.roomId.value).unreadCount = 5;
  const drained = await inbox.client.drainInbox();
  assert.equal(drained.complete, true);
  assert.equal(inbox.client.roomRuntime(inbox.client.cfg.roomId.value).unreadCount, 0);

  // A projection drain advances past everything before the cursor, so it
  // clears the stale count too.
  const projection = pagedProjectionClient(() => ({ generation: "g0", watermark: 900, messages: [{ seq: 8 }], next_since_seq: 8, has_more: false }));
  await projection.client.connect();
  projection.client.roomRuntime(projection.client.cfg.roomId.value).unreadCount = 5;
  const swept = await projection.client.drainProjection();
  assert.equal(swept.complete, true);
  assert.equal(projection.client.roomRuntime(projection.client.cfg.roomId.value).unreadCount, 0);
});

test("an audit drain never touches unread state", async () => {
  const { client } = pagedInboxClient(() => ({ generation: "g0", watermark: 900, messages: [{ seq: 8 }], next_since_seq: 8, has_more: true }));
  await client.connect();
  client.roomRuntime(client.cfg.roomId.value).unreadCount = 5;
  await client.drainInbox({ sinceSeq: 2, maxPages: 1, limitMessages: 1 });
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 5, "an explicit sinceSeq drain commits nothing, including unread");
});

test("a drain that exhausts its page cap errors and consumes nothing", async () => {
  // Progress-only pages: blocked or differently addressed rows advance the scan
  // without ever filling the response cap, so only the page cap can stop this.
  const { client, urls } = pagedInboxClient((i) => ({ generation: "g0", watermark: 900, messages: [], next_since_seq: 10 + i, has_more: true }));
  await client.connect();
  await assert.rejects(() => client.drainInbox({ maxPages: 3 }), (error) => {
    assert.equal(error.code, "drain_page_cap_exhausted");
    assert.match(error.message, /rows still unread/);
    assert.deepEqual(error.details, { surface: "inbound", roomId: "room-1", pagesRead: 3, maxPages: 3, cursor: 7 });
    return true;
  });
  assert.equal(urls.length, 3, "the page cap is hard");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7, "a refused drain never moves the cursor");
});

test("a drain stops at the local response cap and reports the incompleteness", async () => {
  const { client, urls } = pagedInboxClient((i) => ({
    generation: "g0",
    watermark: 900,
    messages: [{ seq: 10 + i * 3 }, { seq: 11 + i * 3 }, { seq: 12 + i * 3 }],
    next_since_seq: 12 + i * 3,
    has_more: true,
  }));
  await client.connect();
  const result = await client.drainInbox({ limitMessages: 5, maxPages: 8 });
  assert.equal(result.complete, false, "an unfinished drain is never reported as a complete delta");
  assert.equal(result.hasMore, true);
  assert.equal(result.pagesRead, 2, "the response cap stops the loop well inside the page cap");
  // The cap is AGGREGATE and exact: page one spends 3 of 5, page two is read
  // with a budget of 2 and its third row is dropped rather than overshooting.
  assert.equal(result.messages.length, 5);
  assert.deepEqual(result.messages.map((row) => row.seq), [10, 11, 12, 13, 14]);
  assert.match(result.note, /stopped at its local response cap/);
  assert.equal(result.cursorAfter, 14, "the cursor stops at the last row actually surfaced");
  assert.equal(urls.length, 2);
});

test("a drain stops exactly at its aggregate byte cap", async () => {
  // Two rows fit the budget; the third would carry it past, and paging must not
  // stack an oversized row onto a budget the earlier pages already spent.
  const body = "x".repeat(4096);
  const { client } = pagedInboxClient((i) => ({
    generation: "g0",
    watermark: 900,
    messages: [{ seq: 10 + i, content: body }],
    next_since_seq: 10 + i,
    has_more: true,
  }));
  await client.connect();
  const result = await client.drainInbox({ limitBytes: 6000, maxPages: 8 });
  assert.equal(result.complete, false);
  assert.equal(result.hasMore, true);
  assert.equal(result.messages.length, 1, "the overshooting page is left unconsumed for the next drain");
  assert.equal(result.returnedBytes <= 6000, true, `aggregate bytes ${result.returnedBytes} stay inside the cap`);
  assert.equal(result.maxBytes, 6000);
  assert.equal(result.cursorAfter, 10, "the cursor stops before the page that was not consumed");
});

test("a byte budget below the truncation floor is clamped, and an oversized row is accounted", () => {
  assert.equal(clampReadLimitBytes(undefined), READ_LIMIT_BYTES);
  assert.equal(clampReadLimitBytes(0), READ_LIMIT_BYTES);
  assert.equal(clampReadLimitBytes(-5), READ_LIMIT_BYTES);
  assert.equal(clampReadLimitBytes(10), MIN_READ_LIMIT_BYTES, "a tiny budget cannot express fewer bytes than the truncation floor");
  assert.equal(clampReadLimitBytes(READ_LIMIT_BYTES * 4), READ_LIMIT_BYTES);
  assert.equal(clampReadLimitBytes(4096), 4096);

  // A first row larger than the whole budget is still surfaced — returning
  // nothing would be worse — but its bytes are ACCOUNTED, so returnedBytes
  // never understates what the caller received.
  const capped = capProjectionMessages([{ seq: 9, content: "x".repeat(300_000) }], 50, 4096);
  assert.equal(capped.messages.length, 1);
  assert.equal(capped.truncated, true);
  assert.equal(capped.returnedBytes > 0, true, "the oversized row is not accounted as zero bytes");
  assert.equal(capped.returnedBytes, Buffer.byteLength(JSON.stringify(capped.messages[0]), "utf8"));
});

test("a drain given a tiny byte budget still makes progress under the clamped floor", async () => {
  const { client } = pagedInboxClient((i) => ({
    generation: "g0",
    watermark: 900,
    messages: [{ seq: 10 + i, content: "small" }],
    next_since_seq: 10 + i,
    has_more: i < 2,
  }));
  await client.connect();
  const result = await client.drainInbox({ limitBytes: 10, maxPages: 8 });
  assert.equal(result.maxBytes, MIN_READ_LIMIT_BYTES, "the caller's tiny budget is clamped, not honored literally");
  assert.equal(result.messages.length > 0, true, "a clamped budget still returns rows");
  assert.equal(result.returnedBytes <= MIN_READ_LIMIT_BYTES, true);
});

test("observeUnread counts and refreshes held diagnostics without advancing the cursor", async () => {
  const counters = {};
  const client = new ParleAgentClient({ env: ENV, fetch: unreadFetch(counters, () => [{ seq: 8 }, { seq: 9 }], 0) });
  await client.connect();
  client.roomRuntime(client.cfg.roomId.value).heldBacklogCount = 1;
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7);
  await client.observeUnread();
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 2);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).heldBacklogCount, 0);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7);
  assert.match(counters.lastInboundUrl, /since_seq=7&wait=0/);
  await client.observeUnread();
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 2);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 7);
  assert.equal(counters.inbound, 2);
  assert.match(counters.lastInboundUrl, /since_seq=7&wait=0/);
});

test("read guidance is bounded and treats held backlog conservatively", async () => {
  const held = await runCursorRead({ messages: [], watermark: 20, heldCount: 1, params: { sinceSeq: 7 } });
  assert.match(held.result.note, /No inbox rows were disclosed in this page\. This is one bounded page, not the whole delta\./);
  assert.match(held.result.note, /held_count does not bound how many later rows remain undisclosed/);
  assert.match(held.result.note, /Do not conclude that no inbound or responsive messages exist/);
  assert.match(held.result.note, /does not prove any held row is inbound or responsive-eligible/);
  assert.doesNotMatch(held.result.note, /watermark 20/);

  const partial = await runCursorRead({ messages: [{ seq: 8 }], watermark: 20, heldCount: 1, params: { sinceSeq: 7 } });
  assert.match(partial.result.note, /Some inbox rows were disclosed in this page, but this result is non-exhaustive/);
  assert.match(partial.result.note, /held_count does not bound how many later rows remain undisclosed/);

  const clear = await runCursorRead({ messages: [], watermark: 20, heldCount: 0, params: { sinceSeq: 7 } });
  assert.match(clear.result.note, /No inbox rows were disclosed in this page\. This is one bounded page, not the whole delta\./);
  assert.doesNotMatch(clear.result.note, /held backlog remains in flight/);

  // has_more is the exact incompleteness statement, and it is stated even when
  // rows came back and nothing is held.
  const more = await runCursorRead({ messages: [{ seq: 8 }], nextSinceSeq: 8, hasMore: true, params: { sinceSeq: 7 } });
  assert.equal(more.result.hasMore, true);
  assert.match(more.result.note, /has_more is true: this page does not reach the end of the delta/);
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
  assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 9);
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 0);
  releaseInbound();
  await observation;
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 0, "stale positive count must not resurrect after a drain");
});

test("draining reads republish the remaining count and steady zero writes nothing", async () => {
  const cwd = tempCwd();
  try {
    const counters = {};
    const client = new ParleAgentClient({ cwd, env: ENV, fetch: unreadFetch(counters, () => [{ seq: 8 }]), publishRuntime: { adapterName: "test" } });
    await client.connect();
    await client.observeUnread();
    assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 1);
    let snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.rooms[0].unreadCount, 1);
    assert.ok(snapshot.rooms[0].unreadAsOf);
    // Drain: readInbox advances the cursor past seq 8 and republishes zero.
    await client.readInbox();
    assert.equal(client.roomRuntime(client.cfg.roomId.value).cursor, 8);
    snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.rooms[0].unreadCount, 0);
    const asOfAfterDrain = snapshot.rooms[0].unreadAsOf;
    // Steady zero: the stub still returns seq 8, now behind the cursor, so the
    // next observation counts zero and must not rewrite the runtime file.
    await client.observeUnread();
    snapshot = JSON.parse(readFileSync(runtimeFilePath(cwd, process.pid), "utf8"));
    assert.equal(snapshot.rooms[0].unreadCount, 0);
    assert.equal(snapshot.rooms[0].unreadAsOf, asOfAfterDrain, "steady zero must not rewrite the runtime file");
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
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 1);
  failInbound = true;
  await client.observeUnread();
  assert.equal(client.runtime.bootstrapState, "ready");
  assert.equal(client.roomRuntime(client.cfg.roomId.value).unreadCount, 1, "failed observation leaves the prior count to age out");
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
