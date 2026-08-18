import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ParleAccountClient, ParleAccountResponseContractError, recoveryInvokerState } from "../dist/index.js";

const ROOM_ID = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
const PRINCIPAL_ID = "019f3894-bb87-726a-8deb-17d367054426";
const INVITE_ID = "019f7c00-0000-7000-8000-000000000001";
const SEAT_ID = "019f7c00-0000-7000-8000-000000000002";
const PARTICIPANT_ID = "019f7c00-0000-7000-8000-000000000003";
const AGENT_ID = "019f7c00-0000-7000-8000-000000000004";
const AGENT_TOKEN_ID = "019f7c00-0000-7000-8000-000000000005";
const AGENT_SESSION_ID = "019f7c00-0000-7000-8000-000000000008";
const ADDITIONAL_AGENT_SESSION_ID = "019f7c00-0000-7000-8000-000000000009";
const THIRD_AGENT_SESSION_ID = "019f7c00-0000-7000-8000-000000000011";
const ADDITIONAL_AGENT_ID = "019f7c00-0000-7000-8000-000000000006";
const ADDITIONAL_AGENT_TOKEN_ID = "019f7c00-0000-7000-8000-000000000007";
const SECRET = `parle_inv_${"z".repeat(43)}`;
const CODE = "ABCDEFGHIJ";

function loginFixture() {
  const home = mkdtempSync(join(tmpdir(), "parle-account-login-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-account-login-cwd-"));
  return {
    home,
    cwd,
    env: { HOME: home },
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

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

function accountRoomPage(roomId = ROOM_ID, roomHandle = "room-one", privateRoom = false) {
  return {
    rooms: [{
      room_id: roomId,
      room_handle: roomHandle,
      private: privateRoom,
      created_at: "2026-08-01T12:00:00Z",
      relationship: "owner",
      owner: { principal_id: PRINCIPAL_ID, principal_handle: "owner" },
    }],
    next: null,
  };
}

function roomDetails(agentIds = [AGENT_ID]) {
  return {
    roster: {
      agent_seats: agentIds.map((agentId, index) => ({
        seat_id: index === 0 ? SEAT_ID : `019f7c00-0000-7000-8000-0000000000${index + 10}`,
        agent_id: agentId,
        admitted_at: "2026-08-03T12:00:00Z",
      })),
    },
  };
}

test("login start prefers server guidance and keeps a no-oracle safety floor", async () => {
  const f = loginFixture();
  try {
    const next = "Request accepted. This does not confirm that an email was sent. If a code arrives, complete returning-account login. Do not retry automatically.";
    const serverResponse = {
      status: "if_account_exists_code_sent",
      requested_flow: "returning_login",
      delivery_status: "not_disclosed",
      next_action: "complete_returning_login_if_code_received",
      automatic_retry: false,
      guidance: next,
      future_field: "preserved",
    };
    const accepted = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response(serverResponse, 202),
    });
    assert.deepEqual(await accepted.login({ email: "user@example.test" }), {
      status: "start_accepted",
      serverStatus: "if_account_exists_code_sent",
      serverResponse,
      email: "user@example.test",
      next,
    });

    const unknown = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => new Response("not-json", { status: 202 }),
    });
    assert.deepEqual(await unknown.login({ action: "start", email: "user@example.test" }), {
      status: "start_accepted",
      email: "user@example.test",
      next: "Request accepted. This does not confirm that an account, invitation, or email delivery exists. If a code arrives, complete only the flow you selected. Do not retry automatically or start the other flow.",
    });
  } finally { f.cleanup(); }
});

test("onboarding start preserves server guidance and completion saves only the human session", async () => {
  const f = loginFixture();
  const calls = [];
  try {
    const guidance = "Request accepted. This does not confirm that an email was sent. If a code arrives, complete first-time onboarding. Do not retry automatically.";
    const serverResponse = {
      status: "if_invited_code_sent",
      requested_flow: "first_time_onboarding",
      delivery_status: "not_disclosed",
      next_action: "complete_onboarding_if_code_received",
      automatic_retry: false,
      guidance,
      future_field: "preserved",
    };
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: JSON.parse(init.body) });
        if (path === "/v/onboarding/start") return response(serverResponse, 202);
        if (path === "/v/onboarding/complete") {
          return new Response(JSON.stringify({
            status: "onboarded",
            principal_handle: "new-user",
            display_name: "New User",
            session_cookie: "__Host-parle_session",
            setup: { future_field: "preserved", initial_agent_token: { plaintext: "parle_agt_must-not-leak" } },
          }), {
            status: 201,
            headers: { "Set-Cookie": "__Host-parle_session=parle_ses_onboarded-cookie; Path=/; HttpOnly; Secure" },
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    assert.deepEqual(await client.onboard({ action: "start", email: "new@example.test" }), {
      status: "start_accepted",
      serverStatus: "if_invited_code_sent",
      serverResponse,
      email: "new@example.test",
      next: guidance,
    });
    const completed = await client.onboard({
      action: "complete",
      email: "new@example.test",
      code: "123456",
      handle: "new-user",
      displayName: "New User",
      confirmMutation: true,
      reason: "test onboarding",
    });
    assert.equal(completed.status, "session_saved");
    assert.equal(completed.setup, null);
    assert.deepEqual(completed.responseWarnings, ["unexpected_setup_redacted"]);
    assert.equal(JSON.stringify(completed).includes("onboarded-cookie"), false);
    assert.equal(JSON.stringify(completed).includes("must-not-leak"), false);
    assert.equal(readFileSync(join(f.home, ".parle", "session"), "utf8"), "__Host-parle_session=parle_ses_onboarded-cookie\n");
    assert.deepEqual(calls, [
      { path: "/v/onboarding/start", body: { email: "new@example.test" } },
      { path: "/v/onboarding/complete", body: { email: "new@example.test", code: "123456", handle: "new-user", display_name: "New User" } },
    ]);
  } finally { f.cleanup(); }
});

test("onboarding completion without a usable session reports unknown outcome and forbids code replay", async () => {
  const f = loginFixture();
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response({ status: "onboarded", setup: { future_field: true } }, 201),
    });
    const completed = await client.onboard({
      action: "complete",
      email: "new@example.test",
      code: "123456",
      handle: "new-user",
      confirmMutation: true,
      reason: "test uncertain onboarding",
    });
    assert.equal(completed.status, "outcome_unknown");
    assert.equal(completed.credential, "not_persisted");
    assert.equal(completed.wroteSessionCookie, false);
    assert.match(completed.next, /Do not retry the code/);
    assert.match(completed.next, /returning-account login/);
    assert.equal(existsSync(join(f.home, ".parle", "session")), false);
  } finally { f.cleanup(); }
});

test("login complete persists only the shared session without returning secrets or minting", async () => {
  const f = loginFixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), cookie: init.headers.Cookie });
        if (path === "/v/auth/email/complete") return new Response(JSON.stringify({ status: "logged_in" }), { status: 201, headers: { "Set-Cookie": "__Host-parle_session=parle_ses_shared-cookie; Path=/; HttpOnly; Secure" } });
        if (path === "/v/rooms") return response(accountRoomPage());
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
        if (path === `/v/agents/${AGENT_ID}/tokens`) return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"x".repeat(43)}` }, 201);
        throw new Error(`unexpected ${path}`);
      },
    });
    const result = await client.login({ action: "complete", confirmMutation: true, reason: "test", email: "user@example.test", code: "123456" });
    assert.equal(result.status, "session_saved");
    assert.equal(JSON.stringify(result).includes("shared-cookie"), false);
    assert.equal(JSON.stringify(result).includes("parle_agt_"), false);
    assert.equal(readFileSync(join(f.home, ".parle", "session"), "utf8"), "__Host-parle_session=parle_ses_shared-cookie\n");
    assert.equal(existsSync(join(f.home, ".parle", "profiles")), false);
    assert.deepEqual(calls.map((call) => call.path), ["/v/auth/email/complete"]);
    assert.match(result.next, /mint-from-session/);
  } finally { f.cleanup(); }
});

test("hardened email login persists pending state then promotes it with TOTP", async () => {
  const f = loginFixture();
  const calls = [];
  const pending = "__Host-parle_login=parle_lgn_pending-cookie";
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, body: init.body && JSON.parse(init.body), cookie: init.headers.Cookie });
        if (path === "/v/auth/email/complete") {
          return new Response(JSON.stringify({ status: "factor_required", factors: ["totp"], expires_at: "2026-08-07T14:15:00Z" }), {
            status: 202,
            headers: { "Set-Cookie": `${pending}; Path=/; HttpOnly; Secure` },
          });
        }
        if (path === "/v/auth/login/complete") {
          assert.equal(init.headers.Cookie, pending);
          return new Response(null, { status: 204, headers: { "Set-Cookie": "__Host-parle_session=parle_ses_hardened-cookie; Path=/; HttpOnly; Secure" } });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

    const pendingResult = await client.login({ action: "complete", confirmMutation: true, reason: "test hardened", email: "user@example.test", code: "123456" });
    assert.equal(pendingResult.status, "factor_required");
    assert.deepEqual(pendingResult.factors, ["totp"]);
    assert.equal(JSON.stringify(pendingResult).includes("pending-cookie"), false);
    assert.equal(readFileSync(join(f.home, ".parle", "login"), "utf8"), `${pending}\n`);
    assert.equal(existsSync(join(f.home, ".parle", "session")), false);

    const completed = await client.login({ action: "complete-factor", factor: "totp", confirmMutation: true, reason: "finish hardened login", code: "654321" });
    assert.equal(completed.status, "session_saved");
    assert.equal(JSON.stringify(completed).includes("hardened-cookie"), false);
    assert.equal(readFileSync(join(f.home, ".parle", "session"), "utf8"), "__Host-parle_session=parle_ses_hardened-cookie\n");
    assert.equal(existsSync(join(f.home, ".parle", "login")), false);
    assert.deepEqual(calls.map((call) => call.path), ["/v/auth/email/complete", "/v/auth/login/complete"]);
  } finally { f.cleanup(); }
});

test("retryable TOTP refusal preserves pending login and terminal refusal removes it", async () => {
  const f = loginFixture();
  const pending = "__Host-parle_login=parle_lgn_pending-cookie";
  const state = join(f.home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "login"), `${pending}\n`, { mode: 0o600 });
  let attempts = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (_url, init) => {
        attempts += 1;
        assert.equal(init.headers.Cookie, pending);
        if (attempts === 1) return response({ error: { code: "invalid_agent_token" } }, 401);
        return new Response(JSON.stringify({ error: { code: "invalid_agent_token" } }), {
          status: 401,
          headers: { "Set-Cookie": "__Host-parle_login=; Path=/; Max-Age=-1; HttpOnly; Secure" },
        });
      },
    });

    const retryable = await client.login({ action: "complete-factor", factor: "totp", confirmMutation: true, reason: "retry proof", code: "111111" });
    assert.equal(retryable.status, "factor_rejected");
    assert.equal(retryable.retryable, true);
    assert.equal(existsSync(join(state, "login")), true);

    const terminal = await client.login({ action: "complete-factor", factor: "totp", confirmMutation: true, reason: "terminal proof", code: "222222" });
    assert.equal(terminal.status, "factor_rejected");
    assert.equal(terminal.retryable, false);
    assert.equal(existsSync(join(state, "login")), false);
  } finally { f.cleanup(); }
});

test("pending login rejects unsafe custody before TOTP or network access", async () => {
  const f = loginFixture();
  const state = join(f.home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const pendingPath = join(state, "login");
  writeFileSync(pendingPath, "__Host-parle_login=parle_lgn_pending-cookie\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(pendingPath, 0o644);
  let called = false;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { called = true; throw new Error("unexpected network access"); } });
    await assert.rejects(
      client.login({ action: "complete-factor", factor: "totp", confirmMutation: true, reason: "test unsafe custody", code: "test-proof" }),
      process.platform === "win32" ? /unexpected network access/ : /mode 0600/,
    );
    if (process.platform !== "win32") assert.equal(called, false);
  } finally { f.cleanup(); }
});

test("login credential mutations require explicit confirmation and reason before network access", async () => {
  const f = loginFixture();
  let called = false;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { called = true; throw new Error("unexpected network access"); } });
    await assert.rejects(client.login({ action: "complete", email: "user@example.test", code: "123456" }), /confirmMutation=true and a reason/);
    await assert.rejects(client.login({ action: "mint-from-session", confirmMutation: true, roomId: ROOM_ID, agentId: AGENT_ID }), /confirmMutation=true and a reason/);
    assert.equal(called, false);
  } finally { f.cleanup(); }
});

test("login mint-from-session returns seat_required before token mint or credential publication", async () => {
  const f = loginFixture();
  const state = join(f.home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sessionPath = join(state, "session");
  writeFileSync(sessionPath, "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init = {}) => {
        const path = new URL(url).pathname;
        calls.push(`${init.method || "GET"} ${path}`);
        if (path === "/v/rooms") return response(accountRoomPage(ROOM_ID, "private-room", true));
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
        if (path === `/v/rooms/${ROOM_ID}`) return response(roomDetails([ADDITIONAL_AGENT_ID]));
        throw new Error(`unexpected ${init.method || "GET"} ${path}`);
      },
    });

    const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "test missing seat", profile: "new-profile", roomId: ROOM_ID, agentId: AGENT_ID });
    assert.equal(result.status, "seat_required");
    assert.equal(result.wroteCredentials, false);
    assert.equal(result.wroteSessionCookie, false);
    assert.deepEqual(result.room, { room_id: ROOM_ID, room_handle: "private-room" });
    assert.deepEqual(result.agent, { agent_id: AGENT_ID, agent_handle: "agent-one" });
    assert.match(result.next, new RegExp(`parle_add_own_agent_seat.*${ROOM_ID}.*${AGENT_ID}`));
    assert.match(result.next, /confirmMutation:true/);
    assert.equal(JSON.stringify(result).includes("human-cookie"), false);
    assert.equal(existsSync(join(state, "profiles")), false);
    assert.equal(readFileSync(sessionPath, "utf8"), "__Host-parle_session=human-cookie\n");
    assert.deepEqual(calls, ["GET /v/rooms", "GET /v/agents", `GET /v/rooms/${ROOM_ID}`]);
  } finally { f.cleanup(); }
});

test("login mint-from-session rejects malformed room seat evidence before mint or publication", async (t) => {
  const cases = [
    ["malformed roster", { roster: {} }],
    ["malformed matching seat", { roster: { agent_seats: [{ agent_id: AGENT_ID, seat_id: "garbage" }] } }],
  ];
  for (const [name, details] of cases) {
    await t.test(name, async () => {
      const f = loginFixture();
      const state = join(f.home, ".parle");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      const sessionPath = join(state, "session");
      const catalogPath = join(state, "profiles");
      const originalSession = "__Host-parle_session=human-cookie\n";
      const originalProfiles = `[keep]\nroom_id = ${ROOM_ID}\nagent_token = parle_agt_keep\n`;
      writeFileSync(sessionPath, originalSession, { mode: 0o600 });
      writeFileSync(catalogPath, originalProfiles, { mode: 0o600 });
      const calls = [];
      try {
        const client = new ParleAccountClient({
          cwd: f.cwd,
          env: f.env,
          fetch: async (url, init = {}) => {
            const path = new URL(url).pathname;
            calls.push(`${init.method || "GET"} ${path}`);
            if (path === "/v/rooms") return response(accountRoomPage());
            if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
            if (path === `/v/rooms/${ROOM_ID}`) return response(details);
            throw new Error(`unexpected ${init.method || "GET"} ${path}`);
          },
        });

        await assert.rejects(
          client.login({ action: "mint-from-session", confirmMutation: true, reason: "test malformed seat evidence", profile: "new-profile", roomId: ROOM_ID, agentId: AGENT_ID }),
          /Parle room response is invalid/,
        );
        assert.deepEqual(calls, ["GET /v/rooms", "GET /v/agents", `GET /v/rooms/${ROOM_ID}`]);
        assert.equal(readFileSync(sessionPath, "utf8"), originalSession);
        assert.equal(readFileSync(catalogPath, "utf8"), originalProfiles);
      } finally { f.cleanup(); }
    });
  }
});

test("login mint-from-session accepts exact seats in private and shared rooms", async (t) => {
  for (const privateRoom of [true, false]) {
    await t.test(privateRoom ? "private room" : "shared room", async () => {
      const f = loginFixture();
      const state = join(f.home, ".parle");
      mkdirSync(state, { recursive: true, mode: 0o700 });
      writeFileSync(join(state, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
      let mintCalls = 0;
      try {
        const client = new ParleAccountClient({
          cwd: f.cwd,
          env: f.env,
          fetch: async (url, init = {}) => {
            const path = new URL(url).pathname;
            if (path === "/v/rooms") return response(accountRoomPage(ROOM_ID, privateRoom ? "private-room" : "shared-room", privateRoom));
            if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
            if (path === `/v/rooms/${ROOM_ID}`) return response(roomDetails());
            if (path === `/v/agents/${AGENT_ID}/tokens` && init.method === "POST") {
              mintCalls += 1;
              return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"x".repeat(43)}` }, 201);
            }
            throw new Error(`unexpected ${init.method || "GET"} ${path}`);
          },
        });

        const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "test exact seat", profile: privateRoom ? "private" : "shared", roomId: ROOM_ID, agentId: AGENT_ID });
        assert.equal(result.status, "credentials_saved");
        assert.equal(mintCalls, 1);
      } finally { f.cleanup(); }
    });
  }
});

test("login can bootstrap a missing selected profile while other account operations fail closed", async () => {
  const f = loginFixture();
  const state = join(f.home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "profiles"), `[other]\nroom_id = ${ROOM_ID}\nagent_token = parle_agt_other\n`, { mode: process.platform === "win32" ? 0o600 : 0o644 });
  writeFileSync(join(state, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  let calls = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: { ...f.env, PARLE_PROFILE: "work" },
      fetch: async (url) => {
        calls += 1;
        const path = new URL(url).pathname;
        if (path === "/v/rooms") return response(accountRoomPage());
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
        if (path === `/v/rooms/${ROOM_ID}`) return response(roomDetails());
        if (path === `/v/agents/${AGENT_ID}/tokens`) return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"x".repeat(43)}` }, 201);
        throw new Error(`unexpected ${path}`);
      },
    });

    await assert.rejects(
      client.createRoom({ kind: "shared", confirmMutation: true, reason: "must retain strict profile selection" }),
      /Profile.*work|work.*profile/i,
    );
    assert.equal(calls, 0);

    const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "bootstrap work profile", profile: "work", roomId: ROOM_ID, agentId: AGENT_ID });
    assert.equal(result.profile, "work");
    assert.match(readFileSync(join(state, "profiles"), "utf8"), /^\[work\]$/m);
    if (process.platform !== "win32") assert.equal(lstatSync(join(state, "profiles")).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("login profile publication reports a known token without automatic cleanup or deleting another writer's lock", async () => {
  const f = loginFixture();
  const state = join(f.home, ".parle");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "session"), "__Host-parle_session=parle_ses_shared-cookie\n", { mode: 0o600 });
  const lockPath = join(state, "profiles.lock");
  let deleteCalls = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init = {}) => {
        const path = new URL(url).pathname;
        const method = init.method || "GET";
        if (method === "DELETE") deleteCalls += 1;
        if (path === "/v/rooms") return response(accountRoomPage());
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
        if (path === `/v/rooms/${ROOM_ID}`) return response(roomDetails());
        if (path === `/v/agents/${AGENT_ID}/tokens` && method === "POST") {
          writeFileSync(lockPath, "other-writer\n", { mode: 0o600, flag: "wx" });
          return response({ agent_token_id: AGENT_TOKEN_ID, agent_id: AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"x".repeat(43)}` }, 201);
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    });

    const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "test", profile: "default", roomId: ROOM_ID, agentId: AGENT_ID });
    assert.equal(result.status, "credential_publication_failed");
    assert.equal(result.agent_token_id, AGENT_TOKEN_ID);
    assert.equal(result.credential_cleanup, "not_attempted");
    assert.equal(deleteCalls, 0);
    assert.match(result.publication_error, /Parle profile catalog is locked by another writer: .*profiles\.lock\./);
    assert.equal(JSON.stringify(result).includes("parle_agt_"), false);
    assert.equal(readFileSync(lockPath, "utf8"), "other-writer\n");
    assert.equal(existsSync(join(f.home, ".parle", "profiles")), false);
  } finally { f.cleanup(); }
});

test("login treats token-mint transport loss as outcome unknown and never retries", async () => {
  const f = fixture();
  let mintCalls = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init = {}) => {
        const path = new URL(url).pathname;
        if (path === "/v/rooms") return response(accountRoomPage());
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "agent-one" }] });
        if (path === `/v/rooms/${ROOM_ID}`) return response(roomDetails());
        if (path === `/v/agents/${AGENT_ID}/tokens` && init.method === "POST") {
          mintCalls += 1;
          throw new TypeError("connection reset after request dispatch");
        }
        throw new Error(`unexpected ${init.method || "GET"} ${path}`);
      },
    });
    const result = await client.login({ action: "mint-from-session", confirmMutation: true, reason: "test unknown mint", profile: "new-profile", roomId: ROOM_ID, agentId: AGENT_ID });
    assert.equal(result.status, "outcome_unknown");
    assert.match(result.next, /Do not retry/);
    assert.equal(JSON.stringify(result).includes("human-cookie"), false);
    assert.equal(mintCalls, 1);
  } finally { f.cleanup(); }
});

test("shared account client creates rooms and admits own agents through fixed human-session endpoints", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method, body: JSON.parse(init.body), cookie: init.headers.Cookie });
        if (path === "/v/rooms") return response({ room_id: ROOM_ID, room_handle: "shared-room", kind: "shared", seat_id: SEAT_ID }, 201);
        if (path === `/v/rooms/${ROOM_ID}/seats`) return response({ seat_id: SEAT_ID, agent_id: AGENT_ID, admitted_at: "2026-08-03T12:00:00Z" }, 201);
        throw new Error(`unexpected ${path}`);
      },
    });
    const room = await client.createRoom({ kind: "shared", roomHandle: "Shared-Room", confirmMutation: true, reason: "create" });
    const seat = await client.addOwnAgentSeat({ roomId: ROOM_ID, agentId: AGENT_ID, confirmMutation: true, reason: "admit" });
    assert.equal(room.room_handle, "shared-room");
    assert.equal(seat.agent_id, AGENT_ID);
    assert.deepEqual(calls, [
      { path: "/v/rooms", method: "POST", body: { kind: "shared", room_handle: "shared-room" }, cookie: "__Host-parle_session=human-cookie" },
      { path: `/v/rooms/${ROOM_ID}/seats`, method: "POST", body: { agent_id: AGENT_ID }, cookie: "__Host-parle_session=human-cookie" },
    ]);
  } finally { f.cleanup(); }
});

test("shared account client lists room participants and ends one own session through fixed human-session endpoints", async () => {
  const f = fixture();
  const calls = [];
  try {
    const roster = {
      participants: [{
        participant_id: PARTICIPANT_ID,
        room_id: ROOM_ID,
        principal_id: PRINCIPAL_ID,
        agent_session_id: AGENT_SESSION_ID,
        agent_id: AGENT_ID,
        session_handle: "abcdefghijklmno2",
        last_seen_at: "2026-08-17T10:00:00Z",
        expires_at: "2026-08-18T10:00:00Z",
      }],
    };
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method, body: init.body, cookie: init.headers.Cookie });
        if (path === `/v/rooms/${ROOM_ID}/participants`) return response(roster);
        if (path === `/v/agent/sessions/${AGENT_SESSION_ID}/end`) return new Response(null, { status: 204 });
        throw new Error(`unexpected ${path}`);
      },
    });
    assert.deepEqual(await client.roomParticipants({ roomId: ROOM_ID.toUpperCase() }), roster);
    assert.deepEqual(await client.endOwnSession({ agentSessionId: AGENT_SESSION_ID.toUpperCase(), confirmMutation: true, reason: "reclaim stale capacity" }), {
      agent_session_id: AGENT_SESSION_ID,
      http_status: 204,
    });
    assert.deepEqual(calls, [
      { path: `/v/rooms/${ROOM_ID}/participants`, method: "GET", body: undefined, cookie: "__Host-parle_session=human-cookie" },
      { path: `/v/agent/sessions/${AGENT_SESSION_ID}/end`, method: "POST", body: undefined, cookie: "__Host-parle_session=human-cookie" },
    ]);
  } finally { f.cleanup(); }
});

test("room capacity recovery is preview-first, protects the invoker, and skips an advanced heartbeat", async () => {
  const f = fixture();
  const invoker = { state: "present", agentSessionId: AGENT_SESSION_ID };
  let rosterReads = 0;
  let ended = 0;
  try {
    const participant = (sessionId, lastSeenAt) => ({
      participant_id: sessionId === AGENT_SESSION_ID ? PARTICIPANT_ID : "019f7c00-0000-7000-8000-000000000010",
      room_id: ROOM_ID,
      principal_id: PRINCIPAL_ID,
      agent_session_id: sessionId,
      agent_id: AGENT_ID,
      session_handle: sessionId === AGENT_SESSION_ID ? "abcdefghijklmno2" : "abcdefghijklmno3",
      last_seen_at: lastSeenAt,
      expires_at: "2026-08-19T10:00:00Z",
    });
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      now: () => new Date("2026-08-18T01:00:00Z"),
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "testagent1", display_name: "Test Agent 1" }] });
        if (path === `/v/rooms/${ROOM_ID}/participants`) {
          rosterReads += 1;
          const candidateSeen = rosterReads <= 2 ? "2026-08-18T00:30:00Z" : "2026-08-18T00:40:00Z";
          return response({ participants: [participant(AGENT_SESSION_ID, "2026-08-18T00:59:00Z"), participant(ADDITIONAL_AGENT_SESSION_ID, candidateSeen)] });
        }
        if (path === `/v/agent/sessions/${ADDITIONAL_AGENT_SESSION_ID}/end`) { ended += 1; return new Response(null, { status: 204 }); }
        throw new Error(`unexpected ${path}`);
      },
    });

    const empty = await client.roomCapacityRecovery({ action: "preview", roomId: ROOM_ID }, invoker);
    assert.equal(empty.selectionMode, "none");
    assert.equal(empty.selected.length, 0);
    assert.equal(empty.completionEnabled, false);
    assert.match(empty.guidance, /not workload idleness/);

    const preview = await client.roomCapacityRecovery({ action: "preview", roomId: ROOM_ID, lastSeenBefore: "2026-08-18T00:45:00Z" }, invoker);
    assert.equal(preview.completionEnabled, true);
    assert.deepEqual(preview.selected.map((row) => row.agentSessionId), [ADDITIONAL_AGENT_SESSION_ID]);
    assert.equal(preview.exclusions.find((row) => row.agentSessionId === AGENT_SESSION_ID).reason, "current_invoker");

    const complete = await client.roomCapacityRecovery({ action: "complete", roomId: ROOM_ID, previewId: preview.previewId, confirmMutation: true, reason: "recover capacity" }, invoker);
    assert.deepEqual(complete.results, [{ agentSessionId: ADDITIONAL_AGENT_SESSION_ID, outcome: "skipped", reason: "heartbeat_advanced", previewedLastSeenAt: "2026-08-18T00:30:00Z", currentLastSeenAt: "2026-08-18T00:40:00Z" }]);
    assert.equal(ended, 0);
    await assert.rejects(client.roomCapacityRecovery({ action: "complete", roomId: ROOM_ID, previewId: preview.previewId, confirmMutation: true, reason: "retry" }, invoker), /missing or expired/);
    assert.deepEqual(recoveryInvokerState({ runtime: { bootstrapState: "unstarted", agentSessionId: "" } }), { state: "authoritatively_absent" });
    assert.deepEqual(recoveryInvokerState({ runtime: { bootstrapState: "starting", agentSessionId: "" } }), { state: "unknown", reason: "runtime_session_identity_missing" });
  } finally { f.cleanup(); }
});

test("room capacity recovery ends serially and stops at the first unknown outcome", async () => {
  const f = fixture();
  const posts = [];
  try {
    const participant = (sessionId, suffix) => ({
      participant_id: `019f7c00-0000-7000-8000-0000000000${suffix}`,
      room_id: ROOM_ID,
      principal_id: PRINCIPAL_ID,
      agent_session_id: sessionId,
      agent_id: AGENT_ID,
      session_handle: `abcdefghijklm${suffix.padStart(3, "0")}`,
      last_seen_at: "2026-08-18T00:30:00Z",
      expires_at: "2026-08-19T10:00:00Z",
    });
    const roster = { participants: [participant(ADDITIONAL_AGENT_SESSION_ID, "12"), participant(THIRD_AGENT_SESSION_ID, "13")] };
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      now: () => new Date("2026-08-18T01:00:00Z"),
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/v/agents") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "testagent1", display_name: "Test Agent 1" }] });
        if (path === `/v/rooms/${ROOM_ID}/participants`) return response(roster);
        if (init.method === "POST") {
          posts.push(path);
          if (path.endsWith(`/${ADDITIONAL_AGENT_SESSION_ID}/end`)) return new Response(null, { status: 204 });
          throw new TypeError("connection reset after dispatch");
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    const absent = { state: "authoritatively_absent" };
    const preview = await client.roomCapacityRecovery({ action: "preview", roomId: ROOM_ID, agentSessionIds: [ADDITIONAL_AGENT_SESSION_ID, THIRD_AGENT_SESSION_ID] }, absent);
    const complete = await client.roomCapacityRecovery({ action: "complete", roomId: ROOM_ID, previewId: preview.previewId, confirmMutation: true, reason: "recover capacity" }, absent);
    assert.deepEqual(complete.results, [
      { agentSessionId: ADDITIONAL_AGENT_SESSION_ID, outcome: "ended" },
      { agentSessionId: THIRD_AGENT_SESSION_ID, outcome: "unknown" },
    ]);
    assert.equal(complete.stopped, true);
    assert.deepEqual(posts, [
      `/v/agent/sessions/${ADDITIONAL_AGENT_SESSION_ID}/end`,
      `/v/agent/sessions/${THIRD_AGENT_SESSION_ID}/end`,
    ]);
  } finally { f.cleanup(); }
});

test("session recovery controls fail closed and preserve ambiguous end outcomes", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { calls += 1; throw new TypeError("connection reset after dispatch"); } });
    await assert.rejects(client.roomParticipants({ roomId: "not-a-uuid" }), /roomId must be a non-zero UUID/);
    await assert.rejects(client.endOwnSession({ agentSessionId: AGENT_SESSION_ID, reason: "missing confirmation" }), /confirmMutation=true/);
    await assert.rejects(client.endOwnSession({ agentSessionId: "not-a-uuid", confirmMutation: true, reason: "invalid id" }), /agentSessionId must be a non-zero UUID/);
    assert.equal(calls, 0);

    const unknown = await client.endOwnSession({ agentSessionId: AGENT_SESSION_ID, confirmMutation: true, reason: "reclaim" });
    assert.deepEqual(unknown, {
      agent_session_id: AGENT_SESSION_ID,
      outcome: "unknown",
      retry_attempted: false,
      next: "Session end outcome is unknown. Do not retry blindly; call parle_room_participants again and inspect the roster before taking another action.",
    });
    assert.equal(calls, 1);

    const malformedRoster = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ participants: [{ room_id: ROOM_ID }] }) });
    await assert.rejects(
      malformedRoster.roomParticipants({ roomId: ROOM_ID }),
      (error) => error instanceof ParleAccountResponseContractError && error.status === 200,
    );

    const denied = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ error: { code: "not_found", message: "not found", action: "stop", retryable: false, scope: "account" } }, 404) });
    await assert.rejects(
      denied.endOwnSession({ agentSessionId: AGENT_SESSION_ID, confirmMutation: true, reason: "not owned" }),
      (error) => error.status === 404 && error.code === "not_found" && error.action === "stop",
    );
  } finally { f.cleanup(); }
});

test("shared account client creates and deletes own durable agents through fixed human-session endpoints", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), cookie: init.headers.Cookie });
        if (path === "/v/agents") return response({ agent_id: AGENT_ID, agent_handle: "testagent1", display_name: "Test Agent 1" }, 201);
        if (path === `/v/agents/${AGENT_ID}`) return new Response(null, { status: 204 });
        throw new Error(`unexpected ${path}`);
      },
    });
    const created = await client.createOwnAgent({ agentHandle: " TestAgent1 ", displayName: " Test Agent 1 ", confirmMutation: true, reason: "smoke test" });
    const deleted = await client.deleteOwnAgent({ agentId: AGENT_ID.toUpperCase(), confirmMutation: true, reason: "smoke cleanup" });
    assert.deepEqual(created, { agent_id: AGENT_ID, agent_handle: "testagent1", display_name: "Test Agent 1" });
    assert.deepEqual(deleted, { agent_id: AGENT_ID, http_status: 204 });
    assert.deepEqual(calls, [
      { path: "/v/agents", method: "POST", body: { agent_handle: "testagent1", display_name: "Test Agent 1" }, cookie: "__Host-parle_session=human-cookie" },
      { path: `/v/agents/${AGENT_ID}`, method: "DELETE", body: undefined, cookie: "__Host-parle_session=human-cookie" },
    ]);
  } finally { f.cleanup(); }
});

test("own-agent lifecycle fails closed and reports delete transport uncertainty without retry", async () => {
  const f = fixture();
  let calls = 0;
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url) => {
        calls += 1;
        const path = new URL(url).pathname;
        if (path === `/v/agents/${AGENT_ID}` && calls === 1) throw new TypeError("connection reset after dispatch");
        return response({ error: { code: "not_found", message: "not found", action: "stop", retryable: false, scope: "account" } }, 404);
      },
    });
    await assert.rejects(client.createOwnAgent({ agentHandle: "testagent1", reason: "missing confirmation" }), /confirmMutation=true/);
    await assert.rejects(client.createOwnAgent({ agentHandle: "bad_handle", confirmMutation: true, reason: "invalid handle" }), /agentHandle must normalize/);
    await assert.rejects(client.createOwnAgent({ agentHandle: "testagent1", displayName: " ", confirmMutation: true, reason: "invalid display" }), /displayName must not be empty/);
    await assert.rejects(client.deleteOwnAgent({ agentId: "not-a-uuid", confirmMutation: true, reason: "invalid id" }), /agentId must be a non-zero UUID/);
    assert.equal(calls, 0);

    const malformedClient = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ agent_id: AGENT_ID }, 201) });
    await assert.rejects(
      malformedClient.createOwnAgent({ agentHandle: "testagent1", confirmMutation: true, reason: "reject malformed success" }),
      /expected agent_id, agent_handle, and display_name/,
    );
    const emptyJsonClient = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => new Response(null, { status: 204 }) });
    await assert.rejects(
      emptyJsonClient.createOwnAgent({ agentHandle: "testagent1", confirmMutation: true, reason: "reject empty JSON success" }),
      (error) => error instanceof ParleAccountResponseContractError
        && error.status === 204
        && error.adapterCode === "parle_account_response_contract_mismatch"
        && error.code === undefined,
    );

    const unknown = await client.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "delete" });
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.retry_attempted, false);
    assert.match(unknown.next, /Do not retry blindly/);
    assert.equal(calls, 1);

    let abortCalls = 0;
    const abortedClient = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => {
        abortCalls += 1;
        throw new DOMException("aborted before response", "AbortError");
      },
    });
    const aborted = await abortedClient.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "pre-response abort" });
    assert.equal(aborted.outcome, "unknown");
    assert.equal(aborted.retry_attempted, false);
    assert.equal(abortCalls, 1);

    for (const definiteResponse of [
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      { ok: true, status: 204, statusText: "No Content", arrayBuffer: async () => Buffer.from("{}") },
    ]) {
      const protocolClient = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => definiteResponse });
      await assert.rejects(
        protocolClient.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "reject malformed delete success" }),
        (error) => error instanceof ParleAccountResponseContractError
          && error.status === definiteResponse.status
          && error.adapterCode === "parle_account_response_contract_mismatch"
          && error.code === undefined,
      );
    }

    await assert.rejects(
      client.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "delete missing" }),
      (error) => error.status === 404 && error.code === "not_found" && error.action === "stop",
    );
    assert.equal(calls, 2);
  } finally { f.cleanup(); }
});

test("account response failures stay definite after fetch resolves and preserve array compatibility", async () => {
  const f = fixture();
  try {
    for (const body of [null, "text", 1, true]) {
      const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response(body, 200) });
      await assert.rejects(
        client.createOwnAgent({ agentHandle: "testagent1", confirmMutation: true, reason: "reject primitive" }),
        (error) => error instanceof ParleAccountResponseContractError && error.status === 200 && error.code === undefined,
      );
    }

    const invalidJsonClient = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => new Response("{", { status: 200 }) });
    await assert.rejects(
      invalidJsonClient.createOwnAgent({ agentHandle: "testagent1", confirmMutation: true, reason: "reject invalid JSON" }),
      (error) => error instanceof ParleAccountResponseContractError && error.status === 200 && error.code === undefined,
    );

    const arrayClient = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response([], 200) });
    await assert.rejects(
      arrayClient.createOwnAgent({ agentHandle: "testagent1", confirmMutation: true, reason: "array reaches endpoint validation" }),
      (error) => !(error instanceof ParleAccountResponseContractError) && /created agent_id must be a non-zero UUID/.test(error.message),
    );

    let mutableStatus = 204;
    const capturedStatusClient = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => ({
        get status() { return mutableStatus; },
        get ok() { return mutableStatus < 400; },
        get statusText() { return "fixture"; },
        async arrayBuffer() {
          mutableStatus = 599;
          throw new DOMException("aborted while reading response", "AbortError");
        },
      }),
    });
    await assert.rejects(
      capturedStatusClient.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "capture response status" }),
      (error) => error instanceof ParleAccountResponseContractError && error.status === 204 && error.code === undefined,
    );

    for (const status of [204, 503]) {
      let calls = 0;
      const client = new ParleAccountClient({
        cwd: f.cwd,
        env: f.env,
        fetch: async () => {
          calls += 1;
          return { status, ok: status < 400, statusText: "fixture", arrayBuffer: async () => { throw new Error("body read failed"); } };
        },
      });
      await assert.rejects(
        client.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "body read failure" }),
        (error) => error instanceof ParleAccountResponseContractError && error.status === status && error.code === undefined,
      );
      assert.equal(calls, 1);
    }

    for (const status of [200, 204]) {
      let calls = 0;
      const client = new ParleAccountClient({
        cwd: f.cwd,
        env: f.env,
        fetch: async () => {
          calls += 1;
          return { status, ok: true, statusText: "fixture", arrayBuffer: async () => Buffer.alloc(65_537) };
        },
      });
      await assert.rejects(
        client.deleteOwnAgent({ agentId: AGENT_ID, confirmMutation: true, reason: "oversized response" }),
        (error) => error instanceof ParleAccountResponseContractError && error.status === status && error.code === undefined,
      );
      assert.equal(calls, 1);
    }
  } finally { f.cleanup(); }
});

test("principal invite mint supports target-proof handle and privacy-flat email targets", async () => {
  const f = fixture();
  const calls = [];
  try {
    const responses = [
      response({
        invite_id: INVITE_ID,
        invitation_url: `https://app.parle.sh/room-invitations/${INVITE_ID}`,
        target_kind: "principal",
        target_principal_id: PRINCIPAL_ID,
        target_agent_id: null,
        target_display: { handle: "kljensen" },
        agent_admission: null,
        offered_rights: [],
        expires_at: "2026-07-26T20:00:00Z",
        replayed: false,
      }, 201),
      response({ status: "accepted" }, 202),
    ];
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        return responses.shift();
      },
    });
    const handle = await client.mintPrincipalInvite({ roomId: ROOM_ID, target: "@KLJENSEN", confirmMutation: true, reason: "Invite Kyle" });
    assert.equal(handle.targetPrincipalId, PRINCIPAL_ID);
    assert.equal(handle.targetHandle, "kljensen");
    assert.equal(handle.invitationUrl, `https://app.parle.sh/room-invitations/${INVITE_ID}`);
    assert.equal(handle.sensitive, false);
    assert.equal(JSON.stringify(handle).includes("secret"), false);
    assert.equal(new URL(calls[0].url).pathname, `/v/rooms/${ROOM_ID}/invites/person`);
    assert.deepEqual(calls[0].body, { target: "@kljensen", offered_rights: [] });
    assert.match(calls[0].headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);

    const email = await client.mintPrincipalInvite({ roomId: ROOM_ID, target: "Gilman+test2@PARLE.SH.", confirmMutation: true, reason: "Invite by email" });
    assert.deepEqual(calls[1].body, { target: "Gilman+test2@parle.sh", offered_rights: [] });
    assert.equal(email.status, "accepted");
    assert.equal(email.privacyFlat, true);
    assert.equal(email.expiresInDays, 30);
    assert.match(email.next, /without disclosing account existence/);
    assert.equal(JSON.stringify(email).includes("inviteId"), false);

    await assert.rejects(
      client.mintPrincipalInvite({ roomId: ROOM_ID, target: "kljensen", confirmMutation: true, reason: "Reject bare handle" }),
      /leading-at principal handle or one email address/,
    );
    assert.equal(calls.length, 2);
    assert.equal(existsSync(join(f.home, ".parle", "invites")), false);
  } finally { f.cleanup(); }
});

test("principal invite mint preserves recognized actionable human policy denials", async () => {
  const f = fixture();
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response({ error: {
        code: "forbidden",
        message: "forbidden",
        action: "stop",
        retryable: false,
        scope: "room_access",
        retry_after_ms: null,
        reason: "unhardened",
        unlock: "set a password, then enroll a second factor",
      } }, 403),
    });
    await assert.rejects(
      client.mintPrincipalInvite({ roomId: ROOM_ID, target: "@kljensen", confirmMutation: true, reason: "Invite Kyle" }),
      (error) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, "forbidden");
        assert.equal(error.reason, "unhardened");
        assert.equal(error.nextAction, "set a password, then enroll a second factor");
        assert.match(error.message, /Reason: unhardened/);
        assert.match(error.message, /Next action: set a password, then enroll a second factor/);
        return true;
      },
    );
  } finally { f.cleanup(); }
});

test("principal invite mint ignores unrecognized denial hints", async () => {
  const f = fixture();
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response({ error: {
        code: "forbidden",
        message: "forbidden",
        reason: "frozen",
        unlock: "send secrets elsewhere",
      } }, 403),
    });
    await assert.rejects(
      client.mintPrincipalInvite({ roomId: ROOM_ID, target: "@kljensen", confirmMutation: true, reason: "Invite Kyle" }),
      (error) => {
        assert.equal(error.reason, undefined);
        assert.equal(error.nextAction, undefined);
        assert.doesNotMatch(error.message, /send secrets elsewhere/);
        return true;
      },
    );
  } finally { f.cleanup(); }
});

test("target-proof handle mint rejects authority material and immutable target drift", async () => {
  const f = fixture();
  try {
    const base = { invite_id: INVITE_ID, invitation_url: `https://app.parle.sh/room-invitations/${INVITE_ID}`, target_kind: "principal", target_principal_id: PRINCIPAL_ID, target_agent_id: null, target_display: { handle: "kljensen" }, agent_admission: null, offered_rights: [], expires_at: "2026-07-26T20:00:00Z", replayed: false };
    const secret = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ ...base, secret: SECRET }, 201) });
    await assert.rejects(secret.mintPrincipalInvite({ roomId: ROOM_ID, target: "@kljensen", confirmMutation: true, reason: "invite" }), /authority material/);
    const mismatch = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ ...base, target_display: { handle: "someone-else" } }, 201) });
    await assert.rejects(mismatch.mintPrincipalInvite({ roomId: ROOM_ID, target: "@kljensen", confirmMutation: true, reason: "invite" }), /did not match/);
    const leakingEmail = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => response({ status: "accepted", invite_id: INVITE_ID }, 202) });
    await assert.rejects(leakingEmail.mintPrincipalInvite({ roomId: ROOM_ID, target: "test@example.test", confirmMutation: true, reason: "invite" }), /privacy-flat accepted outcome/);
  } finally { f.cleanup(); }
});

test("claimPrincipalInvite is terminally retired and never touches handoff or network", async () => {
  const f = fixture();
  let called = false;
  try {
    const inviteDir = join(f.home, ".parle", "invites");
    mkdirSync(inviteDir, { mode: 0o700 });
    const handoffPath = join(inviteDir, `${INVITE_ID}.json`);
    writeFileSync(handoffPath, JSON.stringify({ schemaVersion: 1, kind: "parle-principal-invite", inviteId: INVITE_ID, roomId: ROOM_ID, secret: SECRET, code: CODE }), { mode: 0o600 });
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { called = true; return response({}); } });
    for (const action of ["preview", "complete"]) {
      await assert.rejects(client.claimPrincipalInvite({ action, handoffPath, confirmMutation: true, reason: "retired" }), (error) => {
        assert.match(error.message, /retired/);
        assert.match(error.message, /parle_accept_room_invitation/);
        assert.equal(error.message.includes(SECRET), false);
        assert.equal(error.message.includes(CODE), false);
        return true;
      });
    }
    assert.equal(called, false);
    assert.equal(existsSync(handoffPath), true);
  } finally {
    f.cleanup();
  }
});

test("target-session invitation preview and acceptance extract the canonical locator but use configured API transport", async () => {
  const f = fixture();
  const calls = [];
  try {
    const status = { invite_id: INVITE_ID, state: "pending", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, inviter_handle: "gilman", seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: null, principal_seat_active: false };
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      calls.push({ url: String(url), method: init.method || "GET" });
      if (String(url).endsWith("/accept")) return response({ room_id: ROOM_ID, seat_id: SEAT_ID, participant_id: PARTICIPANT_ID, state: "seated" }, 201);
      return response(status);
    } });
    const preview = await client.acceptRoomInvitation({ action: "preview", invitation: `https://app.parle.sh/room-invitations/${INVITE_ID}` });
    assert.equal(preview.state, "pending");
    const accepted = await client.acceptRoomInvitation({ action: "accept", invitation: INVITE_ID, confirmMutation: true, reason: "accept" });
    assert.equal(accepted.principal, "accepted");
    assert.equal(accepted.agent, "needs_selection");
    assert.match(accepted.next, /createAgentHandle/);
    assert.match(accepted.next, /additional durable agent/);
    assert.deepEqual(calls.map((call) => call.url), [
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}`,
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}`,
      `http://127.0.0.1:8787/v/room-invitations/${INVITE_ID}/accept`,
    ]);
    for (const retired of [
      `https://app.parle.sh/join/${INVITE_ID}`,
      `https://api.parle.sh/v/room-invitations/${INVITE_ID}`,
      `https://app.parle.sh/room-invitations/${INVITE_ID}/accept`,
      `https://app.parle.sh/room-invitations/${INVITE_ID}/`,
      `https://app.parle.sh/room-invitations/${INVITE_ID}?x=1`,
      `https://app.parle.sh/room-invitations/${INVITE_ID}#x`,
      `https://user@app.parle.sh/room-invitations/${INVITE_ID}`,
      `http://app.parle.sh/room-invitations/${INVITE_ID}`,
    ]) {
      await assert.rejects(client.acceptRoomInvitation({ action: "preview", invitation: retired }), /Invitation URL/);
    }
    const foreignOrigin = await client.acceptRoomInvitation({ action: "preview", invitation: `https://example.test/room-invitations/${INVITE_ID}` });
    assert.equal(foreignOrigin.state, "pending");
  } finally { f.cleanup(); }
});

test("connect workflow previews immutable selection and publishes a credential without returning it", async () => {
  const f = fixture();
  const catalogPath = join(f.home, ".parle", "profiles");
  if (process.platform !== "win32") chmodSync(catalogPath, 0o644);
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
    assert.match(preview.next, /createAgentHandle/);
    assert.match(preview.next, /new durable agent/);
    const complete = await client.connectOwnAgent({ action: "complete", confirmMutation: true, reason: "test", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" });
    assert.equal(complete.profile, "galexc-kyleops");
    assert.equal(complete.credential, "profile_ready");
    assert.equal(JSON.stringify(complete).includes("parle_agt_"), false);
    const catalog = readFileSync(catalogPath, "utf8");
    assert.match(catalog, /\[galexc-kyleops\]/);
    assert.match(catalog, /agent_token_id = 019f7c00-0000-7000-8000-000000000005/);
    if (process.platform !== "win32") assert.equal(lstatSync(catalogPath).mode & 0o777, 0o600);
    assert.equal(paths.includes(`POST /v/rooms/${ROOM_ID}/seats`), true);
  } finally { f.cleanup(); }
});

test("connect can deliberately create and connect an additional durable agent", async () => {
  const f = fixture();
  const profilesPath = join(f.home, ".parle", "profiles");
  const existing = readFileSync(profilesPath, "utf8");
  writeFileSync(profilesPath, `${existing}\n[galexc-kyleops]\nroom_id = ${ROOM_ID}\nagent_token = parle_agt_mortyfixture123456\nagent_token_id = ${AGENT_TOKEN_ID}\n`, { mode: 0o600 });
  const calls = [];
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (path === `/v/room-invitations/${INVITE_ID}`) return response({ invite_id: INVITE_ID, state: "accepted", room_id: ROOM_ID, room_handle: "galexc-kyleops", inviter_principal_id: PRINCIPAL_ID, seat_type: "principal", offered_rights: [], history_visible: true, expires_at: "2026-07-26T20:00:00Z", accepted_at: "2026-07-19T20:00:00Z", principal_seat_active: true });
      if (path === "/v/agents" && method === "GET") return response({ agents: [{ agent_id: AGENT_ID, agent_handle: "morty", display_name: "Morty" }] });
      if (path === "/v/agents" && method === "POST") return response({ agent_id: ADDITIONAL_AGENT_ID, agent_handle: "rick", display_name: "rick" }, 201);
      if (path === `/v/rooms/${ROOM_ID}`) return response({ roster: { agent_seats: [{ seat_id: "019f7c00-0000-7000-8000-000000000099", agent_id: AGENT_ID }] } });
      if (path === `/v/rooms/${ROOM_ID}/seats`) return response({ seat_id: SEAT_ID, agent_id: ADDITIONAL_AGENT_ID }, 201);
      if (path === `/v/agents/${ADDITIONAL_AGENT_ID}/tokens` && method === "GET") return response({ tokens: [] });
      if (path === `/v/agents/${ADDITIONAL_AGENT_ID}/tokens` && method === "POST") return response({ agent_token_id: ADDITIONAL_AGENT_TOKEN_ID, agent_id: ADDITIONAL_AGENT_ID, room_id: ROOM_ID, token: `parle_agt_${"r".repeat(43)}` }, 201);
      throw new Error(`unexpected ${method} ${path}`);
    } });
    const preview = await client.connectOwnAgent({ action: "preview", invitation: INVITE_ID, createAgentHandle: "rick" });
    assert.equal(preview.proposedCreateHandle, "rick");
    assert.equal(preview.selectedAgent, undefined);
    assert.equal(preview.agents[0].agentHandle, "morty");
    assert.match(preview.next, /additional-agent handle/);

    const complete = await client.connectOwnAgent({ action: "complete", confirmMutation: true, reason: "test", invitation: INVITE_ID, createAgentHandle: "rick", confirmMutation: true, reason: "Add a second durable agent" });
    assert.equal(complete.agent, "created");
    assert.equal(complete.selectedAgent.agentId, ADDITIONAL_AGENT_ID);
    assert.equal(complete.profile, "galexc-kyleops-rick");
    assert.match(complete.next, /add another durable agent/i);
    assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/v/agents")?.body, { agent_handle: "rick" });
    assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === `/v/rooms/${ROOM_ID}/seats`)?.body, { agent_id: ADDITIONAL_AGENT_ID });
    const catalog = readFileSync(profilesPath, "utf8");
    assert.match(catalog, /\[galexc-kyleops-rick\]/);
    assert.equal(catalog.includes("parle_agt_mortyfixture123456"), true);
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
    const result = await client.connectOwnAgent({ action: "complete", confirmMutation: true, reason: "test", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" });
    assert.equal(result.credential, "outcome_unknown");
    assert.equal(result.recoveryAgentId, AGENT_ID);
    assert.match(result.next, /Do not retry/);
    assert.match(result.next, /#451/);
    assert.equal(mintCalls, 1);
    assert.equal(readFileSync(join(f.home, ".parle", "profiles"), "utf8").includes("galexc-kyleops"), false);
  } finally { f.cleanup(); }
});

test("connect reports a known minted token without automatic cleanup when atomic profile publication fails", async () => {
  const f = fixture();
  const catalog = join(f.home, ".parle", "profiles");
  let deleteCalls = 0;
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
      if (method === "DELETE") deleteCalls += 1;
      throw new Error(`unexpected ${method} ${path}`);
    } });
    const result = await client.connectOwnAgent({ action: "complete", confirmMutation: true, reason: "test", invitation: INVITE_ID, agentId: AGENT_ID, confirmMutation: true, reason: "connect" });
    assert.equal(result.credential, "publication_failed");
    assert.equal(result.agent_token_id, AGENT_TOKEN_ID);
    assert.equal(result.credential_cleanup, "not_attempted");
    assert.match(result.publication_error, /profile catalog changed after preflight/);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(deleteCalls, 0);
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
    await assert.rejects(client.connectOwnAgent({ action: "complete", confirmMutation: true, reason: "test", invitation: INVITE_ID, agentId: AGENT_ID, profileLabel: "default", confirmMutation: true, reason: "connect" }), /already exists with an unproven binding/);
    assert.equal(minted, false);
    assert.equal(readFileSync(catalog, "utf8"), original);
  } finally { f.cleanup(); }
});

test("owned alias delivery and release use guarded exact human-session operations", async () => {
  const f = fixture();
  const calls = [];
  try {
    const client = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        calls.push({ path, method: init.method, body: init.body && JSON.parse(init.body), idempotencyKey: init.headers["Idempotency-Key"] });
        if (path.endsWith("/release/preview")) return response({ alias: "durable", alias_generation: 3, terminal: true, effects: {} });
        if (path.endsWith("/release/complete")) return response({ alias: "durable", released_alias_generation: 3, released: true });
        if (path.includes(`/v/rooms/${ROOM_ID}/`)) return response({ alias: "durable", alias_generation: 3, room_id: ROOM_ID, offline_delivery: true, room_offline_delivery: true, effective_offline_delivery: true, ...(init.method === "PUT" ? { changed: true } : {}) });
        return response({ alias: "durable", alias_generation: 3, offline_delivery: true, ...(init.method !== "GET" ? { changed: true } : {}) });
      },
    });
    await client.ownedAliasDelivery({ action: "get_global", agentId: AGENT_ID, alias: "durable" });
    await assert.rejects(client.ownedAliasDelivery({ action: "set_global", agentId: AGENT_ID, alias: "durable", offlineDelivery: false }), /confirmMutation=true/);
    await client.ownedAliasDelivery({ action: "set_room", agentId: AGENT_ID, alias: "durable", roomId: ROOM_ID, offlineDelivery: true, confirmMutation: true, reason: "restore room" });
    const preview = await client.ownedAliasRelease({ action: "preview", agentId: AGENT_ID, alias: "durable" });
    assert.match(preview.idempotencyKey, /^[0-9a-f-]{36}$/);
    await assert.rejects(client.ownedAliasRelease({ action: "complete", agentId: AGENT_ID, alias: "durable", expectedAliasGeneration: 3, confirmMutation: true, reason: "release" }), /idempotencyKey returned by preview/);
    await client.ownedAliasRelease({ action: "complete", agentId: AGENT_ID, alias: "durable", expectedAliasGeneration: 3, idempotencyKey: preview.idempotencyKey, confirmMutation: true, reason: "release" });
    assert.deepEqual(calls.map((call) => [call.method, call.path]), [
      ["GET", `/v/agents/${AGENT_ID}/session-aliases/durable/offline-delivery`],
      ["PUT", `/v/rooms/${ROOM_ID}/agents/${AGENT_ID}/session-aliases/durable/offline-delivery`],
      ["POST", `/v/agents/${AGENT_ID}/session-aliases/durable/release/preview`],
      ["POST", `/v/agents/${AGENT_ID}/session-aliases/durable/release/complete`],
    ]);
    assert.equal(calls.at(-1).idempotencyKey, preview.idempotencyKey);
    assert.deepEqual(calls.at(-1).body, { expected_alias_generation: 3 });
  } finally { f.cleanup(); }
});

test("owned alias controls reject reserved and anonymous-shape aliases locally", async () => {
  const f = fixture();
  try {
    const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: async () => { throw new Error("fetch must not run"); } });
    for (const alias of ["system", "abcdefghijklmno2"]) {
      await assert.rejects(client.ownedAliasDelivery({ action: "get_global", agentId: AGENT_ID, alias }), /unreserved 2-32 character/);
      await assert.rejects(client.ownedAliasRelease({ action: "preview", agentId: AGENT_ID, alias }), /unreserved 2-32 character/);
    }
  } finally { f.cleanup(); }
});

test("owned alias release reports ambiguous complete outcomes as unknown and preserves definite refusals", async () => {
  const f = fixture();
  const complete = { action: "complete", agentId: AGENT_ID, alias: "durable", expectedAliasGeneration: 3, idempotencyKey: "release-key", confirmMutation: true, reason: "release" };
  try {
    for (const fetchImpl of [
      async () => { throw new TypeError("connection reset"); },
      async () => response({ error: { code: "request_timeout", retryable: false } }, 408),
      async () => response({ error: { code: "server_error", retryable: false } }, 503),
    ]) {
      const client = new ParleAccountClient({ cwd: f.cwd, env: f.env, fetch: fetchImpl });
      const result = await client.ownedAliasRelease(complete);
      assert.deepEqual(result, {
        outcome: "unknown",
        idempotencyKey: "release-key",
        replay: "Replay parle_owned_alias_release complete with the same agentId, alias, expectedAliasGeneration, and idempotencyKey. This reproduces the byte-identical core request. Do not infer current alias state.",
      });
    }

    const definite = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response({ error: { code: "idempotency_conflict", retryable: false } }, 409),
    });
    await assert.rejects(definite.ownedAliasRelease(complete), (error) => error.status === 409 && error.code === "idempotency_conflict");

    const rateLimited = new ParleAccountClient({
      cwd: f.cwd,
      env: f.env,
      fetch: async () => response({ error: { code: "rate_limited", retryable: true } }, 429),
    });
    await assert.rejects(rateLimited.ownedAliasRelease(complete), (error) => error.status === 429 && error.code === "rate_limited" && error.retryable === true);
  } finally { f.cleanup(); }
});
