import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ParleAccountClient,
  activeRoomSectionFromStatus,
  composeRoomInventory,
  formatRoomInventory,
  parseAccountRoomPage,
} from "../dist/index.js";

const ROOM_A = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
const ROOM_B = "019f7b46-178f-7a5a-9f7b-b4af2e045262";
const ROOM_C = "019f7b46-178f-7a5a-9f7b-b4af2e045263";
const PRINCIPAL = "019f3894-bb87-726a-8deb-17d367054426";

function room(roomId, handle, relationship = "owner") {
  return {
    room_id: roomId,
    room_handle: handle,
    private: relationship === "owner",
    created_at: "2026-08-01T12:00:00Z",
    relationship,
    owner: { principal_id: PRINCIPAL, principal_handle: relationship === "owner" ? "gilman" : null },
  };
}

function fixture(catalog = `[default]\nroom_id = ${ROOM_A}\nagent_token = parle_agt_default\n\n[other]\nroom_id = ${ROOM_C}\nagent_token = parle_agt_other\n`) {
  const home = mkdtempSync(join(tmpdir(), "parle-rooms-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-rooms-cwd-"));
  const state = join(home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "profiles"), catalog, { mode: 0o600 });
  writeFileSync(join(state, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  return {
    home,
    cwd,
    state,
    env: { HOME: home, PARLE_API_BASE: "http://127.0.0.1:8787", PARLE_ALLOW_INSECURE_LOCAL: "1" },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function response(json, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

test("account room pages preserve unknown relationship values and reject malformed wire shapes", () => {
  const page = parseAccountRoomPage({ rooms: [room(ROOM_A, null, "delegated")], next: "cursor-2" });
  assert.equal(page.rooms[0].relationship, "delegated");
  assert.equal(page.rooms[0].roomHandle, null);
  assert.equal(page.next, "cursor-2");
  assert.throws(() => parseAccountRoomPage({ rooms: [room(ROOM_A, "bad", "line\nbreak")], next: null }), /without control characters/);
  assert.throws(() => parseAccountRoomPage({ rooms: [], next: undefined }), /next must be/);
});

test("composition is deterministic and compact presentation keeps source meanings separate", () => {
  const active = { state: "complete", rows: [
    { roomId: ROOM_B, roomHandle: "active-only", profile: "runtime", state: "ready" },
    { roomId: ROOM_A, roomHandle: "account-active", profile: "default", state: "ready" },
  ] };
  const configured = { state: "complete", rows: [
    { profile: "zeta", roomId: ROOM_C },
    { profile: "alpha", roomId: ROOM_A },
    { profile: "beta", roomId: ROOM_C },
  ] };
  const account = { state: "truncated", rows: [parseAccountRoomPage({ rooms: [room(ROOM_A, "account", "future_role")], next: null }).rooms[0]], limit: 2000 };
  const merged = composeRoomInventory(active, configured, account);
  assert.deepEqual(merged.map((row) => row.roomId), [ROOM_A, ROOM_B, ROOM_C]);
  assert.deepEqual(merged[0].profiles, ["alpha"]);
  assert.deepEqual(merged[2].profiles, ["beta", "zeta"]);
  const text = formatRoomInventory(active, configured, account);
  assert.match(text, /future_role/);
  assert.match(text, /enforced 2000-row limit/);
  assert.match(text, /active-only \(runtime, ready\)/);
  assert.match(text, /beta: .* \(unverified\)/);
});

test("listRooms paginates account truth, redacts configured profiles, and preserves partial sources", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const parsed = new URL(url);
        calls.push({ path: parsed.pathname, after: parsed.searchParams.get("after"), cookie: init.headers.Cookie });
        if (!parsed.searchParams.has("after")) return response({ rooms: [room(ROOM_A, "alpha")], next: "opaque-next" });
        assert.equal(parsed.searchParams.get("after"), "opaque-next");
        return response({ rooms: [room(ROOM_B, "joined", "member")], next: null });
      },
    });
    const active = activeRoomSectionFromStatus({ runtime: { bootstrapped: true }, rooms: [{ roomId: ROOM_A, roomHandle: "alpha", profile: "default", state: "ready" }] });
    const result = await client.listRooms(active);
    assert.equal(result.account.state, "complete");
    assert.deepEqual(result.account.rows.map((row) => row.roomId), [ROOM_A, ROOM_B]);
    assert.deepEqual(result.configured, { state: "complete", rows: [{ profile: "default", roomId: ROOM_A }, { profile: "other", roomId: ROOM_C }] });
    assert.deepEqual(result.rooms.map((row) => row.roomId), [ROOM_A, ROOM_B, ROOM_C]);
    assert.equal(JSON.stringify(result).includes("parle_agt_"), false);
    assert.equal(JSON.stringify(result).includes(f.home), false);
    assert.equal(calls.every((call) => call.cookie === "__Host-parle_session=human-cookie"), true);
  } finally { f.cleanup(); }
});

test("profile failure stays path-free and does not erase account or active inventory", async () => {
  const pathCanary = "catalog-path-canary";
  const f = fixture(`${pathCanary}\n`);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    chmodSync(join(f.state, "profiles"), 0o644);
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ rooms: [room(ROOM_A, "alpha")], next: null }) });
    const active = { state: "complete", rows: [{ roomId: ROOM_C, roomHandle: null, profile: "runtime", state: "ready" }] };
    const result = await client.listRooms(active);
    assert.deepEqual(result.configured, { state: "error", reason: "profile_catalog_invalid" });
    assert.equal(result.account.state, "complete");
    assert.equal(result.active.state, "complete");
    assert.equal(JSON.stringify(result).includes(pathCanary), false);
    assert.equal(JSON.stringify(warnings).includes(f.home), false);
  } finally {
    console.warn = originalWarn;
    f.cleanup();
  }
});

test("account failures are typed and never erase configured inventory", async () => {
  const f = fixture();
  try {
    const rejected = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ error: { message: "expired" } }, 401) });
    const rejectedResult = await rejected.listRooms({ state: "unavailable", reason: "runtime_not_bootstrapped" });
    assert.deepEqual(rejectedResult.account, { state: "unavailable", reason: "human_session_rejected" });
    assert.equal(rejectedResult.configured.state, "complete");

    const repeated = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ rooms: [], next: "same" }) });
    const repeatedResult = await repeated.listRooms({ state: "unavailable", reason: "runtime_not_bootstrapped" });
    assert.deepEqual(repeatedResult.account, { state: "error", reason: "account_response_invalid" });
    assert.equal(repeatedResult.configured.state, "complete");
  } finally { f.cleanup(); }
});

test("account pagination stops at the documented finite ceiling", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => {
        calls += 1;
        const suffix = String(calls).padStart(12, "0");
        return response({ rooms: [room(`019f7b46-178f-7a5a-9f7b-${suffix}`, `room-${calls}`)], next: `cursor-${calls}` });
      },
    });
    const result = await client.listRooms({ state: "unavailable", reason: "runtime_not_bootstrapped" });
    assert.equal(calls, 10);
    assert.deepEqual(result.account, { state: "truncated", rows: result.account.rows, limit: 2000 });
    assert.equal(result.account.rows.length, 10);
  } finally { f.cleanup(); }
});

test("login selection reuses account pagination instead of ignoring next", async () => {
  const f = fixture();
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/v/rooms" && !parsed.searchParams.has("after")) return response({ rooms: [room(ROOM_A, "alpha")], next: "more" });
        if (parsed.pathname === "/v/rooms") return response({ rooms: [room(ROOM_B, "joined", "member")], next: null });
        if (parsed.pathname === "/v/agents") return response({ agents: [] });
        throw new Error(`unexpected ${parsed.pathname}`);
      },
    });
    const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "test pagination", profile: "new-profile" });
    assert.equal(result.status, "selection_required");
    assert.deepEqual(result.rooms, [
      { room_id: ROOM_A, room_handle: "alpha" },
      { room_id: ROOM_B, room_handle: "joined" },
    ]);
  } finally { f.cleanup(); }
});
