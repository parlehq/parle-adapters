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
    schemaVersion: 1,
    pid,
    // Own-process start time via uptime math; omit processStartedAt in
    // overrides for pids whose start time the test cannot know portably.
    processStartedAt: pid === process.pid ? ownStartIso() : undefined,
    state: "ready",
    sessionAddress: "@gilman.galexc.abc123",
    agentSessionId: "as-1",
    roomId: "room-1",
    roomHandle: "test-room",
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
  if (credentials) writeFileSync(join(cwd, ".parle", "credentials"), "PARLE_ROOM_ID=room-1\n");
  return cwd;
}

test("one live session prints its address", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid) });
  try {
    assert.equal(run(cwd), "parle ✓ @gilman.galexc.abc123");
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
    assert.equal(run(cwd), "parle ✓ 2 sessions");
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

test("full mode adds room and relative expiry for a single live session", () => {
  const cwd = scaffold({ [`${process.pid}.json`]: liveSnapshot(process.pid) });
  try {
    assert.equal(run(cwd, ["--full"]), "parle ✓ @gilman.galexc.abc123 · test-room · expires in 60m");
    assert.doesNotMatch(run(cwd), /test-room/);
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
    assert.match(out, /^parle ✓ 2 sessions in cwd: /);
    assert.match(out, /@gilman\.galexc\.abc123/);
    assert.match(out, /@gilman\.galexc\.other/);
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
