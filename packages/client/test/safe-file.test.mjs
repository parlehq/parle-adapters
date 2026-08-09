import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SafeFileError,
  atomicReplaceOwnerOnlyFile,
  ensureOwnerOnlyDirectory,
  readOwnerOnlyFile,
  readOwnerOnlyTextFile,
  removeOwnerOnlyFileIf,
  withOwnerOnlyFileLock,
} from "../dist/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parle-safe-file-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  return { root, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function expectCode(code) {
  return (error) => error instanceof SafeFileError && error.code === code;
}

test("owner-only directories are created with strict custody and reject symlinks", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const nested = join(f.state, "nested");
    ensureOwnerOnlyDirectory(nested, { label: "test directory" });
    assert.equal(statSync(nested).mode & 0o777, 0o700);

    const outside = join(f.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    const linked = join(f.state, "linked");
    symlinkSync(outside, linked);
    assert.throws(() => ensureOwnerOnlyDirectory(linked, { label: "linked directory" }), expectCode("symlink_refused"));

    chmodSync(nested, 0o755);
    assert.throws(() => ensureOwnerOnlyDirectory(nested, { label: "wide directory" }), expectCode("unsafe_mode"));
  } finally { f.cleanup(); }
});

test("bounded reads verify owner mode, symlink refusal, and link count", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const path = join(f.state, "value");
    writeFileSync(path, "bounded", { mode: 0o600 });
    assert.equal(readOwnerOnlyTextFile(path, { label: "test value", maxBytes: 7 }), "bounded");
    assert.throws(() => readOwnerOnlyFile(path, { label: "test value", maxBytes: 6 }), expectCode("size_limit"));

    chmodSync(path, 0o640);
    assert.throws(() => readOwnerOnlyFile(path, { label: "test value", maxBytes: 32 }), expectCode("unsafe_mode"));
    chmodSync(path, 0o600);

    const alias = join(f.state, "alias");
    symlinkSync(path, alias);
    assert.throws(() => readOwnerOnlyFile(alias, { label: "test alias", maxBytes: 32 }), expectCode("symlink_refused"));

    const hardlink = join(f.state, "hardlink");
    linkSync(path, hardlink);
    assert.throws(() => readOwnerOnlyFile(path, { label: "linked value", maxBytes: 32 }), expectCode("unsafe_links"));
  } finally { f.cleanup(); }
});

test("atomic replacement publishes complete owner-only files and leaves no temporary artifacts", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const path = join(f.state, "value.json");
    atomicReplaceOwnerOnlyFile(path, "first\n", { label: "test state", maxBytes: 32, durability: "required" });
    assert.equal(readFileSync(path, "utf8"), "first\n");
    assert.equal(statSync(path).mode & 0o777, 0o600);

    atomicReplaceOwnerOnlyFile(path, "second\n", { label: "test state", maxBytes: 32, durability: "required" });
    assert.equal(readFileSync(path, "utf8"), "second\n");
    assert.deepEqual(readdirSync(f.state), ["value.json"]);
    assert.throws(() => atomicReplaceOwnerOnlyFile(path, "x".repeat(33), { label: "test state", maxBytes: 32, durability: "required" }), expectCode("size_limit"));

    rmSync(path);
    const outside = join(f.root, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, path);
    assert.throws(() => atomicReplaceOwnerOnlyFile(path, "replacement", { label: "test state", durability: "required" }), expectCode("symlink_refused"));
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally { f.cleanup(); }
});

test("conditional removal does not quarantine a non-candidate", () => {
  const f = fixture();
  const originalRename = fs.renameSync;
  try {
    const path = join(f.state, "healthy.json");
    writeFileSync(path, '{"healthy":true}\n', { mode: 0o600 });
    fs.renameSync = () => { throw new Error("non-candidate must not be renamed"); };
    syncBuiltinESMExports();
    assert.equal(removeOwnerOnlyFileIf(path, { label: "healthy snapshot", maxBytes: 1024, shouldRemove: () => false }), false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { healthy: true });
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("conditional removal quarantines one generation and preserves a concurrent replacement", () => {
  const f = fixture();
  try {
    const path = join(f.state, "snapshot.json");
    writeFileSync(path, '{"generation":1}\n', { mode: 0o600 });
    let evaluations = 0;
    assert.equal(removeOwnerOnlyFileIf(path, {
      label: "test snapshot",
      maxBytes: 1024,
      shouldRemove: (raw) => {
        evaluations += 1;
        assert.match(raw, /generation.*1/);
        if (evaluations === 2) {
          const replacement = join(f.state, "snapshot.replacement");
          writeFileSync(replacement, '{"generation":2}\n', { mode: 0o600 });
          renameSync(replacement, path);
        }
        return true;
      },
    }), true);
    assert.equal(evaluations, 2);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { generation: 2 });
    assert.equal(readdirSync(f.state).some((name) => name.includes(".prune.")), false);
  } finally { f.cleanup(); }
});

test("atomic replacement can explicitly replace a legacy loose mode without weakening strict reads", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const path = join(f.state, "legacy");
    writeFileSync(path, "old", { mode: 0o644 });
    assert.throws(() => atomicReplaceOwnerOnlyFile(path, "strict", { label: "legacy state", durability: "best-effort" }), expectCode("unsafe_mode"));
    atomicReplaceOwnerOnlyFile(path, "repaired", { label: "legacy state", durability: "best-effort", existingMode: "replace" });
    assert.equal(readFileSync(path, "utf8"), "repaired");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("durability policy handles unsupported file and directory sync explicitly", () => {
  const f = fixture();
  const originalFsync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { const error = new Error("unsupported sync"); error.code = "ENOTSUP"; throw error; };
    syncBuiltinESMExports();
    const best = join(f.state, "best");
    const required = join(f.state, "required");
    const transient = join(f.state, "transient");
    atomicReplaceOwnerOnlyFile(best, "best", { label: "best effort state", durability: "best-effort" });
    assert.throws(() => atomicReplaceOwnerOnlyFile(required, "required", { label: "required state", durability: "required" }), expectCode("file_sync_unsupported"));
    atomicReplaceOwnerOnlyFile(transient, "transient", { label: "transient state", durability: "none" });
    assert.equal(readFileSync(best, "utf8"), "best");
    assert.equal(existsSync(required), false);
    assert.equal(readFileSync(transient, "utf8"), "transient");
  } finally {
    fs.fsyncSync = originalFsync;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("lock contention fails closed without removing the active writer lock", () => {
  const f = fixture();
  try {
    const target = join(f.state, "catalog");
    withOwnerOnlyFileLock(target, { label: "catalog", durability: "required" }, () => {
      assert.throws(
        () => withOwnerOnlyFileLock(target, { label: "catalog", durability: "required" }, () => undefined),
        expectCode("lock_contended"),
      );
      assert.equal(existsSync(`${target}.lock`), true);
    });
    assert.equal(existsSync(`${target}.lock`), false);
  } finally { f.cleanup(); }
});

test("dead-owner locks and aged malformed locks recover, while fresh malformed locks remain contended", () => {
  const f = fixture();
  try {
    const target = join(f.state, "catalog");
    const lock = `${target}.lock`;
    writeFileSync(lock, `${JSON.stringify({ version: 1, token: "00000000-0000-4000-8000-000000000000", pid: 999999, createdAt: "2026-08-08T12:00:00.000Z" })}\n`, { mode: 0o600 });
    let ran = false;
    withOwnerOnlyFileLock(target, { label: "catalog", durability: "required", pidIsAlive: () => false }, () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(existsSync(lock), false);

    writeFileSync(lock, "malformed\n", { mode: 0o600 });
    assert.throws(
      () => withOwnerOnlyFileLock(target, { label: "catalog", durability: "required", malformedStaleAfterMs: 60_000 }, () => undefined),
      expectCode("lock_contended"),
    );
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    withOwnerOnlyFileLock(target, { label: "catalog", durability: "required", malformedStaleAfterMs: 60_000 }, () => undefined);
    assert.equal(existsSync(lock), false);
    assert.equal(readdirSync(f.state).some((name) => name.includes(".stale.")), false);
  } finally { f.cleanup(); }
});

test("stale recovery refuses to quarantine a replacement lock observed after liveness inspection", () => {
  const f = fixture();
  try {
    const target = join(f.state, "catalog");
    const lock = `${target}.lock`;
    const stale = { version: 1, token: "00000000-0000-4000-8000-000000000000", pid: 999998, createdAt: "2026-08-08T12:00:00.000Z" };
    const replacement = { version: 1, token: "22222222-2222-4222-8222-222222222222", pid: process.pid, createdAt: new Date().toISOString() };
    writeFileSync(lock, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
    let inspected = false;
    assert.throws(() => withOwnerOnlyFileLock(target, {
      label: "catalog",
      durability: "none",
      pidIsAlive: () => {
        if (inspected) return true;
        inspected = true;
        rmSync(lock);
        writeFileSync(lock, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        return false;
      },
    }, () => undefined), expectCode("lock_contended"));
    assert.deepEqual(JSON.parse(readFileSync(lock, "utf8")), replacement);
  } finally { f.cleanup(); }
});

test("lock release detects ownership replacement and preserves the foreign lock", () => {
  const f = fixture();
  try {
    const target = join(f.state, "catalog");
    const lock = `${target}.lock`;
    assert.throws(() => withOwnerOnlyFileLock(target, { label: "catalog", durability: "required" }, () => {
      rmSync(lock);
      writeFileSync(lock, `${JSON.stringify({ version: 1, token: "11111111-1111-4111-8111-111111111111", pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    }), expectCode("lock_ownership_lost"));
    assert.equal(existsSync(lock), true);
    assert.equal(lstatSync(lock).isSymbolicLink(), false);
  } finally { f.cleanup(); }
});

test("lock cleanup failure never masks the operation failure", () => {
  const f = fixture();
  try {
    const target = join(f.state, "catalog");
    const lock = `${target}.lock`;
    const expected = new Error("operation failed distinctly");
    assert.throws(() => withOwnerOnlyFileLock(target, { label: "catalog", durability: "none" }, () => {
      rmSync(lock);
      writeFileSync(lock, `${JSON.stringify({ version: 1, token: "33333333-3333-4333-8333-333333333333", pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      throw expected;
    }), (error) => error === expected && error.lockReleaseError instanceof SafeFileError);
  } finally { f.cleanup(); }
});
