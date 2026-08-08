import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("../statusline/parle-statusline.mjs", import.meta.url).pathname;

function run(cwd, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: JSON.stringify({ workspace: { current_dir: cwd } }),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Start-time verification in the script is advisory (skipped where ps is
// blocked), so fixtures only need accurate start times for the mismatch test.
function psAvailable() {
  try {
    execFileSync("ps", ["-o", "etime=", "-p", String(process.pid)], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

function ownStartIso() {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

function liveSnapshot(pid, overrides = {}) {
  return {
    schemaVersion: 2,
    pid,
    // Own-process start time via uptime math; omit processStartedAt in
    // overrides for pids whose start time the test cannot know portably.
    processStartedAt: pid === process.pid ? ownStartIso() : undefined,
    state: "ready",
    sessionAddress: "@gilman.galexc.abc123",
    agentSessionId: "as-1",
    rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready" }],
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    adapter: { name: "@parlehq/mcp-server" },
    ...overrides,
  };
}

function scaffold(files, { credentials = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "parle-statusline-"));
  const dir = join(cwd, ".parle", "runtime");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  if (credentials) writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=galexc\n");
  return cwd;
}

test("one live session prints its address", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid) });
  try {
    assert.equal(run(cwd), "#test-room ✓ @gilman.galexc.abc123");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("one live session renders canonical responsive-delivery evidence", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid) });
  try {
    const dir = join(cwd, ".parle", "runtime", "responsive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStartedAt: ownStartIso(),
      publisher: { name: "status-test", clientInstanceId: "status-test-1" },
      target: { agentSessionId: "as-1" },
      state: "watching",
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(run(cwd), "#test-room ✓ @gilman.galexc.abc123 · delivery watching");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("multiple live sessions never display a specific address", () => {
  const cwd = scaffold({
    [`${process.pid}.json`]: liveSnapshot(process.pid),
    [`${process.ppid}.json`]: liveSnapshot(process.ppid, { sessionAddress: "@gilman.galexc.other" }),
  });
  try {
    assert.equal(run(cwd), "#test-room ✓ 2 sessions");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("expired, dead-pid, non-ready, and malformed snapshots read as not live", () => {
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const cwd = scaffold(
    {
      "expired.json": liveSnapshot(process.pid, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      "dead.json": liveSnapshot(gone, { processStartedAt: undefined }),
      "starting.json": liveSnapshot(process.pid, { state: "starting" }),
      "failed.json": liveSnapshot(process.pid, { state: "failed" }),
      "garbage.json": "not json at all",
      ".tmp-partial": "{",
    },
    { credentials: true },
  );
  try {
    assert.equal(run(cwd), "parle · off");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a live pid with a mismatched start time reads as reused, not live", { skip: !psAvailable() && "ps unavailable in this environment" }, () => {
  const cwd = scaffold(
    { "reused.json": liveSnapshot(process.pid, { processStartedAt: new Date(Date.now() - 86_400_000).toISOString() }) },
    { credentials: true },
  );
  try {
    assert.equal(run(cwd), "parle · off");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("single-session compact and full modes lead with the connected room", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid) });
  try {
    assert.equal(run(cwd, ["--full"]), "#test-room ✓ @gilman.galexc.abc123 · expires in 60m");
    assert.match(run(cwd), /^#test-room ✓ /);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("full mode lists all addresses for multiple live sessions, labeled as cwd sessions", () => {
  const cwd = scaffold({
    [`${process.pid}.json`]: liveSnapshot(process.pid),
    [`${process.ppid}.json`]: liveSnapshot(process.ppid, { sessionAddress: "@gilman.galexc.other" }),
  });
  try {
    const out = run(cwd, ["--full"]);
    assert.match(out, /^#test-room ✓ 2 sessions in cwd: /);
    assert.match(out, /@gilman\.galexc\.abc123/);
    assert.match(out, /@gilman\.galexc\.other/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fresh unread counts display; stale counts are suppressed in compact and labeled in full", () => {
  const fresh = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid, { rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready", unreadCount: 2, unreadAsOf: new Date().toISOString() }] }) });
  const stale = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid, { rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready", unreadCount: 2, unreadAsOf: new Date(Date.now() - 420_000).toISOString() }] }) });
  const zero = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid, { rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready", unreadCount: 0, unreadAsOf: new Date().toISOString() }] }) });
  try {
    assert.equal(run(fresh), "#test-room ✓ @gilman.galexc.abc123 · 2 unread");
    assert.match(run(fresh, ["--full"]), / · 2 unread$/);
    assert.equal(run(stale), "#test-room ✓ @gilman.galexc.abc123");
    assert.match(run(stale, ["--full"]), / · unread stale 7m$/);
    assert.equal(run(zero), "#test-room ✓ @gilman.galexc.abc123");
  } finally {
    for (const cwd of [fresh, stale, zero]) rmSync(cwd, { recursive: true, force: true });
  }
});

test("multi-session unread is an indicator, never a summed number", () => {
  const cwd = scaffold({
    [`${process.pid}.json`]: liveSnapshot(process.pid, { rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready", unreadCount: 2, unreadAsOf: new Date().toISOString() }] }),
    [`${process.ppid}.json`]: liveSnapshot(process.ppid, { sessionAddress: "@gilman.galexc.other", rooms: [{ roomId: "room-1", roomHandle: "test-room", state: "ready", unreadCount: 1, unreadAsOf: new Date().toISOString() }] }),
  });
  try {
    assert.equal(run(cwd), "#test-room ✓ 2 sessions · unread");
    const full = run(cwd, ["--full"]);
    assert.match(full, /@gilman\.galexc\.abc123 \(2 unread\)/);
    assert.match(full, /@gilman\.galexc\.other \(1 unread\)/);
    assert.doesNotMatch(full, /3 unread/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("connected handleless room uses an honest short-id label", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid, { rooms: [{ roomId: "019f7b46-178f-7a5a-9f7b-b4af2e045261", state: "ready" }] }) });
  try {
    assert.equal(run(cwd), "#room-019f7b46 ✓ @gilman.galexc.abc123");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("multiple rooms retain a neutral aggregate label while full mode names each room", () => {
  const cwd = scaffold({
    [`${process.pid}.json`]: liveSnapshot(process.pid),
    [`${process.ppid}.json`]: liveSnapshot(process.ppid, { sessionAddress: "@gilman.galexc.other", rooms: [{ roomId: "room-2", roomHandle: "other-room", state: "ready" }] }),
  });
  try {
    assert.equal(run(cwd), "parle ✓ 2 sessions");
    const full = run(cwd, ["--full"]);
    assert.match(full, /^parle ✓ 2 sessions in cwd: /);
    assert.match(full, /#test-room @gilman\.galexc\.abc123/);
    assert.match(full, /#other-room @gilman\.galexc\.other/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unconfigured cwd prints nothing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-statusline-empty-"));
  try {
    assert.equal(run(cwd), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a multi-room snapshot labels every room and a retired schema reads as not live", () => {
  const v2 = scaffold({
    [`${process.pid}.json`]: liveSnapshot(process.pid, {
      schemaVersion: 2,
      rooms: [
        { roomId: "room-1", roomHandle: "test-room", profile: "alpha", state: "ready" },
        { roomId: "room-2", roomHandle: "other-room", profile: "beta", state: "ready" },
      ],
    }),
  });
  try {
    assert.equal(run(v2), "#test-room #other-room ✓ @gilman.galexc.abc123");
  } finally {
    rmSync(v2, { recursive: true, force: true });
  }
  for (const retired of [1, 3]) {
    const other = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid, { schemaVersion: retired }) });
    try {
      assert.equal(run(other), "", `schema ${retired} must not read as live`);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }
});
