import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ParleAccountClient } from "../dist/index.js";

const ROOM_ID = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
const PRINCIPAL_ID = "019f3894-bb87-726a-8deb-17d367054426";
const INVITE_ID = "019f7c00-0000-7000-8000-000000000001";
const SEAT_ID = "019f7c00-0000-7000-8000-000000000002";
const PARTICIPANT_ID = "019f7c00-0000-7000-8000-000000000003";
const SECRET = `parle_inv_${"z".repeat(43)}`;
const CODE = "ABCDEFGHIJ";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "parle-account-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-account-cwd-"));
  const state = join(home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "profiles"), `[default]\nroom_id = ${ROOM_ID}\nagent_token = parle_agt_fixture\napi_base = http://127.0.0.1:8787\n`, { mode: 0o600 });
  writeFileSync(join(state, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  return {
    home,
    cwd,
    env: { HOME: home, PARLE_PROFILE: "default", PARLE_ALLOW_INSECURE_LOCAL: "1" },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function response(json, status = 200) {
  return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
}

test("principal invite mint writes a private capability bundle and returns only safe facts", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      now: () => new Date("2026-07-19T20:00:00.000Z"),
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        return response({
          invite_id: INVITE_ID,
          room_id: ROOM_ID,
          secret: SECRET,
          code: CODE,
          seat_type: "principal",
          target_principal_id: PRINCIPAL_ID,
          target_display: { handle: "kljensen", display_name: "Kyle Jensen" },
          offered_rights: [],
          ttl_seconds: 604800,
        }, 201);
      },
    });
    const result = await client.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "KLJENSEN", confirmMutation: true, reason: "Invite Kyle" });
    assert.equal(result.targetPrincipalId, PRINCIPAL_ID);
    assert.equal(result.targetHandle, "kljensen");
    assert.equal(result.handoffPath, join(realpathSync(join(f.home, ".parle", "invites")), `${INVITE_ID}.json`));
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes(CODE), false);
    assert.equal(lstatSync(result.handoffPath).isSymbolicLink(), false);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(dirname(result.handoffPath)).mode & 0o077, 0);
      assert.equal(lstatSync(result.handoffPath).mode & 0o077, 0);
    }
    const handoff = JSON.parse(readFileSync(result.handoffPath, "utf8"));
    assert.equal(handoff.secret, SECRET);
    assert.equal(handoff.code, CODE);
    assert.equal(handoff.targetPrincipalId, PRINCIPAL_ID);
    assert.deepEqual(calls, [{
      url: `http://127.0.0.1:8787/v/rooms/${ROOM_ID}/invites`,
      method: "POST",
      headers: { Accept: "application/json", "Parle-Version": "2026-07-07", Cookie: "__Host-parle_session=human-cookie", "Content-Type": "application/json" },
      body: { seat_type: "principal", target: { kind: "principal", principal_id: PRINCIPAL_ID } },
    }]);
  } finally {
    f.cleanup();
  }
});

test("mint refuses immutable target mismatches and never overwrites a pre-existing handoff", async () => {
  const f = fixture();
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ invite_id: INVITE_ID, room_id: ROOM_ID, secret: SECRET, code: CODE, seat_type: "principal", target_principal_id: "019f3894-bb87-726a-8deb-17d367054427", target_display: { handle: "other" }, offered_rights: [], ttl_seconds: 3600 }, 201) });
    await assert.rejects(client.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /did not match the requested immutable principal/);
    assert.equal(existsSync(join(f.home, ".parle", "invites", `${INVITE_ID}.json`)), false);
    const wrongLabel = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ invite_id: INVITE_ID, room_id: ROOM_ID, secret: SECRET, code: CODE, seat_type: "principal", target_principal_id: PRINCIPAL_ID, target_display: { handle: "someone-else" }, offered_rights: [], ttl_seconds: 3600 }, 201) });
    await assert.rejects(wrongLabel.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /target handle did not match/);

    const inviteDir = join(f.home, ".parle", "invites");
    const finalPath = join(inviteDir, `${INVITE_ID}.json`);
    writeFileSync(finalPath, "pre-existing\n", { mode: 0o600 });
    const matching = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ invite_id: INVITE_ID, room_id: ROOM_ID, secret: SECRET, code: CODE, seat_type: "principal", target_principal_id: PRINCIPAL_ID, target_display: { handle: "kljensen" }, offered_rights: [], ttl_seconds: 3600 }, 201) });
    await assert.rejects(matching.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /already exists/);
    assert.equal(readFileSync(finalPath, "utf8"), "pre-existing\n");
  } finally {
    f.cleanup();
  }
});

test("mint refuses an unignored invite directory inside a git work tree before network access", () => {
  const f = fixture();
  let called = false;
  try {
    execFileSync("git", ["init", "-q", f.home]);
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { called = true; return response({}); } });
    return assert.rejects(client.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /inside a git work tree and is not ignored/).then(() => assert.equal(called, false)).finally(f.cleanup);
  } catch (error) {
    f.cleanup();
    if (error?.code === "ENOENT") return;
    throw error;
  }
});

test("principal invite preview and complete use the private bundle and delete it only after success", async () => {
  const f = fixture();
  const calls = [];
  try {
    const inviteDir = join(f.home, ".parle", "invites");
    mkdirSync(inviteDir, { mode: 0o700 });
    const handoffPath = join(inviteDir, `${INVITE_ID}.json`);
    writeFileSync(handoffPath, JSON.stringify({
      schemaVersion: 1,
      kind: "parle-principal-invite",
      apiVersion: "2026-07-07",
      inviteId: INVITE_ID,
      roomId: ROOM_ID,
      secret: SECRET,
      code: CODE,
      seatType: "principal",
      targetPrincipalId: PRINCIPAL_ID,
      targetHandle: "kljensen",
      offeredRights: [],
      createdAt: "2026-07-19T20:00:00.000Z",
      expiresAt: "2026-07-26T20:00:00.000Z",
    }), { mode: 0o600 });
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: JSON.parse(init.body), cookie: init.headers.Cookie });
        if (path.endsWith("/preview")) return response({ room_id: ROOM_ID, assurance: "unhardened", facts: [], seat_type: "principal", offered_rights: [], expires_at: "2026-07-26T20:00:00Z", history_visible: true });
        return response({ room_id: ROOM_ID, seat_id: SEAT_ID, participant_id: PARTICIPANT_ID, state: "seated", generation: "g0", since_seq: 0, actor: null }, 201);
      },
    });
    const preview = await client.claimPrincipalInvite({ action: "preview", handoffPath });
    assert.equal(preview.roomId, ROOM_ID);
    assert.equal(preview.historyVisible, true);
    assert.equal(existsSync(handoffPath), true);
    const complete = await client.claimPrincipalInvite({ action: "complete", handoffPath, confirmMutation: true, reason: "Kyle approved admission" });
    assert.equal(complete.seatId, SEAT_ID);
    assert.equal(complete.handoffDeleted, true);
    assert.equal(existsSync(handoffPath), false);
    assert.deepEqual(calls, [
      { path: "/v/claim/preview", body: { secret: SECRET, code: CODE }, cookie: "__Host-parle_session=human-cookie" },
      { path: "/v/claim/complete", body: { secret: SECRET, code: CODE }, cookie: "__Host-parle_session=human-cookie" },
    ]);
  } finally {
    f.cleanup();
  }
});

test("a successful claim consumes the handoff even when advisory response fields drift", async () => {
  const f = fixture();
  try {
    const inviteDir = join(f.home, ".parle", "invites");
    mkdirSync(inviteDir, { mode: 0o700 });
    const handoffPath = join(inviteDir, `${INVITE_ID}.json`);
    writeFileSync(handoffPath, JSON.stringify({ schemaVersion: 1, kind: "parle-principal-invite", apiVersion: "2026-07-07", inviteId: INVITE_ID, roomId: ROOM_ID, secret: SECRET, code: CODE, seatType: "principal", targetPrincipalId: PRINCIPAL_ID, targetHandle: "kljensen", offeredRights: [], createdAt: "2026-07-19T20:00:00Z", expiresAt: "2026-07-26T20:00:00Z" }), { mode: 0o600 });
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ accepted: true }, 201) });
    const result = await client.claimPrincipalInvite({ action: "complete", handoffPath, confirmMutation: true, reason: "claim" });
    assert.equal(result.state, "completed");
    assert.equal(result.roomId, ROOM_ID);
    assert.equal(result.handoffDeleted, true);
    assert.equal(result.warnings.length, 4);
    assert.equal(existsSync(handoffPath), false);
  } finally {
    f.cleanup();
  }
});

test("claim failures redact the capability and preserve the handoff", async () => {
  const f = fixture();
  try {
    const inviteDir = join(f.home, ".parle", "invites");
    mkdirSync(inviteDir, { mode: 0o700 });
    const handoffPath = join(inviteDir, `${INVITE_ID}.json`);
    writeFileSync(handoffPath, JSON.stringify({ schemaVersion: 1, kind: "parle-principal-invite", apiVersion: "2026-07-07", inviteId: INVITE_ID, roomId: ROOM_ID, secret: SECRET, code: CODE, seatType: "principal", targetPrincipalId: PRINCIPAL_ID, targetHandle: "kljensen", offeredRights: [], createdAt: "2026-07-19T20:00:00Z", expiresAt: "2026-07-26T20:00:00Z" }), { mode: 0o600 });
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ error: { code: "unauthenticated", message: `bad ${SECRET} ${CODE}` } }, 401) });
    await assert.rejects(client.claimPrincipalInvite({ action: "complete", handoffPath, confirmMutation: true, reason: "claim" }), (error) => {
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(error.message.includes(CODE), false);
      assert.match(error.message, /<redacted>/);
      return true;
    });
    assert.equal(existsSync(handoffPath), true);
  } finally {
    f.cleanup();
  }
});

test("claim rejects symlinked and permissive handoff files before network access", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  let called = false;
  try {
    const inviteDir = join(f.home, ".parle", "invites");
    mkdirSync(inviteDir, { mode: 0o700 });
    const real = join(inviteDir, `${INVITE_ID}.json`);
    const link = join(inviteDir, "019f7c00-0000-7000-8000-000000000099.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    symlinkSync(real, link);
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { called = true; return response({}); } });
    const outside = join(f.home, "019f7c00-0000-7000-8000-000000000088.json");
    writeFileSync(outside, "{}", { mode: 0o600 });
    await assert.rejects(client.claimPrincipalInvite({ action: "preview", handoffPath: outside }), /must resolve directly inside/);
    await assert.rejects(client.claimPrincipalInvite({ action: "preview", handoffPath: link }), /must not be a symbolic link/);
    unlinkSync(link);
    chmodSync(real, 0o644);
    await assert.rejects(client.claimPrincipalInvite({ action: "preview", handoffPath: real }), /must be mode 0600/);
    chmodSync(real, 0o600);
    chmodSync(inviteDir, 0o755);
    await assert.rejects(client.claimPrincipalInvite({ action: "preview", handoffPath: real }), /invite directory must be mode 0700/);
    assert.equal(called, false);
  } finally {
    f.cleanup();
  }
});
