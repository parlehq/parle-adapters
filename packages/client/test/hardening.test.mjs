import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParleHardeningClient } from "../dist/index.js";

const PASSWORD = "SENTINEL_PASSWORD_518";
const CURRENT = "SENTINEL_CURRENT_518";
const OTP = "123456";
const URI = "otpauth://totp/Parle:operator?secret=SENTINEL_URI_518&issuer=Parle";
const RECOVERY = ["SENTINEL_RECOVERY_518_A", "SENTINEL_RECOVERY_518_B"];

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "parle-hardening-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-hardening-cwd-"));
  const state = join(home, ".parle");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "profiles"), "[default]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_fixture\napi_base = http://127.0.0.1:8787\n", { mode: 0o600 });
  writeFileSync(join(state, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  return {
    home, cwd, state,
    env: { HOME: home, PARLE_PROFILE: "default", PARLE_ALLOW_INSECURE_LOCAL: "1" },
    cleanup() { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); },
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function noContent(status = 204) { return new Response(null, { status }); }

function hardeningFetch({ assurance = "unhardened", fail = {}, calls = [] } = {}) {
  let currentAssurance = assurance;
  return async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init.method, body, cookie: init.headers.Cookie });
    if (fail[path]) return fail[path];
    if (path === "/v/auth/whoami") return json({ authenticated: true, assurance: currentAssurance });
    if (path === "/v/auth/password") return noContent();
    if (path === "/v/auth/sudo") return json({ expires_at: new Date(Date.now() + 60_000).toISOString() });
    if (path === "/v/auth/totp/enroll") return json({ provisioning_uri: URI });
    if (path === "/v/auth/totp/confirm") { currentAssurance = "hardened"; return json({ recovery_codes: RECOVERY }); }
    if (path === "/v/auth/recovery-codes/regenerate") return json({ recovery_codes: RECOVERY });
    throw new Error(`unexpected ${path}`);
  };
}

function client(f, fetch) { return new ParleHardeningClient({ cwd: f.cwd, env: f.env, fetch }); }
function mut(action) { return { action, confirmMutation: true, reason: "authorized ceremony" }; }
function statePath(f) { return join(f.state, "hardening", "current", "state.json"); }
function secretPath(f, name) { return join(f.state, "hardening", "current", name); }

async function prepareToConfirm(f, c) {
  await c.hardenAccount({ action: "status" });
  await c.stagePassword("set", Buffer.from(PASSWORD));
  await c.hardenAccount(mut("prepare"));
  await c.hardenAccount(mut("enroll_totp"));
  await c.stageTotpCode(Buffer.from(OTP));
}

test("full hardening ceremony keeps every sentinel out of results and non-secret state", async () => {
  const f = fixture();
  const calls = [];
  try {
    const c = client(f, hardeningFetch({ calls }));
    const results = [];
    results.push(await c.hardenAccount({ action: "status" }));
    await c.stagePassword("set", Buffer.from(PASSWORD));
    results.push(await c.hardenAccount(mut("prepare")));
    results.push(await c.hardenAccount(mut("enroll_totp")));
    assert.equal(statSync(join(f.state, "hardening")).mode & 0o777, 0o700);
    assert.equal(statSync(join(f.state, "hardening", "current")).mode & 0o777, 0o700);
    assert.equal(statSync(secretPath(f, "provisioning-uri.txt")).mode & 0o777, 0o600);
    await c.stageTotpCode(Buffer.from(OTP));
    results.push(await c.hardenAccount(mut("confirm_totp")));
    assert.equal(statSync(secretPath(f, "recovery-codes.txt")).mode & 0o777, 0o600);
    await c.acknowledgeRecoveryStored();
    results.push(await c.hardenAccount(mut("finalize")));
    const observable = JSON.stringify({ results, state: readFileSync(statePath(f), "utf8") });
    for (const sentinel of [PASSWORD, CURRENT, OTP, "SENTINEL_URI_518", "SENTINEL_RECOVERY_518_A", "SENTINEL_RECOVERY_518_B", "human-cookie"]) assert.equal(observable.includes(sentinel), false, "secret sentinel leaked");
    assert.equal(existsSync(secretPath(f, "password.input")), false);
    assert.equal(existsSync(secretPath(f, "provisioning-uri.txt")), false);
    assert.equal(existsSync(secretPath(f, "recovery-codes.txt")), false);
    assert.equal(JSON.stringify(calls).includes(PASSWORD), true, "secret only reaches the fixed API request");
    assert.equal(results.at(-1).complete, true);
  } finally { f.cleanup(); }
});

test("protected custody rejects symlink roots, inputs, output occupancy, and changed sessions before unsafe use", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    const c = client(f, hardeningFetch());
    const outside = join(f.home, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(f.state, "hardening"));
    await assert.rejects(c.hardenAccount({ action: "status" }), /real directory/);
    rmSync(join(f.state, "hardening"), { recursive: true, force: true });
    await c.hardenAccount({ action: "status" });
    await c.stagePassword("set", Buffer.from(PASSWORD));
    await assert.rejects(c.stagePassword("set", Buffer.from("different-secret")), /not expected|occupied/);
    assert.equal(readFileSync(secretPath(f, "password.input")).equals(Buffer.from(PASSWORD)), true, "duplicate staging must retain the original protected input");
    chmodSync(secretPath(f, "password.input"), 0o644);
    await assert.rejects(c.hardenAccount(mut("prepare")), /mode 600/);
    chmodSync(secretPath(f, "password.input"), 0o600);
    writeFileSync(join(f.state, "session"), "__Host-parle_session=changed-cookie\n", { mode: 0o600 });
    const changed = await c.hardenAccount({ action: "status" });
    assert.equal(changed.state, "session_changed");
  } finally { f.cleanup(); }
});

test("exclusive provisioning sink refuses an occupied output without sending enrollment", async () => {
  const f = fixture();
  const calls = [];
  try {
    const c = client(f, hardeningFetch({ calls }));
    await c.hardenAccount({ action: "status" });
    await c.stagePassword("set", Buffer.from(PASSWORD));
    await c.hardenAccount(mut("prepare"));
    writeFileSync(secretPath(f, "provisioning-uri.txt"), "occupied", { mode: 0o600 });
    await assert.rejects(c.hardenAccount(mut("enroll_totp")), /occupied or unsafe/);
    assert.equal(calls.some((call) => call.path === "/v/auth/totp/enroll"), false);
  } finally { f.cleanup(); }
});

test("password and enrollment ambiguity never retry automatically and explicit resume is bounded", async () => {
  const f = fixture();
  const calls = [];
  let passwordAttempts = 0;
  let enrollAttempts = 0;
  try {
    const fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/v/auth/whoami") return json({ authenticated: true, assurance: "unhardened" });
      if (path === "/v/auth/password") { passwordAttempts += 1; return json({ error: { message: PASSWORD } }, 504); }
      if (path === "/v/auth/sudo") return json({ expires_at: new Date(Date.now() + 60_000).toISOString() });
      if (path === "/v/auth/totp/enroll") { enrollAttempts += 1; return enrollAttempts === 1 ? json({ error: { message: URI } }, 504) : json({ provisioning_uri: URI }); }
      throw new Error("unexpected");
    };
    const c = client(f, fetch);
    await c.hardenAccount({ action: "status" });
    await c.stagePassword("set", Buffer.from(PASSWORD));
    await assert.rejects(c.hardenAccount(mut("prepare")), /outcome is unknown/);
    assert.equal(passwordAttempts, 1);
    await c.hardenAccount(mut("prepare"));
    assert.equal(passwordAttempts, 1, "resume probes sudo rather than repeats password mutation");
    await assert.rejects(c.hardenAccount(mut("enroll_totp")), /outcome is unknown/);
    assert.equal(enrollAttempts, 1);
    const status = await c.hardenAccount({ action: "status" });
    assert.equal(status.state, "enroll_outcome_unknown");
    await c.hardenAccount(mut("enroll_totp"));
    assert.equal(enrollAttempts, 2, "only an explicit supersession sends another enroll");
    const observable = JSON.stringify({ state: readFileSync(statePath(f), "utf8") });
    for (const sentinel of [PASSWORD, "SENTINEL_URI_518"]) assert.equal(observable.includes(sentinel), false);
  } finally { f.cleanup(); }
});

test("ambiguous confirmation rechecks whoami and never reconfirms after hardening", async () => {
  const f = fixture();
  let assurance = "unhardened";
  let confirms = 0;
  let regens = 0;
  try {
    const fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/v/auth/whoami") return json({ authenticated: true, assurance });
      if (path === "/v/auth/password") return noContent();
      if (path === "/v/auth/sudo") return json({ expires_at: new Date(Date.now() + 60_000).toISOString() });
      if (path === "/v/auth/totp/enroll") return json({ provisioning_uri: URI });
      if (path === "/v/auth/totp/confirm") { confirms += 1; assurance = "hardened"; return json({ error: { message: RECOVERY[0] } }, 504); }
      if (path === "/v/auth/recovery-codes/regenerate") { regens += 1; return json({ recovery_codes: RECOVERY }); }
      throw new Error(`unexpected ${path}`);
    };
    const c = client(f, fetch);
    await prepareToConfirm(f, c);
    await assert.rejects(c.hardenAccount(mut("confirm_totp")), /outcome is unknown/);
    await c.stageTotpCode(Buffer.from(OTP));
    const recovery = await c.hardenAccount(mut("recover_confirm"));
    assert.equal(recovery.hardened, true);
    assert.equal(confirms, 1);
    assert.equal(regens, 1);
    assert.equal(JSON.stringify(recovery).includes(RECOVERY[0]), false);
  } finally { f.cleanup(); }
});

test("malformed sensitive success fails closed without rendering its secret", async () => {
  const f = fixture();
  const responseSecret = "SENTINEL_MALFORMED_RECOVERY_518";
  try {
    const fetch = hardeningFetch();
    const wrapped = async (url, init) => {
      if (new URL(url).pathname === "/v/auth/totp/confirm") return json({ recovery_codes: [responseSecret], surprise: responseSecret });
      return fetch(url, init);
    };
    const c = client(f, wrapped);
    await prepareToConfirm(f, c);
    await assert.rejects(c.hardenAccount(mut("confirm_totp")), (error) => {
      assert.equal(error.message.includes(responseSecret), false);
      return true;
    });
    const state = JSON.parse(readFileSync(statePath(f), "utf8"));
    assert.equal(state.phase, "hardened_recovery_missing");
    assert.equal(readFileSync(statePath(f), "utf8").includes(responseSecret), false);
  } finally { f.cleanup(); }
});

test("human-only helper refuses redirected stdin, secret argv and recording environments without leaking sentinels", () => {
  const bin = new URL("../dist/hardening-secret.js", import.meta.url).pathname;
  const sentinel = "SENTINEL_HELPER_SECRET_518";
  const redirected = spawnSync(process.execPath, [bin, "totp-code"], { input: "123456\n", encoding: "utf8", env: { ...process.env, PARLE_HARDENING_SECRET: sentinel } });
  const argv = spawnSync(process.execPath, [bin, "totp-code", sentinel], { encoding: "utf8", env: { ...process.env } });
  for (const result of [redirected, argv]) {
    const text = `${result.stdout || ""}${result.stderr || ""}`;
    assert.notEqual(result.status, 0);
    assert.equal(text.includes(sentinel), false);
  }
});

test("documented source-checkout helper invocation resolves the reviewed entrypoint", () => {
  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const guide = readFileSync(new URL("../../../docs/account-hardening-ceremony.md", import.meta.url), "utf8");
  const documented = "pnpm exec parle-hardening-secret <command>";
  assert.equal(guide.includes(documented), true);

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpm, ["exec", "parle-hardening-secret", "__resolve_check__"], { cwd: checkout, encoding: "utf8" });
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  assert.equal(result.status, 2);
  assert.match(text, /parle-hardening-secret could not complete safely/);
  assert.doesNotMatch(text, /command not found|MODULE_NOT_FOUND|ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL/);
});

test("helper hides mode selection, releases stdin, and rejects Zellij environments", () => {
  const source = readFileSync(new URL("../src/hardening-secret.ts", import.meta.url), "utf8");
  assert.match(source, /do not enter the password yet[^\n]+true\)/);
  assert.match(source, /input\.pause\(\)/);
  for (const key of ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) assert.match(source, new RegExp(`"${key}"`));
});

test("expired sudo refreshes without repeating the password mutation", async () => {
  const f = fixture();
  let passwords = 0;
  let confirms = 0;
  try {
    const base = hardeningFetch();
    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v/auth/password") passwords += 1;
      if (path === "/v/auth/totp/confirm" && confirms++ === 0) return json({ error: { code: "step_up_required" } }, 403);
      return base(url, init);
    };
    const c = client(f, fetch);
    await prepareToConfirm(f, c);
    await assert.rejects(c.hardenAccount(mut("confirm_totp")), /HTTP 403/);
    const status = await c.hardenAccount({ action: "status" });
    assert.match(status.next, /bootstrap-proof/);
    await c.stageBootstrapProof(Buffer.from(PASSWORD));
    await c.hardenAccount(mut("refresh_sudo"));
    const result = await c.hardenAccount(mut("confirm_totp"));
    assert.equal(result.hardened, true);
    assert.equal(passwords, 1);
  } finally { f.cleanup(); }
});

test("ambiguous confirmation that remains unhardened requires one fresh explicit confirmation", async () => {
  const f = fixture();
  let confirms = 0;
  let assurance = "unhardened";
  try {
    const base = hardeningFetch();
    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v/auth/whoami") return json({ authenticated: true, assurance });
      if (path === "/v/auth/totp/confirm") {
        confirms += 1;
        if (confirms === 1) return json({ error: { code: "gateway_timeout" } }, 504);
        assurance = "hardened";
        return json({ recovery_codes: RECOVERY });
      }
      return base(url, init);
    };
    const c = client(f, fetch);
    await prepareToConfirm(f, c);
    await assert.rejects(c.hardenAccount(mut("confirm_totp")), /outcome is unknown/);
    const recovered = await c.hardenAccount(mut("recover_confirm"));
    assert.equal(recovered.hardened, false);
    assert.equal(confirms, 1);
    await c.stageTotpCode(Buffer.from(OTP));
    const result = await c.hardenAccount(mut("confirm_totp"));
    assert.equal(result.hardened, true);
    assert.equal(confirms, 2);
  } finally { f.cleanup(); }
});

test("ambiguous recovery regeneration stops and requires a fresh human-gated attempt", async () => {
  const f = fixture();
  let assurance = "unhardened";
  let regenerations = 0;
  try {
    const base = hardeningFetch();
    const fetch = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/v/auth/whoami") return json({ authenticated: true, assurance });
      if (path === "/v/auth/totp/confirm") { assurance = "hardened"; return json({ error: { code: "gateway_timeout" } }, 504); }
      if (path === "/v/auth/recovery-codes/regenerate") {
        regenerations += 1;
        return regenerations === 1 ? json({ error: { code: "gateway_timeout" } }, 504) : json({ recovery_codes: RECOVERY });
      }
      return base(url, init);
    };
    const c = client(f, fetch);
    await prepareToConfirm(f, c);
    await assert.rejects(c.hardenAccount(mut("confirm_totp")), /outcome is unknown/);
    await c.stageTotpCode(Buffer.from(OTP));
    await assert.rejects(c.hardenAccount(mut("recover_confirm")), /outcome is unknown/);
    assert.equal(regenerations, 1);
    await c.stageTotpCode(Buffer.from(OTP));
    const recovered = await c.hardenAccount(mut("recover_confirm"));
    assert.equal(recovered.hardened, true);
    assert.equal(regenerations, 2);
    assert.match(recovered.next, /Only this newly captured/);
  } finally { f.cleanup(); }
});

test("finalize requires human recovery acknowledgement and finalized state stays session-bound", async () => {
  const f = fixture();
  try {
    const c = client(f, hardeningFetch());
    await prepareToConfirm(f, c);
    await c.hardenAccount(mut("confirm_totp"));
    await assert.rejects(c.hardenAccount(mut("finalize")), /acknowledgement/);
    await c.acknowledgeRecoveryStored();
    await c.hardenAccount(mut("finalize"));
    writeFileSync(join(f.state, "session"), "__Host-parle_session=different-human\n", { mode: 0o600 });
    const changed = await c.hardenAccount({ action: "status" });
    assert.equal(changed.state, "session_changed");
    assert.equal(changed.complete, undefined);
  } finally { f.cleanup(); }
});

test("orchestration source never spawns or auto-launches the human-only helper", () => {
  const source = readFileSync(new URL("../src/hardening.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /child_process|spawn\(|execFile/);
});
