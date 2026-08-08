import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: loadMod, renderParleStatus } = await jiti.import(pathToFileURL(join(process.cwd(), "skills/parle/mods/parle-status.ts")).href);

function workspace(name) {
  const cwd = join("/tmp", `parle-command-code-status-${process.pid}-${name}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(cwd, ".parle", "runtime"), { recursive: true });
  return cwd;
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    state: "ready",
    pid: process.pid,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    rooms: [{ roomId: "room-1", roomHandle: "workshop", state: "ready" }],
    sessionAddress: "@gilman.galexc.abcdefgh",
    agentSessionId: "as-1",
    ...overrides,
  };
}

function writeSnapshot(cwd, name, value) {
  writeFileSync(join(cwd, ".parle", "runtime", `${name}.json`), JSON.stringify(value));
}

test("renders one live room-first Parle session with fresh unread state", () => {
  const cwd = workspace("single");
  try {
    writeSnapshot(cwd, "one", snapshot({ rooms: [{ roomId: "room-1", roomHandle: "workshop", state: "ready", unreadCount: 2, unreadAsOf: new Date().toISOString() }] }));
    assert.equal(renderParleStatus(cwd), "#workshop ✓ @gilman.galexc.abcdefgh · 2 unread");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renders canonical responsive-delivery evidence", () => {
  const cwd = workspace("delivery");
  try {
    writeSnapshot(cwd, "one", snapshot());
    const dir = join(cwd, ".parle", "runtime", "responsive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      publisher: { name: "status-test", clientInstanceId: "status-test-1" },
      target: { agentSessionId: "as-1" },
      state: "watching",
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(renderParleStatus(cwd), "#workshop ✓ @gilman.galexc.abcdefgh · delivery watching");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renders honest multi-session state and ignores dead snapshots", () => {
  const cwd = workspace("multiple");
  try {
    writeSnapshot(cwd, "one", snapshot());
    writeSnapshot(cwd, "two", snapshot({ sessionAddress: "@gilman.galexc.ijklmnop" }));
    writeSnapshot(cwd, "dead", snapshot({ pid: 99999999 }));
    assert.equal(renderParleStatus(cwd), "#workshop ✓ 2 sessions");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("treats sandbox EPERM pid checks as live and relies on snapshot expiry", () => {
  const cwd = workspace("sandboxed");
  const originalKill = process.kill;
  try {
    writeSnapshot(cwd, "one", snapshot());
    process.kill = () => {
      const error = new Error("operation not permitted");
      error.code = "EPERM";
      throw error;
    };
    assert.equal(renderParleStatus(cwd), "#workshop ✓ @gilman.galexc.abcdefgh");
  } finally {
    process.kill = originalKill;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("renders disconnected only for a configured workspace", () => {
  const cwd = workspace("configured");
  try {
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=default\n");
    assert.equal(renderParleStatus(cwd), "parle · off");
    rmSync(join(cwd, ".env"));
    assert.equal(renderParleStatus(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registers future footer state, emits one delayed startup notice, and clears on shutdown", async () => {
  const cwd = workspace("lifecycle");
  const handlers = new Map();
  let lifecycle;
  const statuses = [];
  const notices = [];
  try {
    writeSnapshot(cwd, "one", snapshot());
    loadMod({
      cwd,
      ui: {
        setStatus(value) { statuses.push(value); },
        notify(value) { notices.push(value); },
      },
      hooks(value) { lifecycle = value; return { dispose() {} }; },
      on(event, handler) { handlers.set(event, handler); return { dispose() {} }; },
    });
    assert.equal(statuses.at(-1), "#workshop ✓ @gilman.galexc.abcdefgh");
    assert.deepEqual(notices, []);
    lifecycle.onSessionStart({ source: "startup" });
    assert.deepEqual(notices, []);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    assert.equal(notices.at(-1), "Parle #workshop ✓ @gilman.galexc.abcdefgh");
    lifecycle.onSessionEnd({ reason: "shutdown" });
    assert.equal(statuses.at(-1), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("reads schema v2 snapshots and ignores retired or unknown schemas", () => {
  const cwd = workspace("schema-v2");
  try {
    writeSnapshot(cwd, "v2", snapshot({}));
    assert.equal(renderParleStatus(cwd), "#workshop ✓ @gilman.galexc.abcdefgh");
    rmSync(join(cwd, ".parle", "runtime", "v2.json"), { force: true });
    for (const retired of [1, 3]) {
      writeSnapshot(cwd, "other", snapshot({ schemaVersion: retired }));
      assert.equal(renderParleStatus(cwd), null, `schema ${retired} must not read as live`);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
