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
const AGENT_ID = "019f7c00-0000-7000-8000-000000000004";
const AGENT_TOKEN_ID = "019f7c00-0000-7000-8000-000000000005";
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

test("principal invite mint returns a non-secret target-session locator", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        return response({
          invite_id: INVITE_ID,
          room_id: ROOM_ID,
          claim_mode: "target_session",
          claim_url: `http://127.0.0.1:8787/join/${INVITE_ID}`,
          seat_type: "principal",
          target_principal_id: PRINCIPAL_ID,
          target_display: { handle: "kljensen" },
          offered_rights: [],
          expires_at: "2026-07-26T20:00:00Z",
        }, 201);
      },
    });
    const result = await client.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "KLJENSEN", confirmMutation: true, reason: "Invite Kyle" });
    assert.equal(result.targetPrincipalId, PRINCIPAL_ID);
    assert.equal(result.targetHandle, "kljensen");
    assert.equal(result.claimUrl, `http://127.0.0.1:8787/join/${INVITE_ID}`);
    assert.equal(result.sensitive, false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.deepEqual(calls[0].body, { claim_mode: "target_session", seat_type: "principal", target: { kind: "principal", principal_id: PRINCIPAL_ID } });
    assert.equal(existsSync(join(f.home, ".parle", "invites")), false);
  } finally { f.cleanup(); }
});

test("target-session mint rejects authority material and immutable target drift", async () => {
  const f = fixture();
  try {
    const base = { invite_id: INVITE_ID, room_id: ROOM_ID, claim_mode: "target_session", claim_url: `http://127.0.0.1:8787/join/${INVITE_ID}`, seat_type: "principal", target_principal_id: PRINCIPAL_ID, target_display: { handle: "kljensen" }, offered_rights: [], expires_at: "2026-07-26T20:00:00Z" };
    const secret = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ ...base, secret: SECRET }, 201) });
    await assert.rejects(secret.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /authority material/);
    const mismatch = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ ...base, target_principal_id: "019f3894-bb87-726a-8deb-17d367054427" }, 201) });
    await assert.rejects(mismatch.mintPrincipalInvite({ roomId: ROOM_ID, principalId: PRINCIPAL_ID, principalHandle: "kljensen", confirmMutation: true, reason: "invite" }), /did not match/);
  } finally { f.cleanup(); }
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

test("target-session invitation preview and acceptance use only the configured canonical origin", async () => {
  const f = fixture();
  const calls = [];
  try {
    const status = { invite_id: INVITE_ID, state: "pending", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, inviter_handle: "gilman", seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: null, principal_seat_active: false };
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).endsWith("/accept")) return response({ room_id: ROOM_ID, seat_id: SEAT_ID, participant_id: PARTICIPANT_ID, state: "seated" }, 201);
      return response(status);
    } });
    const preview = await client.acceptRoomInvitation({ action: "preview", invitation: `http://127.0.0.1:8787/join/${INVITE_ID}` });
    assert.equal(preview.state, "pending");
    const accepted = await client.acceptRoomInvitation({ action: "accept", invitation: INVITE_ID, confirmMutation: true, reason: "accept" });
    assert.equal(accepted.principal, "accepted");
    assert.equal(accepted.agent, "needs_selection");
    assert.deepEqual(calls.map((call) => call.url), [
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}`,
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}`,
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}/accept`,
    ]);
    await assert.rejects(client.acceptRoomInvitation({ action: "preview", invitation: `https://evil.example/join/${INVITE_ID}` }), /configured canonical Parle API origin/);
  } finally { f.cleanup(); }
});

test("connect workflow previews immutable selection and publishes a credential without returning it", async () => {
  const f = fixture();
  try {
    const paths = [];
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      paths.push(`${init.method || "GET"} ${path}`);
      if (path === `/v/room-invitations/${INVITE_ID}`) return response({ invite_id: INVITE_ID, state: "accepted", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: "2026-07-19T20:00:00Z", principal_seat_active: true });
      if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "kyleops", display_name: "Kyle Ops" }] });
      if (path === `/v/rooms/${ROOM_ID}`) return response({ roster: { agent_seats: [] } });
      if (path === `/v/rooms/${ROOM_ID}/seats`) return response({ seat_id: SEAT_ID, agent_id: AGENT_ID }, 201);
      if (path === `/v/agents/${AGENT_ID}/tokens` && (init.method || "GET") === "GET") return response({ tokens: [] });
      if (path === `/v/agents/${AGENT_ID}/tokens`) return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"x".repeat(43)}` }, 201);
      throw new Error(`unexpected ${path}`);
    } });
    const preview = await client.connectOwnAgent({ action: "preview", invitation: INVITE_ID });
    assert.equal(preview.selectedAgent.agentId, AGENT_ID);
    assert.equal(preview.agent, "selected");
    const complete = await client.connectOwnAgent({ action: "complete", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" });
    assert.equal(complete.profile, "galexc-kyleops");
    assert.equal(complete.credential, "profile_ready");
    assert.equal(JSON.stringify(complete).includes("parle_agt_"), false);
    const catalog = readFileSync(join(f.home, ".parle", "profiles"), "utf8");
    assert.match(catalog, /\[galexc-kyleops\]/);
    assert.match(catalog, /agent_token_id = 019f7c00-0000-7000-8000-000000000005/);
    assert.equal(paths.includes(`POST /v/rooms/${ROOM_ID}/seats`), true);
  } finally { f.cleanup(); }
});

test("connect treats token-mint 5xx as outcome unknown and never retries", async () => {
  const f = fixture();
  let mintCalls = 0;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method || "GET";
      if (path === `/v/room-invitations/${INVITE_ID}`) return response({ invite_id: INVITE_ID, state: "accepted", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: "2026-07-19T20:00:00Z", principal_seat_active: true });
      if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "kyleops" }] });
      if (path === `/v/rooms/${ROOM_ID}`) return response({ roster: { agent_seats: [{ seat_id: SEAT_ID, agent_id: AGENT_ID }] } });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "GET") return response({ tokens: [] });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "POST") {
        mintCalls += 1;
        return response({ error: { code: "server_error", message: "gateway timeout" } }, 504);
      }
      throw new Error(`unexpected ${method} ${path}`);
    } });
    const result = await client.connectOwnAgent({ action: "complete", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" });
    assert.equal(result.credential, "outcome_unknown");
    assert.equal(result.recoveryAgentId, AGENT_ID);
    assert.match(result.next, /Do not retry/);
    assert.match(result.next, /#451/);
    assert.equal(mintCalls, 1);
    assert.equal(readFileSync(join(f.home, ".parle", "profiles"), "utf8").includes("galexc-kyleops"), false);
  } finally { f.cleanup(); }
});

test("connect revokes a known minted token when atomic profile publication fails", async () => {
  const f = fixture();
  const catalog = join(f.home, ".parle", "profiles");
  let revoked = false;
  const token = `parle_agt_${"q".repeat(43)}`;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method || "GET";
      if (path === `/v/room-invitations/${INVITE_ID}`) return response({ invite_id: INVITE_ID, state: "accepted", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: "2026-07-19T20:00:00Z", principal_seat_active: true });
      if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "kyleops" }] });
      if (path === `/v/rooms/${ROOM_ID}`) return response({ roster: { agent_seats: [{ seat_id: SEAT_ID, agent_id: AGENT_ID }] } });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "GET") return response({ tokens: [] });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "POST") {
        writeFileSync(catalog, readFileSync(catalog, "utf8") + "\n[raced]\nroom_id = 019f7c00-0000-7000-8000-000000000099\nagent_token = parle_agt_raced\n", { mode: 0o600 });
        return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token }, 201);
      }
      if (path === `/v/agents/${AGENT_ID}/tokens/${AGENT_TOKEN_ID}` && method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${method} ${path}`);
    } });
    await assert.rejects(client.connectOwnAgent({ action: "complete", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" }), (error) => {
      assert.match(error.message, /profile catalog changed after preflight/);
      assert.match(error.message, /Credential cleanup succeeded/);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    assert.equal(revoked, true);
    assert.equal(readFileSync(catalog, "utf8").includes(token), false);
  } finally { f.cleanup(); }
});

test("connect never clobbers an occupied explicit profile and does not mint", async () => {
  const f = fixture();
  const catalog = join(f.home, ".parle", "profiles");
  const original = readFileSync(catalog, "utf8");
  let minted = false;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method || "GET";
      if (path === `/v/room-invitations/${INVITE_ID}`) return response({ invite_id: INVITE_ID, state: "accepted", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: "2026-07-19T20:00:00Z", principal_seat_active: true });
      if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "kyleops" }] });
      if (path === `/v/rooms/${ROOM_ID}`) return response({ roster: { agent_seats: [{ seat_id: SEAT_ID, agent_id: AGENT_ID }] } });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "GET") return response({ tokens: [] });
      if (path === `/v/agents/${AGENT_ID}/tokens` && method === "POST") { minted = true; return response({}, 201); }
      throw new Error(`unexpected ${method} ${path}`);
    } });
    await assert.rejects(client.connectOwnAgent({ action: "complete", invitation: INVITE_ID, agentId: AGENT_ID, profileLabel: "default", confirmMutation: true, reason: "connect" }), /already exists with an unproven binding/);
    assert.equal(minted, false);
    assert.equal(readFileSync(catalog, "utf8"), original);
  } finally { f.cleanup(); }
});
