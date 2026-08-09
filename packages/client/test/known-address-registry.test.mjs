import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_ADDRESS_CONTEXT_MARKER,
  KNOWN_ADDRESS_EPHEMERAL_TTL_MS,
  enrollKnownAddress,
  knownAddressRegistryPath,
  readKnownAddressRegistry,
  renderKnownAddressContext,
  shortenKnownAddressAfterUnprocessable,
  withOwnerOnlyFileLock,
} from "../dist/index.js";

const API = "https://api.parle.sh";
const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const NOW = new Date("2026-08-09T00:00:00.000Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parle-known-address-"));
  const state = join(root, ".parle");
  mkdirSync(state, { mode: 0o700 });
  const catalog = join(state, "profiles");
  return { root, state, catalog, path: knownAddressRegistryPath(catalog), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function entry(address, overrides = {}) {
  return {
    apiOrigin: API,
    roomId: ROOM,
    address,
    continuity: "ephemeral",
    expiresAt: "2026-08-09T12:00:00.000Z",
    ...overrides,
  };
}

function writeRegistry(f, entries, mode = 0o600) {
  writeFileSync(f.path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { mode });
}

test("enrollment records the submitted selector and applies continuity TTLs", () => {
  const f = fixture();
  try {
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: `${API}/v/`, roomId: ROOM, address: "@principal.agent.session", continuity: "ephemeral" }, NOW), true);
    let registry = readKnownAddressRegistry(f.catalog, NOW, { prune: false });
    assert.equal(registry.entries[0].apiOrigin, API);
    assert.equal(registry.entries[0].address, "@principal.agent.session");
    assert.equal(registry.entries[0].expiresAt, new Date(NOW.getTime() + KNOWN_ADDRESS_EPHEMERAL_TTL_MS).toISOString());

    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.alias", continuity: "durable" }, NOW), true);
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.future", continuity: "future-class" }, NOW), true);
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.invalid", continuity: 7 }, NOW), false);
    registry = readKnownAddressRegistry(f.catalog, NOW, { prune: false });
    const durable = registry.entries.find((candidate) => candidate.address.endsWith(".alias"));
    const future = registry.entries.find((candidate) => candidate.address.endsWith(".future"));
    assert.equal(durable.expiresAt, "2026-08-16T00:00:00.000Z");
    assert.equal(future.continuity, "future-class");
    assert.equal(future.expiresAt, "2026-08-09T12:00:00.000Z");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("strict schema rejects duplicates, extra fields, control characters, and oversized files", () => {
  const f = fixture();
  try {
    const duplicate = entry("@principal.agent.session");
    writeRegistry(f, [duplicate, duplicate]);
    assert.deepEqual(readKnownAddressRegistry(f.catalog, NOW), { available: false, entries: [], reason: "malformed" });

    writeRegistry(f, [{ ...duplicate, extra: true }]);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).available, false);

    writeRegistry(f, [entry("@principal.agent.session", { continuity: "bad\nvalue" })]);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).available, false);

    writeFileSync(f.path, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });
    assert.deepEqual(readKnownAddressRegistry(f.catalog, NOW), { available: false, entries: [], reason: "unsafe" });
  } finally { f.cleanup(); }
});

test("hostile permissions and symlinks are unavailable and never overwritten", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    writeRegistry(f, [entry("@principal.agent.session")], 0o644);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).available, false);
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.other", continuity: "ephemeral" }, NOW), false);
    assert.equal(statSync(f.path).mode & 0o777, 0o644);

    rmSync(f.path);
    const outside = join(f.root, "outside");
    writeFileSync(outside, "outside", { mode: 0o600 });
    symlinkSync(outside, f.path);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).available, false);
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.other", continuity: "ephemeral" }, NOW), false);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally { f.cleanup(); }
});

test("logical expiry is immediate and physical pruning is best effort under contention", () => {
  const f = fixture();
  try {
    writeRegistry(f, [
      entry("@principal.agent.expired", { expiresAt: "2026-08-08T23:59:59.000Z" }),
      entry("@principal.agent.active"),
    ]);
    withOwnerOnlyFileLock(f.path, { label: "Parle known-address registry", durability: "none" }, () => {
      const registry = readKnownAddressRegistry(f.catalog, NOW);
      assert.deepEqual(registry.entries.map((candidate) => candidate.address), ["@principal.agent.active"]);
      assert.equal(JSON.parse(readFileSync(f.path, "utf8")).entries.length, 2);
    });
    assert.equal(readKnownAddressRegistry(f.catalog, NOW).entries.length, 1);
    assert.equal(JSON.parse(readFileSync(f.path, "utf8")).entries.length, 1);
  } finally { f.cleanup(); }
});

test("concurrent writer contention is bounded and never clobbers committed state", () => {
  const f = fixture();
  try {
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.first", continuity: "ephemeral" }, NOW), true);
    withOwnerOnlyFileLock(f.path, { label: "Parle known-address registry", durability: "none" }, () => {
      assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.contended", continuity: "ephemeral" }, NOW), false);
      assert.deepEqual(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries.map((candidate) => candidate.address), ["@principal.agent.first"]);
    });
    assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.second", continuity: "ephemeral" }, NOW), true);
    assert.deepEqual(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries.map((candidate) => candidate.address).sort(), ["@principal.agent.first", "@principal.agent.second"]);
  } finally { f.cleanup(); }
});

test("capacity eviction is deterministic by expiry, address, and composite identity", () => {
  const f = fixture();
  try {
    for (let index = 256; index >= 0; index -= 1) {
      const suffix = String(index).padStart(3, "0");
      assert.equal(enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: `@principal.agent.s${suffix}`, continuity: "ephemeral" }, NOW), true);
    }
    const entries = readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries;
    assert.equal(entries.length, 256);
    assert.equal(entries.some((candidate) => candidate.address === "@principal.agent.s000"), false);
    assert.equal(entries.some((candidate) => candidate.address === "@principal.agent.s256"), true);
  } finally { f.cleanup(); }
});

test("422 shortening changes only an existing matching entry and never creates one", () => {
  const f = fixture();
  try {
    assert.equal(shortenKnownAddressAfterUnprocessable(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.missing" }, NOW), true);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries.length, 0);

    enrollKnownAddress(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.session", continuity: "durable" }, NOW);
    shortenKnownAddressAfterUnprocessable(f.catalog, { apiBase: API, roomId: ROOM, address: "@principal.agent.session" }, NOW);
    assert.equal(readKnownAddressRegistry(f.catalog, NOW, { prune: false }).entries[0].expiresAt, "2026-08-09T01:00:00.000Z");
  } finally { f.cleanup(); }
});

test("rendering is room scoped, latest first, capped, and explicit about local authority", () => {
  const entries = Array.from({ length: 12 }, (_, index) => entry(`@principal.agent.s${String(index).padStart(2, "0")}`, {
    expiresAt: new Date(NOW.getTime() + (index + 1) * 60_000).toISOString(),
  }));
  entries.push(entry("@principal.agent.other", { roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1f" }));
  const block = renderKnownAddressContext({ available: true, entries }, { apiBase: API, roomId: ROOM });
  assert.match(block, new RegExp(KNOWN_ADDRESS_CONTEXT_MARKER.replace(/[\[\]]/g, "\\$&")));
  assert.match(block, /proves neither identity, authorization, liveness, nor deliverability/);
  assert.match(block, /showing 10 of 12/);
  assert.ok(block.indexOf("@principal.agent.s11") < block.indexOf("@principal.agent.s10"));
  assert.doesNotMatch(block, /@principal.agent.s00/);
  assert.doesNotMatch(block, /@principal.agent.other/);
});
