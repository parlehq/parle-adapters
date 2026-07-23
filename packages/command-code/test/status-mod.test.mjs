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
    schemaVersion: 1,
    state: "ready",
    pid: process.pid,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    roomHandle: "workshop",
    sessionAddress: "@gilman.galexc.abcdefgh",
    ...overrides,
  };
}

function writeSnapshot(cwd, name, value) {
  writeFileSync(join(cwd, ".parle", "runtime", `${name}.json`), JSON.stringify(value));
}

test("renders one live room-first Parle session with fresh unread state", () => {
  const cwd = workspace("single");
  try {
    writeSnapshot(cwd, "one", snapshot({ unreadCount: 2, unreadAsOf: new Date().toISOString() }));
    assert.equal(renderParleStatus(cwd), "#workshop ✓ @gilman.galexc.abcdefgh · 2 unread");
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

test("registers a footer segment and clears it on session shutdown", () => {
  const cwd = workspace("lifecycle");
  const handlers = new Map();
  const statuses = [];
  try {
    writeSnapshot(cwd, "one", snapshot());
    loadMod({
      cwd,
      ui: { setStatus(value) { statuses.push(value); } },
      on(event, handler) { handlers.set(event, handler); return { dispose() {} }; },
    });
    assert.equal(statuses.at(-1), "#workshop ✓ @gilman.galexc.abcdefgh");
    handlers.get("session_shutdown")();
    assert.equal(statuses.at(-1), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
