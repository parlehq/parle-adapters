import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findForbiddenImports } from "../scripts/check-boundaries.mjs";
import {
  DEFAULT_API_BASE,
  DEFAULT_VERSION,
  DEFAULT_WAKE_BASE,
  ParleAgentClient,
  ProfileDeletionError,
  ProfileNotFoundError,
  processClientInstanceId,
  formatVersionErrorHint,
  assertSafeBase,
  capProjectionMessages,
  clampWaitSeconds,
  compactServerWrappedContent,
  deleteProfile,
  parseErrorEnvelope,
  parseKeyValueFile,
  parseSSEBlocks,
  performProfileSwitch,
  profileCatalogHasProfile,
  loadProfile,
  redactedSecretValue,
  redactString,
  resolveConfig,
  resolveRoomSet,
  responsiveDeliveryKey,
  sendAttentionWarnings,
  summarizeSendDelivery,
  terminalStatusFor,
  truncateText,
  updateCursorFromMessages,
} from "../dist/index.js";

test("adapter owns one release-pinned DEFAULT_VERSION without a contract bundle", () => {
  const protocolSrc = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
  const piSrc = readFileSync(new URL("../../pi-extension/src/index.ts", import.meta.url), "utf8");
  const mcpSrc = readFileSync(new URL("../../mcp-server/src/index.ts", import.meta.url), "utf8");
  assert.equal(DEFAULT_VERSION, "2026-08-10");
  assert.match(protocolSrc, /DEFAULT_VERSION = "2026-08-10"/);
  assert.match(piSrc, /DEFAULT_VERSION[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(piSrc, /const DEFAULT_VERSION =/);
  assert.match(mcpSrc, /PARLE_VERSION: config\.version\.value/);
  for (const path of ["../conformance", "../conformance.pin.json", "../src/conformance-data.ts", "../src/error-contract.ts"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must stay deleted`);
  }
});

test("redaction is structural and fails closed for lowercase Parle credential families", () => {
  const tail = "A".repeat(24);
  for (const prefix of ["parle_agt_", "parle_ses_", "parle_login_", "parle_future_"]) {
    assert.equal(redactString(prefix + tail), "<redacted-token>");
  }
  assert.equal(redactString("Authorization: Bearer foreign-token"), "Authorization: Bearer <redacted>");
  assert.equal(redactString("parle_agt_short"), "parle_agt_short");
  assert.equal(redactString("prt_" + tail), "prt_" + tail);
  assert.equal(redactString("Basic opaque"), "Basic opaque");
});

test("client boundary scan ignores prose and detects forbidden import specifiers", () => {
  assert.deepEqual(findForbiddenImports(new URL("../src", import.meta.url).pathname), []);
  const dir = mkdtempSync(join(tmpdir(), "parle-client-boundary-"));
  try {
    writeFileSync(join(dir, "ok.ts"), "// mentioning mcp, claude, galexc, and pi in prose is fine\nexport const ok = true;\n");
    assert.deepEqual(findForbiddenImports(dir), []);
    writeFileSync(join(dir, "bad.ts"), "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n");
    const findings = findForbiddenImports(dir);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].specifier, "@modelcontextprotocol/sdk/server/mcp.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake configuration uses the dedicated default and warns on an explicit API-base override", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-wake-config-"));
  try {
    assert.equal(DEFAULT_API_BASE, "https://api.parle.sh");
    assert.equal(DEFAULT_WAKE_BASE, "https://wake.parle.sh");

    const defaultCfg = resolveConfig(home, { HOME: home });
    assert.equal(defaultCfg.wakeBase.value, DEFAULT_WAKE_BASE);
    assert.equal(defaultCfg.wakeBase.source, "default");
    assert.doesNotMatch(defaultCfg.warnings.join("\n"), /PARLE_WAKE_BASE explicitly matches/);

    const overrideCfg = resolveConfig(home, {
      HOME: home,
      PARLE_API_BASE: DEFAULT_API_BASE,
      PARLE_WAKE_BASE: DEFAULT_API_BASE,
    });
    assert.equal(overrideCfg.wakeBase.value, DEFAULT_API_BASE);
    assert.equal(overrideCfg.wakeBase.source, "env");
    assert.match(overrideCfg.warnings.join("\n"), /PARLE_WAKE_BASE explicitly matches PARLE_API_BASE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config resolves env before files and redacts tokens", () => {
  const cfg = resolveConfig(process.cwd(), {
    PARLE_ROOM_ID: "room-1",
    PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
  });
  assert.equal(cfg.roomId?.value, "room-1");
  assert.equal(cfg.agentToken?.source, "env");
  assert.equal(redactString("Authorization: Bearer parle_agt_secret"), "Authorization: Bearer <redacted>");
});

test("profile catalog access failures are actionable and never treated as absence", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), "parle-profile-access-"));
  const locked = join(root, "locked");
  const catalog = join(root, "profiles");
  try {
    mkdirSync(locked, { mode: 0o700 });
    writeFileSync(join(locked, "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_test\n", { mode: 0o600 });
    symlinkSync(join(locked, "profiles"), catalog);
    chmodSync(locked, 0o000);

    assert.throws(
      () => profileCatalogHasProfile("default", catalog),
      /cannot be inspected: .*profiles \((?:EACCES|EPERM)\).*parent directories are accessible/,
    );
    assert.throws(
      () => loadProfile("default", catalog),
      /cannot be inspected: .*profiles \((?:EACCES|EPERM)\).*parent directories are accessible/,
    );
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile catalog read failures are actionable", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const root = mkdtempSync(join(tmpdir(), "parle-profile-read-"));
  const catalog = join(root, "profiles");
  try {
    writeFileSync(catalog, "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_test\n", { mode: 0o600 });
    chmodSync(catalog, 0o000);
    assert.throws(
      () => profileCatalogHasProfile("default", catalog),
      /cannot be read: .*profiles \((?:EACCES|EPERM)\).*parent directories are accessible/,
    );
  } finally {
    chmodSync(catalog, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test("typed profile deletion is exact, idempotent, owner-only, and path-free", () => {
  const root = mkdtempSync(join(tmpdir(), "parle-profile-delete-"));
  const catalog = join(root, "profiles");
  const secret = "parle_agt_delete_secret";
  const reason = "reason-must-not-escape";
  const alpha = `[alpha]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = ${secret}\n\n`;
  const beta = "[beta]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_beta\n\n";
  const gamma = "[gamma]\nroom_id = 019f8035-d1f6-7170-8552-0262bce8982f\nagent_token = parle_agt_gamma\n";
  try {
    assert.throws(
      () => deleteProfile({ profile: "alpha", confirmMutation: false, reason }, { catalogPath: catalog }),
      (error) => error instanceof ProfileDeletionError && error.code === "profile_delete_confirmation_required" && !error.message.includes(reason),
    );
    assert.throws(
      () => deleteProfile({ profile: "alpha*", confirmMutation: true, reason }, { catalogPath: catalog }),
      (error) => error instanceof ProfileDeletionError && error.code === "profile_delete_invalid" && !error.message.includes(reason),
    );

    writeFileSync(catalog, alpha + beta + gamma, { mode: 0o644 });
    const missing = deleteProfile({ profile: "missing", confirmMutation: true, reason }, { catalogPath: catalog });
    assert.deepEqual(missing, { profile: "missing", removed: false });
    assert.equal(readFileSync(catalog, "utf8"), alpha + beta + gamma);

    assert.deepEqual(deleteProfile({ profile: "beta", confirmMutation: true, reason }, { catalogPath: catalog }), { profile: "beta", removed: true });
    assert.equal(readFileSync(catalog, "utf8"), alpha + gamma);
    if (process.platform !== "win32") assert.equal(statSync(catalog).mode & 0o777, 0o600);

    deleteProfile({ profile: "alpha", confirmMutation: true, reason }, { catalogPath: catalog });
    assert.equal(readFileSync(catalog, "utf8"), gamma);
    deleteProfile({ profile: "gamma", confirmMutation: true, reason }, { catalogPath: catalog });
    assert.equal(readFileSync(catalog, "utf8"), "");
    assert.deepEqual(deleteProfile({ profile: "gamma", confirmMutation: true, reason }, { catalogPath: catalog }), { profile: "gamma", removed: false });

    writeFileSync(catalog, alpha, { mode: 0o600 });
    writeFileSync(`${catalog}.lock`, `${JSON.stringify({ version: 1, token: "00000000-0000-4000-8000-000000000001", pid: process.pid, createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    assert.throws(
      () => deleteProfile({ profile: "alpha", confirmMutation: true, reason }, { catalogPath: catalog }),
      (error) => error instanceof ProfileDeletionError
        && error.code === "profile_delete_lock_contended"
        && !error.message.includes(root)
        && !error.message.includes(secret)
        && !error.message.includes(reason),
    );
    assert.equal(readFileSync(catalog, "utf8"), alpha);
    rmSync(`${catalog}.lock`, { force: true });

    const target = join(root, "target");
    writeFileSync(target, alpha, { mode: 0o600 });
    rmSync(catalog, { force: true });
    symlinkSync(target, catalog);
    assert.throws(
      () => deleteProfile({ profile: "alpha", confirmMutation: true, reason }, { catalogPath: catalog }),
      (error) => error instanceof ProfileDeletionError
        && error.code === "profile_delete_failed"
        && !error.message.includes(root)
        && !error.message.includes(secret)
        && !error.message.includes(reason),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent client protects only its own profile bindings across runtime states", async () => {
  const root = mkdtempSync(join(tmpdir(), "parle-profile-client-delete-"));
  const catalogDir = join(root, ".parle");
  const catalog = join(catalogDir, "profiles");
  const profile = (name, roomId) => `[${name}]\nroom_id = ${roomId}\nagent_token = parle_agt_${name}\n`;
  try {
    mkdirSync(catalogDir, { mode: 0o700 });
    writeFileSync(catalog, profile("alpha", "019f2946-aef5-77ad-a41d-747ce0fd6a1e") + profile("beta", "019f7b46-178f-7a5a-9f7b-b4af2e045261") + profile("gamma", "019f8035-d1f6-7170-8552-0262bce8982f"), { mode: 0o600 });
    const alpha = new ParleAgentClient({ cwd: root, env: { HOME: root, PARLE_PROFILE: "alpha" } });
    const beta = new ParleAgentClient({ cwd: root, env: { HOME: root, PARLE_PROFILE: "beta" } });

    for (const state of ["unstarted", "bootstrapping", "failed", "ready"]) {
      alpha.runtime.bootstrapState = state;
      await assert.rejects(
        alpha.deleteProfile({ profile: "alpha", confirmMutation: true, reason: "active refusal" }),
        (error) => error instanceof ProfileDeletionError && error.code === "profile_delete_active",
      );
    }
    alpha.profileSwitchInFlight = true;
    await assert.rejects(
      alpha.deleteProfile({ profile: "gamma", confirmMutation: true, reason: "switch refusal" }),
      (error) => error instanceof ProfileDeletionError && error.code === "profile_delete_switch_in_flight",
    );
    alpha.profileSwitchInFlight = false;

    assert.deepEqual(await alpha.deleteProfile({ profile: "beta", confirmMutation: true, reason: "instance scoped" }), { profile: "beta", removed: true });
    assert.equal(beta.status().config.profile.value, "beta", "a second client is intentionally outside the calling instance guard");

    writeFileSync(catalog, profile("alpha", "019f2946-aef5-77ad-a41d-747ce0fd6a1e") + profile("beta", "019f7b46-178f-7a5a-9f7b-b4af2e045261") + profile("gamma", "019f8035-d1f6-7170-8552-0262bce8982f"), { mode: 0o600 });
    const multi = new ParleAgentClient({ cwd: root, env: { HOME: root, PARLE_PROFILES: "alpha,beta" } });
    for (const selected of ["alpha", "beta"]) {
      await assert.rejects(
        multi.deleteProfile({ profile: selected, confirmMutation: true, reason: "multi refusal" }),
        (error) => error instanceof ProfileDeletionError && error.code === "profile_delete_active",
      );
    }
    assert.deepEqual(await multi.deleteProfile({ profile: "gamma", confirmMutation: true, reason: "inactive delete" }), { profile: "gamma", removed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile switch orchestration keeps resolve and prepare failures before commit", async () => {
  const calls = [];
  await assert.rejects(() => performProfileSwitch({
    resolve() { calls.push("resolve"); throw new Error("unknown profile"); },
    async prepare() { calls.push("prepare"); return {}; },
    commit() { calls.push("commit"); },
    retireOldSession() { calls.push("retire"); },
  }), /unknown profile/);
  assert.deepEqual(calls, ["resolve"]);

  calls.length = 0;
  await assert.rejects(() => performProfileSwitch({
    resolve() { calls.push("resolve"); return { profile: "target", roomId: "room-2", changed: true }; },
    async prepare() { calls.push("prepare"); throw new Error("target unavailable"); },
    commit() { calls.push("commit"); },
    retireOldSession() { calls.push("retire"); },
  }), /target unavailable/);
  assert.deepEqual(calls, ["resolve", "prepare"]);
});

test("profile switch orchestration commits once and isolates post-commit cleanup failures", async () => {
  const calls = [];
  const prepared = { session: "opaque" };
  const agentSecret = "parle_agt_" + "x".repeat(43);
  const sessionSecret = "parle_ses_" + "y".repeat(43);
  const result = await performProfileSwitch({
    resolve() { calls.push("resolve"); return { profile: "target", roomId: "room-2", changed: true }; },
    async prepare() { calls.push("prepare"); return prepared; },
    commit(value) { calls.push("commit"); assert.equal(value, prepared); },
    async restartWatcher() { calls.push("restart"); throw new Error(`watcher token ${agentSecret}`); },
    async retireOldSession() { calls.push("retire"); throw new Error(`old session ${sessionSecret}`); },
  });
  assert.deepEqual(calls, ["resolve", "prepare", "commit", "retire", "restart"]);
  assert.equal(result.switched, true);
  assert.equal(result.watcherRestarted, false);
  assert.equal(result.warnings.length, 2);
  assert.equal(JSON.stringify(result).includes(agentSecret), false);
  assert.equal(JSON.stringify(result).includes(sessionSecret), false);

  const noOp = await performProfileSwitch({
    resolve() { return { profile: "target", roomId: "room-2", changed: false }; },
    async prepare() { throw new Error("must not prepare"); },
    commit() { throw new Error("must not commit"); },
    retireOldSession() { throw new Error("must not retire"); },
  });
  assert.deepEqual(noOp, { switched: false, profile: "target", roomId: "room-2", reason: "already_active", watcherRestarted: false, warnings: [] });
});

test("PARLE_VERSION is adapter-owned unless explicitly set in process env", () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-version-config-"));
  try {
    writeFileSync(join(cwd, ".env"), "PARLE_VERSION=from-dotenv\n");
    const defaultCfg = resolveConfig(cwd, { HOME: cwd });
    assert.equal(defaultCfg.version.value, "2026-08-10");
    assert.equal(defaultCfg.version.source, "default");
    assert.match(defaultCfg.warnings.join("\n"), /Ignoring PARLE_VERSION from \.env/);

    const envCfg = resolveConfig(cwd, { HOME: cwd, PARLE_VERSION: "from-env" });
    assert.equal(envCfg.version.value, "from-env");
    assert.equal(envCfg.version.source, "env");
    assert.match(envCfg.warnings.join("\n"), /process environment/);
    assert.doesNotMatch(envCfg.warnings.join("\n"), /Ignoring PARLE_VERSION from \.env/);

    // An env value equal to the adapter default is not an override: no warning,
    // but provenance stays honest (env-snapshotting hosts hit this constantly).
    const sameCfg = resolveConfig(cwd, { HOME: cwd, PARLE_VERSION: DEFAULT_VERSION });
    assert.equal(sameCfg.version.value, DEFAULT_VERSION);
    assert.equal(sameCfg.version.source, "env");
    assert.doesNotMatch(sameCfg.warnings.join("\n"), /process environment/);

    rmSync(join(cwd, ".env"));
    const cleanCfg = resolveConfig(cwd, { HOME: cwd });
    assert.equal(cleanCfg.version.value, "2026-08-10");
    assert.equal(cleanCfg.version.source, "default");
    assert.equal(cleanCfg.warnings.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("key value parser preserves the adapter config-file contract", () => {
  assert.deepEqual(parseKeyValueFile("# hi\n A = 1 \nB=\"two\"\nC='three'\nD=left=right\nE=\nA=last\nnot-a-pair\n"), {
    A: "last", B: "two", C: "three", D: "left=right", E: "",
  });
});

test("safe base rejects non-Parle hosts unless the loopback opt-in is set", () => {
  assert.doesNotThrow(() => assertSafeBase("https://api.parle.sh"));
  assert.throws(() => assertSafeBase("http://evil.example"));
  assert.throws(() => assertSafeBase("https://evilparle.sh"));
  assert.throws(() => assertSafeBase("http://localhost:3000"));
  assert.throws(() => assertSafeBase("ftp://localhost:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
  assert.throws(() => assertSafeBase("https://user:pass@api.parle.sh"));
  assert.doesNotThrow(() => assertSafeBase("http://localhost:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
  assert.doesNotThrow(() => assertSafeBase("https://localhost:8443", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
  assert.doesNotThrow(() => assertSafeBase("http://[::1]:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
});

test("client safe-base validation uses injected env", async () => {
  const client = new ParleAgentClient({ env: { PARLE_API_BASE: "http://localhost:3000", PARLE_WAKE_BASE: "http://localhost:3001", PARLE_ALLOW_INSECURE_LOCAL: "1", PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" } });
  assert.doesNotThrow(() => client.assertConfigured());
});

test("secret values and protocol headers are redacted", () => {
  assert.deepEqual(redactedSecretValue({ source: "env", value: "opaque-token" }), { source: "env", configured: true, value: "<redacted>" });
  // Token-shape redaction is pinned by the core corpus test; here we keep the
  // header rules honest against non-shaped values that only context can catch.
  const text = "Bearer abc.def Idempotency-Key: idem-1 Parle-Agent-Session=s1";
  assert.equal(redactString(text), "Bearer <redacted> Idempotency-Key: <redacted> Parle-Agent-Session=<redacted>");
  assert.equal(redactString("Cookie: __Host-parle_session=abc123; theme=dark"), "Cookie: __Host-parle_session=<redacted>; theme=dark");
});

test("wait clamp is bounded and integral", () => {
  assert.equal(clampWaitSeconds(45), 30);
  assert.equal(clampWaitSeconds(-1), 0);
  assert.equal(clampWaitSeconds(2.9), 2);
});

test("SSE parser ignores keepalives and preserves partial block", () => {
  const parsed = parseSSEBlocks(": keepalive\n\nevent: wake\ndata: {\"room_id\":\"r1\"}\n\npartial");
  assert.deepEqual(parsed.events, [{ event: "wake", data: "{\"room_id\":\"r1\"}" }]);
  assert.equal(parsed.rest, "partial");
});

test("responsive delivery key rejects malformed rows", () => {
  assert.equal(responsiveDeliveryKey({ seq: 4, event_id: "evt-4" }), "4:evt-4");
  assert.equal(responsiveDeliveryKey({ seq: -1, event_id: "evt" }), undefined);
  assert.equal(responsiveDeliveryKey({ seq: 1 }), undefined);
});

test("wake, zero-wait drain, and ack stay in shared client primitives", async () => {
  const calls = [];
  const client = new ParleAgentClient({
    env: {
      PARLE_API_BASE: "http://localhost:3000",
      PARLE_WAKE_BASE: "http://localhost:3001",
      PARLE_ALLOW_INSECURE_LOCAL: "1",
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "opaque-token",
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v/agent/wake")) return new Response("event: wake\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      return Response.json({ ok: true, messages: [] });
    },
  });
  Object.assign(client.runtime, {
    bootstrapped: true,
    bootstrapState: "ready",
    sessionHandle: "session-secret",
    agentSessionId: "session-id",
    roomId: "room-1",
    expiresAt: "2999-01-01T00:00:00Z",
  });

  const stream = await client.openWakeStream();
  assert.equal(await stream.text(), "event: wake\ndata: {}\n\n");
  await client.drainResponsiveDelivery();
  await client.ackResponsiveDelivery({ seq: 8, event_id: "evt-8" });

  assert.equal(calls[0].url, "http://localhost:3001/v/agent/wake");
  assert.equal(calls[0].init.headers.Accept, "text/event-stream");
  assert.equal(calls[0].init.headers["Parle-Agent-Session"], "session-secret");
  assert.equal(calls[0].init.headers["Parle-Client-Instance"], client.clientInstanceId);
  assert.equal(calls[1].url, "http://localhost:3000/v/rooms/room-1/responsive-delivery?wait=0");
  assert.equal(calls[1].init.signal instanceof AbortSignal, true, "zero-wait drains carry a bounded deadline");
  assert.equal(calls[2].url, "http://localhost:3000/v/rooms/room-1/responsive-delivery/ack");
  assert.deepEqual(JSON.parse(calls[2].init.body), { seq: 8, event_id: "evt-8" });
  assert.equal(calls[2].init.method, "POST");
});

test("cursor math advances from messages or watermark", () => {
  assert.equal(updateCursorFromMessages(1, [{ seq: 3 }, { seq: 2 }]), 3);
  assert.equal(updateCursorFromMessages(3, [], 5), 5);
});

test("message cap does not drop an oversized first content row", () => {
  const capped = capProjectionMessages([{ seq: 9, content: "x".repeat(300_000) }], 50, 4096);
  assert.equal(capped.messages.length, 1);
  assert.equal(capped.truncated, true);
});

test("send attention warning follows only server-authored responsive scope", () => {
  assert.equal(sendAttentionWarnings({ attention: { responsive_scope: "target" } }), undefined);
  for (const responsive_scope of ["none", "room", "future_scope", null]) {
    const warnings = sendAttentionWarnings({ attention: { responsive_scope } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /did not report attention\.responsive_scope as target/);
    assert.match(warnings[0], /not substitutes for direct addressing/);
  }
  assert.equal(sendAttentionWarnings({ attention: {} }), undefined);
  assert.equal(sendAttentionWarnings({}), undefined);
});

test("send delivery summary gives canonical state precedence and falls back only when absent", () => {
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivery_state: "accepted_scan_skipped", delivered: true } }), {
    state: "accepted_scan_skipped",
    message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
  });
  const held = summarizeSendDelivery({ seq: 8, moderation: { delivery_state: "held_for_moderation", held: false, delivered: true, reason: "awaiting scan" } });
  assert.equal(held.state, "held_for_moderation");
  assert.equal(held.message, "awaiting scan");
  assert.match(held.nextStep, /seq 8/);
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivery_state: "delivered", held: true } }), { state: "delivered", message: "Message accepted and delivered." });
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivery_state: "blocked", delivered: true, reason: "policy denied" } }), { state: "blocked", message: "policy denied" });
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivery_state: "future_state", delivered: true, reason: "server reason" } }), { state: "accepted_unknown", message: "server reason" });
  assert.equal(summarizeSendDelivery({ moderation: { delivery_state: null, delivered: true } }).state, "accepted_unknown");
  assert.equal(summarizeSendDelivery({ moderation: { held: true, delivered: false, scan: "skipped", steps: [] } }).state, "accepted_scan_skipped");
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivered: true } }), { state: "delivered", message: "Message accepted and delivered." });
  assert.equal(Object.hasOwn({ event_id: "evt-1" }, "deliveryStatus"), false);
  assert.equal(summarizeSendDelivery({ event_id: "evt-1" }), undefined);
});

test("truncation keeps UTF-8 boundaries, byte metadata, and an explicit marker", () => {
  const result = truncateText("😀".repeat(10), 20);
  assert.deepEqual(result, { text: "😀😀\n[truncated]", truncated: true, bytes: 40, returnedBytes: 20 });
  const normal = truncateText("abc", 8);
  assert.deepEqual(normal, { text: "abc", truncated: false, bytes: 3, returnedBytes: 3 });
  const replacement = truncateText("kept \uFFFD value and a long tail", 22);
  assert.equal(replacement.text.startsWith("kept \uFFFD"), true);
  assert.equal(replacement.text.endsWith("\n[truncated]"), true);
});

test("wrapped content compacts only exact same-response framing", () => {
  const preamble = "trusted";
  const content = "trusted\n«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
  assert.equal(compactServerWrappedContent(content, preamble, "ABC"), "«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»");
  assert.equal(compactServerWrappedContent(content, "wrong", "ABC"), content);
  assert.equal(compactServerWrappedContent(content.replace("trusted\n", "trusted\n\n"), preamble, "ABC"), content.replace("trusted\n", "trusted\n\n"));
});

test("requestJson sends one process client identity and rejects reserved caller overrides", async () => {
  const observed = [];
  const options = {
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    publishRuntime: { adapterName: "@parlehq/test-adapter", adapterVersion: "1.2.3" },
    integrationName: "parlehq/test-integration",
    integrationVersion: "1!2.0rc1+build.7",
    fetch: async (_url, init = {}) => {
      observed.push(init.headers);
      return json({ ok: true });
    },
  };
  const first = new ParleAgentClient(options);
  const second = new ParleAgentClient(options);
  await first.requestJson("/v/test");
  await second.requestJson("/v/test");
  assert.equal(first.clientInstanceId, processClientInstanceId());
  assert.equal(second.clientInstanceId, processClientInstanceId());
  assert.equal(observed[0]["Parle-Client-Name"], "@parlehq/test-adapter");
  assert.equal(observed[0]["Parle-Client-Version"], "1.2.3");
  assert.equal(observed[0]["Parle-Client-Instance"], processClientInstanceId());
  assert.equal(observed[0]["Parle-Integration-Name"], "parlehq/test-integration");
  assert.equal(observed[0]["Parle-Integration-Version"], "1!2.0rc1+build.7");
  assert.equal(observed[1]["Parle-Client-Instance"], processClientInstanceId());
  await assert.rejects(
    () => first.requestJson("/v/test", { headers: { "pArLe-ClIeNt-InStAnCe": "00000000-0000-4000-8000-000000000000" } }),
    /reserved by the Parle client/,
  );
  await assert.rejects(
    () => first.requestJson("/v/test", { headers: { "pArLe-InTeGrAtIoN-NaMe": "spoofed" } }),
    /reserved by the Parle client/,
  );
  assert.equal(observed.length, 2);
  assert.throws(() => new ParleAgentClient({ ...options, clientName: "Not A Package" }), /canonical software identifier/);
  assert.throws(() => new ParleAgentClient({ ...options, clientVersion: "bad version" }), /bounded release token/);
  assert.throws(() => new ParleAgentClient({ ...options, integrationName: undefined, integrationVersion: "1.0.0" }), /requires integrationName/);
});

test("unsupported version errors include source, default, and server versions", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token", PARLE_VERSION: "bad-version" },
    fetch: async () => json({ error: { code: "unsupported_parle_version", message: "unsupported Parle-Version header", supported: ["2026-08-10"], current: "2026-08-10" } }, 400),
  });
  await assert.rejects(
    () => client.requestJson("/v/test"),
    /Sent Parle-Version bad-version from env; adapter default is 2026-08-10\. Server supports 2026-08-10\. Unset the stale PARLE_VERSION override or upgrade the adapter\./,
  );
});

test("requestJson validates absolute URLs before sending bearer tokens", async () => {
  const client = new ParleAgentClient({ env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" }, fetch: async () => { throw new Error("fetch should not run"); } });
  await assert.rejects(() => client.requestJson("https://evil.example/x"), /not allowlisted/);
});

test("human session auth mode fails closed until implemented", async () => {
  const client = new ParleAgentClient({ env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" } });
  await assert.rejects(() => client.requestJson("/v/test", { authMode: "human_session" }), /human_session auth is not implemented/);
});

test("client bootstraps, reads inbox, and sends with direct addressing", async () => {
  const requests = [];
  const client = new ParleAgentClient({
    env: {
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
      PARLE_ALLOW_INSECURE_LOCAL: "1",
    },
    randomUUID: () => "idem-1",
    fetch: async (url, init = {}) => {
      const u = String(url);
      requests.push({ url: u, init });
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", address: "@p.a.s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 4, messages: [{ seq: 4, content: "hello" }] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 5, replayed: false, routing: { mode: "direct", target_level: "session", continuity: "ephemeral" }, attention: { inbound_scope: "target", responsive_scope: "target" }, moderation: { delivery_state: "accepted_scan_skipped", held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending" } }, 201);
      return json({});
    },
  });
  const inbox = await client.readInbox({ waitSeconds: 2 });
  assert.equal(inbox.cursorAfter, 4);
  assert.match(inbox.note, /parle_send with to set exactly to that message's author\.address/);
  assert.match(inbox.note, /Omitting to creates an unaddressed durable room row but no target-responsive work for that peer/);
  assert.match(inbox.note, /do not guess from participant_id or provenance fields/);
  const projection = await client.readProjection();
  assert.doesNotMatch(projection.note, /author\.address/);
  const sent = await client.send({ body: "hello", to: "@p.a.s1" });
  assert.equal(sent.idempotencyKey, "idem-1");
  assert.deepEqual(sent.routing, { mode: "direct", target_level: "session", continuity: "ephemeral" });
  assert.deepEqual(sent.attention, { inbound_scope: "target", responsive_scope: "target" });
  assert.equal(sent.clientWarnings, undefined);
  assert.equal(sent.deliveryStatus.state, "accepted_scan_skipped");
  assert.equal(requests.some((r) => r.url.includes("/inbound?since_seq=3&wait=2")), true);
  const sendReq = requests.find((r) => r.url.includes("/messages"));
  assert.equal(sendReq.init.headers["Idempotency-Key"], "idem-1");
  assert.equal(JSON.parse(sendReq.init.body).payload.turn, undefined);
});

test("submitReply redeems only the opaque route with the exact wire body", async () => {
  const requests = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret" },
    randomUUID: () => "idem-reply-1",
    fetch: async (url, init = {}) => {
      const u = String(url);
      requests.push({ url: u, init });
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.endsWith("/replies")) return json({ event_id: "evt-reply", seq: 6, replayed: false, interaction: { interaction_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e62", reply_hop: 3 } }, 201);
      return json({});
    },
  });
  const result = await client.submitReply({
    body: "reply body",
    replyRouteId: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61",
  });
  assert.equal(result.idempotencyKey, "idem-reply-1");
  assert.equal(result.interaction.reply_hop, 3);
  const request = requests.find((entry) => entry.url.endsWith("/replies"));
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["Idempotency-Key"], "idem-reply-1");
  assert.deepEqual(JSON.parse(request.init.body), {
    reply_route_id: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61",
    payload: { body: "reply body" },
  });
  assert.equal(requests.some((entry) => entry.url.includes("/messages")), false);
});

test("privacy-flat reply failure returns no selector fallback and preserves the retry key", async () => {
  const requests = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret" },
    randomUUID: () => "idem-reply-not-found",
    fetch: async (url) => {
      const u = String(url);
      requests.push(u);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.endsWith("/replies")) return json({ error: { code: "not_found", message: "not found", action: "stop", retryable: false, scope: "request", retry_after_ms: null } }, 404);
      return json({});
    },
  });
  const result = await client.submitReply({ body: "reply body", replyRouteId: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not_found");
  assert.equal(result.idempotencyKey, "idem-reply-not-found");
  assert.equal(Object.hasOwn(result, "addressedTo"), false);
  assert.equal(requests.some((url) => url.includes("/messages")), false);
});

test("submitReply never auto-retries a single-use route", async () => {
  let replyAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret" },
    randomUUID: () => "idem-reply-retryable",
    sleep: async () => {},
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.endsWith("/replies")) {
        replyAttempts += 1;
        return json({ error: { code: "server_unavailable", message: "try later", action: "retry_with_backoff", retryable: true, scope: "server", retry_after_ms: 10 } }, 503);
      }
      return json({});
    },
  });
  const result = await client.submitReply({ body: "reply body", replyRouteId: "018f9c1e-7a2b-7c4d-8e9f-0a1b2c3d4e61" });
  assert.equal(replyAttempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.idempotencyKey, "idem-reply-retryable");
});

test("bootstrap keeps the parle_ses_ credential intact and presents it at room entry", async () => {
  const requests = [];
  const client = new ParleAgentClient({
    env: {
      PARLE_ROOM_ID: "room-1",
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
      PARLE_ALLOW_INSECURE_LOCAL: "1",
    },
    fetch: async (url, init = {}) => {
      const u = String(url);
      requests.push({ url: u, init });
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("live-cred"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      return json({});
    },
  });
  await client.bootstrap();
  const entry = requests.find((r) => r.url.endsWith("/participants"));
  assert.equal(entry.init.headers["Parle-Agent-Session"], "parle_ses_live-cred");
  assert.equal(JSON.stringify(client.status()).includes("live-cred"), false);
});

test("rawResponse requests still redact error text and details", async () => {
  // Shape-valid fake: token-class redaction is pinned to the core corpus
  // (prefix + 43 base64url chars), so leak fakes must look like real tokens.
  const leaked = "parle_ses_" + "x".repeat(43);
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret", PARLE_ALLOW_INSECURE_LOCAL: "1" },
    fetch: async () => json({ error: { code: "bad", message: `leaked ${leaked} in error` } }, 400),
  });
  await client.requestJson("/v/agent/sessions", { method: "POST", body: {}, rawResponse: true }).then(
    () => assert.fail("expected rejection"),
    (error) => {
      assert.match(error.message, /Parle API 400/);
      assert.equal(error.message.includes(leaked), false);
      assert.equal(JSON.stringify(error.details).includes(leaked), false);
    },
  );
});

test("send omits delivery status when success has no moderation envelope", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-no-moderation",
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-no-moderation", seq: 6 }, 201);
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.idempotencyKey, "idem-no-moderation");
  assert.equal(Object.hasOwn(result, "deliveryStatus"), false);
});

test("read cursor advances only through returned capped messages", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 5, messages: [{ seq: 4, content: "returned" }, { seq: 5, content: "not returned" }] });
      return json({});
    },
  });
  const result = await client.readInbox({ limitMessages: 1 });
  assert.equal(result.messages.length, 1);
  assert.equal(result.cursorAfter, 4);
});

test("agent-session rebootstrap retries once and preserves cursor", async () => {
  let sessions = 0;
  let readAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 12, messages: [] });
      if (u.includes("/projection?since_seq=")) {
        readAttempts += 1;
        return json({ error: { code: "invalid_agent_session", message: "expired", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }, 401);
      }
      return json({});
    },
  });
  await assert.rejects(() => client.readProjection(), { status: 401 });
  assert.equal(sessions, 2);
  assert.equal(readAttempts, 2);
  assert.equal(client.runtime.rooms[0].cursor, 12);
});

test("repeated agent-session terminal failure does not rebootstrap twice in one episode", async () => {
  let sessions = 0;
  let inboxAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 21, messages: [] });
      if (u.includes("/inbound")) {
        inboxAttempts += 1;
        return json({ error: { code: "invalid_agent_session", message: "missing", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }, 401);
      }
      return json({});
    },
  });
  await assert.rejects(() => client.readInbox(), { status: 401 });
  assert.equal(sessions, 2);
  assert.equal(inboxAttempts, 2);
  assert.equal(client.runtime.rooms[0].cursor, 21);
});

test("concurrent terminal failures share one rebootstrap flight", async () => {
  let sessions = 0;
  let inboxAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) {
        sessions += 1;
        if (sessions === 2) await new Promise((resolve) => setTimeout(resolve, 5));
        return json({ agent_session_id: `as-${sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      }
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 22, messages: [] });
      if (u.includes("/inbound")) {
        inboxAttempts += 1;
        if (inboxAttempts <= 2) return json({ error: { code: "agent_session_ended", message: "ended", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }, 401);
        return json({ watermark: 23, messages: [] });
      }
      return json({});
    },
  });
  const [a, b] = await Promise.all([client.readInbox(), client.readInbox()]);
  assert.equal(a.cursorAfter, 23);
  assert.equal(b.cursorAfter, 23);
  assert.equal(sessions, 2);
  assert.equal(inboxAttempts, 4);
});

test("affordances rebootstrap after agent-session terminal error and preserve cursor", async () => {
  let sessions = 0;
  let affordanceAttempts = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 33, messages: [] });
      if (u.includes("/affordances")) {
        affordanceAttempts += 1;
        if (affordanceAttempts === 1) return json({ error: { code: "agent_session_expired", message: "missing", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }, 401);
        return json({ affordances: [{ action: "send" }] });
      }
      return json({});
    },
  });
  const result = await client.affordances();
  assert.deepEqual(result.affordances, [{ action: "send" }]);
  assert.equal(sessions, 2);
  assert.equal(affordanceAttempts, 2);
  assert.equal(client.runtime.rooms[0].cursor, 33);
});

test("send reuses generated idempotency key across agent-session rebootstrap", async () => {
  let sessions = 0;
  let messageAttempts = 0;
  const messageKeys = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-stable",
    fetch: async (url, init = {}) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection?wait=0")) return json({ watermark: 44, messages: [] });
      if (u.includes("/messages")) {
        messageAttempts += 1;
        messageKeys.push(init.headers["Idempotency-Key"]);
        if (messageAttempts === 1) return json({ error: { code: "agent_session_superseded", message: "missing", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }, 401);
        return json({ event_id: "evt-1", seq: 45 }, 201);
      }
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.idempotencyKey, "idem-stable");
  assert.deepEqual(messageKeys, ["idem-stable", "idem-stable"]);
  assert.equal(sessions, 2);
  assert.equal(client.runtime.rooms[0].cursor, 44);
});

test("send maps bootstrap setup errors into structured send failure", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1" },
    randomUUID: () => "idem-setup-needed",
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.idempotencyKey, "idem-setup-needed");
  assert.match(result.error, /PARLE_ROOM_AGENT_TOKEN is missing/);
});

test("shared error reader preserves unknown server semantics and fails conservatively", () => {
  assert.deepEqual(parseErrorEnvelope({ error: {
    code: "future_error", message: "future", action: "future_action",
    scope: "future_scope", retryable: true, retry_after_ms: 1234,
  } }), {
    code: "future_error", message: "future", action: "future_action",
    scope: "future_scope", retryable: true, retryAfterMs: 1234,
    raw: { code: "future_error", message: "future", action: "future_action", scope: "future_scope", retryable: true, retry_after_ms: 1234 },
  });
  const missing = parseErrorEnvelope("not json");
  assert.equal(missing.retryable, undefined);
  assert.deepEqual(missing.raw, {});
  assert.equal(missing.action, undefined);
  assert.equal(missing.scope, undefined);
  assert.equal(parseErrorEnvelope({ error: { action: "", scope: "", retryable: "yes" } }).retryable, undefined);
});

test("requestJson falls back to retryable HTTP status classes only when the server is silent", async () => {
  for (const [status, expected] of [[502, true], [503, true], [504, true], [429, true], [400, false]]) {
    const client = new ParleAgentClient({
      env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
      fetch: async () => new Response("", { status }),
    });
    await assert.rejects(() => client.requestJson("/v/test", { retry: false }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.retryable, expected);
      return true;
    });
  }

  const explicitFalse = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => json({ error: { code: "server_error", message: "do not retry", retryable: false } }, 500),
  });
  await assert.rejects(() => explicitFalse.requestJson("/v/test", { retry: false }), (error) => {
    assert.equal(error.status, 500);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("requestJson retries an unenveloped gateway failure", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => ++attempts === 1 ? new Response("", { status: 502, statusText: "Bad Gateway" }) : json({ ok: true }),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(await client.requestJson("/v/test"), { ok: true });
  assert.equal(attempts, 2);
  assert.equal(sleeps.length, 1);
});

test("requestJson parses canonical error envelope action scope and retry delay", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => json({ error: { code: "rate_limited", message: "slow down", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: 2500 } }, 429),
  });
  await assert.rejects(() => client.requestJson("/v/test", { retry: false }), (error) => {
    assert.equal(error.code, "rate_limited");
    assert.equal(error.action, "backoff");
    assert.equal(error.scope, "rate_limit");
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 2500);
    assert.match(terminalStatusFor(error), /retry scheduled after 3 seconds/);
    return true;
  });
});

test("rebootstrap guidance names a replacement session and distinguishes bearer reauthorization", () => {
  assert.match(terminalStatusFor({ action: "rebootstrap" }), /replacement with the still-valid agent token/);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /expiry ends only this session incarnation/);
  assert.match(source, /Reauthorize only when the agent token is invalid or revoked/);
});

test("requestJson does not reconstruct retry timing when retry_after_ms is absent", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: null } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "4" } }),
  });
  await assert.rejects(() => client.requestJson("/v/test", { retry: false }), (error) => {
    assert.equal(error.retryAfterMs, undefined);
    return true;
  });
});

test("requestJson honors envelope retry_after_ms before retrying retryable GET failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: 2000 } }), { status: 429, headers: { "content-type": "application/json" } });
      }
      return json({ ok: true });
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const result = await client.requestJson("/v/test");
  assert.deepEqual(result, { ok: true });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("requestJson wraps fetch timeout as retryable ParleApiError", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => { throw new DOMException("timed out", "TimeoutError"); },
  });
  await assert.rejects(() => client.requestJson("/v/test", { retry: false }), (error) => {
    assert.equal(error.name, "ParleApiError");
    assert.equal(error.code, "timeout");
    assert.equal(error.retryable, true);
    return true;
  });
});

test("retryable send errors return idempotency key for byte-identical retry", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-retry",
    sleep: async () => {},
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ error: { code: "rate_limited", message: "Bearer secret", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: 1000 } }, 429);
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.idempotencyKey, "idem-retry");
  assert.equal(Object.hasOwn(result, "deliveryStatus"), false);
  assert.match(result.error, /Bearer <redacted>/);
});

test("non-retryable send failures still return the reusable idempotency key", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    randomUUID: () => "idem-nonretryable",
    fetch: async (url) => {
      const value = String(url);
      if (value.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", session_handle: "s1", expires_at: "later" }, 201);
      if (value.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (value.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (value.includes("/messages")) return json({ error: { code: "validation_failed", message: "bad request", retryable: false } }, 400);
      return json({});
    },
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.idempotencyKey, "idem-nonretryable");
});

test("connect bootstraps once, returns factual summary, and reuses live sessions", async () => {
  let sessions = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token", PARLE_ROOM_HANDLE: "room-handle" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, address: "@p.a.s1", expires_at: "2999-01-01T00:00:00Z" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 7, messages: [], held_backlog: { held_count: 2 } });
      return json({});
    },
  });
  const first = await client.connect();
  assert.equal(first.connected, true);
  assert.equal(first.reusedExistingSession, false);
  assert.equal(first.agentSessionId, "as-1");
  assert.equal(first.rooms[0].participantId, "part-1");
  assert.equal(first.rooms[0].cursor, 7);
  assert.equal(first.rooms[0].heldBacklogCount, 2);
  assert.equal(first.rooms[0].roomHandle, "room-handle");
  assert.match(first.next, /arm responsive delivery/);
  assert.match(first.next, /^Render compactText verbatim/);
  const second = await client.connect();
  assert.equal(second.reusedExistingSession, true);
  assert.equal(sessions, 1);
});

test("connect re-bootstraps an expired session", async () => {
  let sessions = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    now: () => new Date("2030-01-01T00:00:00Z"),
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: `as-${++sessions}`, session_credential: `parle_ses_s${sessions}`, session_handle: `s${sessions}`, expires_at: "2029-01-01T00:00:00Z" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 1, messages: [] });
      return json({});
    },
  });
  await client.connect();
  const second = await client.connect();
  assert.equal(second.reusedExistingSession, false);
  assert.equal(sessions, 2);
});

test("implicit bootstrap attaches session block to the triggering call only", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", address: "@p.a.s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 3, messages: [] });
      if (u.includes("/inbound")) return json({ watermark: 3, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 4 }, 201);
      return json({});
    },
  });
  const first = await client.readInbox();
  assert.equal(first.session.established, "this_call");
  assert.equal(first.session.sessionAddress, "@p.a.s1");
  assert.equal(first.session.agentSessionId, "as-1");
  assert.match(first.session.next, /arm responsive delivery/);
  // Lazy session blocks carry no compactText, so their guidance must not point at one.
  assert.doesNotMatch(first.session.next, /compactText/);
  const second = await client.readInbox();
  assert.equal(Object.hasOwn(second, "session"), false);
  const sent = await client.send({ body: "hello" });
  assert.equal(Object.hasOwn(sent, "session"), false);
});

test("send that bootstraps attaches the session block", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 1 }, 201);
      return json({});
    },
  });
  const sent = await client.send({ body: "hello" });
  assert.equal(sent.session.established, "this_call");
});

test("status exposes agent_session_id, redacts session handle, marks optional config", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-1", session_credential: "parle_ses_" + String("s1"), session_handle: "s1", expires_at: "later" }, 201);
      if (u.endsWith("/participants")) return json({ participant_id: "part-1" }, 201);
      if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
      return json({});
    },
  });
  assert.equal(client.setup().configured, true);
  assert.equal(client.setup().connected, false);
  assert.match(client.setup().note, /Not yet connected/);
  await client.connect();
  const status = client.status();
  assert.equal(status.runtime.agentSessionId, "as-1");
  assert.equal(status.runtime.sessionHandle, "<redacted>");
  assert.equal(status.config.agentTokenId.optional, true);
  assert.match(client.setup().note, /holds a session/);
});

test("connect-time 401 carries a stale-token hint when the on-disk token differs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parle-client-stale-"));
  try {
    writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=new-rotated-token\n");
    const client = new ParleAgentClient({
      cwd: dir,
      env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "old-snapshot-token" },
      fetch: async () => json({ error: { code: "unauthenticated", message: "missing or invalid credential", action: "reauthorize", retryable: false, scope: "agent_token", retry_after_ms: null } }, 401),
    });
    await assert.rejects(() => client.connect(), (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /likely rotated/);
      assert.match(error.message, /\.env/);
      assert.match(error.message, /source: env/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connect-time reauthorize reloads a rotated disk token once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parle-client-reload-"));
  try {
    writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=old-disk-token\n");
    let sessionAttempts = 0;
    const client = new ParleAgentClient({
      cwd: dir,
      env: { PARLE_ROOM_ID: "room-1" },
      fetch: async (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/v/agent/sessions")) {
          sessionAttempts += 1;
          if (init.headers.Authorization === "Bearer old-disk-token") {
            writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=new-disk-token\n");
            return json({ error: { code: "invalid_agent_token", message: "token revoked", action: "reauthorize", retryable: false, scope: "agent_token" } }, 401);
          }
          assert.equal(init.headers.Authorization, "Bearer new-disk-token");
          return json({ agent_session_id: "as-1", session_credential: "parle_ses_s1", session_handle: "s1", expires_at: "later" }, 201);
        }
        if (u.endsWith("/participants")) {
          assert.equal(init.headers.Authorization, "Bearer new-disk-token");
          return json({ participant_id: "part-1" }, 201);
        }
        if (u.includes("/projection")) return json({ watermark: 0, messages: [] });
        return json({});
      },
    });
    await client.connect();
    assert.equal(sessionAttempts, 2);
    assert.equal(client.cfg.agentToken.value, "new-disk-token");
    assert.equal(client.runtime.bootstrapped, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("401 without on-disk divergence carries no stale-token hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parle-client-fresh-"));
  try {
    writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=same-token\n");
    const client = new ParleAgentClient({
      cwd: dir,
      env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "same-token" },
      fetch: async () => json({ error: { code: "unauthenticated", message: "missing or invalid credential" } }, 401),
    });
    await assert.rejects(() => client.connect(), (error) => {
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /likely rotated/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a legacy .parle/credentials file is inert for config and divergence checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "parle-client-shadow-"));
  try {
    writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=same-token\n");
    mkdirSync(join(dir, ".parle"));
    writeFileSync(join(dir, ".parle", "credentials"), "PARLE_ROOM_AGENT_TOKEN=stale-leftover\nPARLE_ROOM_ID=legacy-room\n");
    const cfg = resolveConfig(dir, {});
    assert.equal(cfg.roomId?.value, undefined);
    assert.equal(cfg.agentToken?.value, "same-token");
    assert.equal(cfg.agentToken?.source, ".env");
    const client = new ParleAgentClient({
      cwd: dir,
      env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "same-token" },
    });
    assert.equal(client.staleTokenHint(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setup and status surface the stale-token warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "parle-client-setup-stale-"));
  try {
    writeFileSync(join(dir, ".env"), "PARLE_ROOM_AGENT_TOKEN=new-rotated-token\n");
    const client = new ParleAgentClient({
      cwd: dir,
      env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "old-snapshot-token" },
    });
    const setup = client.setup();
    assert.equal(setup.ok, false);
    assert.equal(setup.configured, true);
    assert.deepEqual(setup.missing, []);
    assert.match(setup.warning, /likely rotated/);
    assert.ok(client.status().warnings.some((w) => /likely rotated/.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("profile selects an atomic room binding from the personal catalog", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[galexc-intercom]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_profile_token\n", { mode: 0o600 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=galexc-intercom\n");
    const cfg = resolveConfig(cwd, { HOME: home });
    assert.equal(cfg.profile?.value, "galexc-intercom");
    assert.equal(cfg.roomId?.value, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
    assert.equal(cfg.agentToken?.value, "parle_agt_profile_token");
    assert.equal(cfg.roomId?.source, "profile:galexc-intercom");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("client profile switch prepares a scratch session, adopts room identity, and retires the old session", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-switch-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-switch-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_old\n\n[target]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_target\n", { mode: 0o600 });
    const calls = [];
    const instances = [];
    const fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const auth = init.headers?.Authorization;
      instances.push(init.headers?.["Parle-Client-Instance"]);
      if (path === "/v/agent/sessions") {
        calls.push(["session", auth]);
        const target = auth === "Bearer parle_agt_target";
        return json({ agent_session_id: target ? "as-target" : "as-old", session_credential: target ? "parle_ses_target" : "parle_ses_old", expires_at: "2099-01-01T00:00:00Z", address: target ? "@p.a.target" : "@p.a.old" }, 201);
      }
      if (path.endsWith("/participants")) {
        const target = path.includes("019f7b46-178f-7a5a-9f7b-b4af2e045261");
        return json({ participant_id: target ? "part-target" : "part-old", room_handle: target ? "target-room" : "old-room" }, 201);
      }
      if (path.endsWith("/projection")) return json({ watermark: path.includes("019f7b46-178f-7a5a-9f7b-b4af2e045261") ? 42 : 7, messages: [] });
      if (path === "/v/agent/sessions/as-old/end") {
        calls.push(["end-old", auth, init.headers?.["Parle-Agent-Session"]]);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${path}`);
    };
    const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILE: "default" }, fetch });
    await client.connect();
    const result = await client.switchProfile("target");
    assert.equal(result.switched, true);
    assert.equal(result.previousProfile, "default");
    assert.equal(result.rooms[0].roomId, "019f7b46-178f-7a5a-9f7b-b4af2e045261");
    assert.equal(result.rooms[0].roomHandle, "target-room");
    assert.equal(result.rooms[0].cursor, 42);
    assert.equal(result.watcherRestartRequired, true);
    assert.equal(result.watcherRestarted, false);
    assert.equal(client.status().config.profile.value, "target");
    assert.equal(client.status().rooms[0].roomHandle, "target-room");
    assert.deepEqual(calls.at(-1), ["end-old", "Bearer parle_agt_old", "parle_ses_old"]);
    assert.deepEqual([...new Set(instances)], [client.clientInstanceId], "scratch bootstrap and retirement retain the owner process identity");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

const ALIAS_CATALOG = "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_old\n\n[target]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_target\n";

// Alias switching fixture. The target token addresses a different durable
// agent unless the test says otherwise, so its alias domain is independent of
// the source agent's alias domain.
function aliasSwitchHarness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-alias-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-alias-project-"));
  mkdirSync(join(home, ".parle"), { mode: 0o700 });
  writeFileSync(join(home, ".parle", "profiles"), ALIAS_CATALOG, { mode: 0o600 });
  const calls = [];
  const state = { targetAliasOwner: options.targetAliasOwner ?? "someone-else", endStatus: options.endStatus ?? 204 };
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method || "GET";
    const target = init.headers?.Authorization === "Bearer parle_agt_target";
    calls.push([method, path, target ? "target" : "source"]);
    if (options.onCall) await options.onCall(path, method, target);
    if (path === "/v/agent/sessions" && method === "POST") {
      return json({ agent_session_id: target ? "as-target" : "as-old", session_credential: target ? "parle_ses_target" : "parle_ses_old", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: target ? "@p.target.handle" : "@p.source.handle" }, 201);
    }
    if (path.endsWith("/participants")) {
      const targetRoom = path.includes("019f7b46-178f-7a5a-9f7b-b4af2e045261");
      return json({ participant_id: targetRoom ? "part-target" : "part-old", room_handle: targetRoom ? "target-room" : "old-room" }, 201);
    }
    if (path.endsWith("/projection")) return json({ watermark: path.includes("019f7b46-178f-7a5a-9f7b-b4af2e045261") ? 42 : 7, messages: [] });
    if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
    if (path === "/v/agent/session-aliases/main") {
      // Alias authority is scoped per durable agent id.
      return json(target
        ? { alias: "main", generation: 4, current_agent_session_id: state.targetAliasOwner }
        : { alias: "main", generation: 1, current_agent_session_id: "as-old" });
    }
    if (path.endsWith("/claim-alias")) {
      if (options.claimStatus && target) return json({ error: { code: "agent_session_alias_conflict", message: "stale", retryable: false } }, options.claimStatus);
      return json({ agent_session_id: "as-target", alias: "main", generation: 5, address: "@p.target.main", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path.endsWith("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
    if (path.endsWith("/end")) {
      if (state.endStatus >= 400) return json({ error: { code: "unavailable", message: "nope" } }, state.endStatus);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${path}`);
  };
  const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILE: "default", PARLE_SESSION_ALIAS: "main" }, fetch });
  return {
    client,
    calls,
    state,
    // Only target-agent claims belong to the switch; the source bootstrap
    // claims the same alias string in its own agent's domain.
    claimed: () => calls.filter(([, path, who]) => path.endsWith("/claim-alias") && who === "target"),
    ended: () => calls.filter(([, path]) => path.endsWith("/end")),
    cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("client profile switch claims a configured alias on the target agent and retires the source explicitly", async () => {
  const harness = aliasSwitchHarness();
  try {
    await harness.client.connect();
    const result = await harness.client.switchProfile("target");
    assert.equal(result.switched, true);
    assert.equal(result.rooms[0].cursor, 42, "a cursor is never preserved across rooms");
    assert.equal(harness.client.runtime.sessionAlias, "main");
    assert.equal(harness.client.runtime.sessionAddress, "@p.target.main");
    // The target claim cannot supersede another durable agent's alias owner,
    // so the source route stays live until it is ended with source config.
    assert.deepEqual(harness.ended().at(-1), ["POST", "/v/agent/sessions/as-old/end", "source"]);
    assert.equal(harness.client.runtime.responsiveContinuity, "exact_session_not_transferred");
    assert.deepEqual(result.warnings, []);
  } finally {
    harness.cleanup();
  }
});

test("client profile switch treats an authoritative same-session alias owner as supersession", async () => {
  const harness = aliasSwitchHarness({ targetAliasOwner: "as-old" });
  try {
    await harness.client.connect();
    const result = await harness.client.switchProfile("target");
    assert.equal(result.switched, true);
    assert.equal(harness.claimed().length, 1);
    assert.equal(harness.ended().length, 0, "claim supersession already moved authority off the source session");
    assert.equal(harness.client.runtime.responsiveContinuity, "exact_session_not_transferred", "the room changed, so nothing is transferred");
  } finally {
    harness.cleanup();
  }
});

test("client profile switch reports a possible external alias winner on claim conflict and stays on the live profile", async () => {
  const harness = aliasSwitchHarness({ claimStatus: 409 });
  try {
    await harness.client.connect();
    const sourceSession = harness.client.runtime.agentSessionId;
    await assert.rejects(harness.client.switchProfile("target"), /external winner may already hold alias authority/);
    assert.equal(harness.client.status().config.profile.value, "default");
    assert.equal(harness.client.runtime.agentSessionId, sourceSession);
    assert.equal(harness.client.runtime.rooms[0].roomHandle, "old-room");
    assert.deepEqual(harness.ended().at(-1), ["POST", "/v/agent/sessions/as-target/end", "target"], "the losing candidate is retired");
  } finally {
    harness.cleanup();
  }
});

test("client profile switch pre-claim guard rejects an open responsive read before any claim is issued", async () => {
  const harness = aliasSwitchHarness();
  try {
    await harness.client.connect();
    const read = await harness.client.drainResponsiveDeliveryWithFence();
    try {
      await assert.rejects(harness.client.switchProfile("target"), /deferred while responsive delivery is being read/);
    } finally {
      read.release();
    }
    assert.deepEqual(harness.claimed(), [], "the guard runs before the only authority-transferring call");
    assert.deepEqual(harness.ended().at(-1), ["POST", "/v/agent/sessions/as-target/end", "target"]);
    assert.equal(harness.client.status().config.profile.value, "default");
  } finally {
    harness.cleanup();
  }
});

test("client publication barrier refuses a responsive read opened during a profile switch", async () => {
  let refused;
  const harness = aliasSwitchHarness({
    onCall: async (path, method, target) => {
      if (path === "/v/agent/session-aliases/main" && target && refused === undefined) {
        refused = await harness.client.drainResponsiveDelivery().then(() => null, (error) => error);
      }
    },
  });
  try {
    await harness.client.connect();
    await harness.client.switchProfile("target");
    assert.match(String(refused), /deferred while a profile switch completes/);
    assert.equal(refused.code, "lifecycle_publication_in_progress");
  } finally {
    harness.cleanup();
  }
});

test("client profile switch surfaces a source retirement failure as a warning without reverting", async () => {
  const harness = aliasSwitchHarness({ endStatus: 503 });
  try {
    await harness.client.connect();
    const result = await harness.client.switchProfile("target");
    assert.equal(result.switched, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /prior agent session could not be ended/);
    assert.equal(harness.client.status().config.profile.value, "target");
  } finally {
    harness.cleanup();
  }
});

test("client profile switch failure leaves the old profile session intact", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-fail-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-fail-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_old\n\n[bad]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045262\nagent_token = parle_agt_bad\n", { mode: 0o600 });
    let oldEnded = false;
    const fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const auth = init.headers?.Authorization;
      if (path === "/v/agent/sessions") {
        const bad = auth === "Bearer parle_agt_bad";
        return json({ agent_session_id: bad ? "as-bad" : "as-old", session_credential: bad ? "parle_ses_bad" : "parle_ses_old", expires_at: "2099-01-01T00:00:00Z", address: bad ? "@p.a.bad" : "@p.a.old" }, 201);
      }
      if (path === "/v/rooms/019f2946-aef5-77ad-a41d-747ce0fd6a1e/participants") return json({ participant_id: "part-old", room_handle: "old-room" }, 201);
      if (path === "/v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045262/participants") return json({ error: { message: "not admitted" } }, 404);
      if (path === "/v/rooms/019f2946-aef5-77ad-a41d-747ce0fd6a1e/projection") return json({ watermark: 7, messages: [] });
      if (path === "/v/agent/sessions/as-bad/end") return new Response(null, { status: 204 });
      if (path === "/v/agent/sessions/as-old/end") { oldEnded = true; return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    };
    const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILE: "default" }, fetch });
    await client.connect();
    await assert.rejects(client.switchProfile("bad"), /not admitted/);
    assert.equal(oldEnded, false);
    assert.equal(client.status().config.profile.value, "default");
    assert.equal(client.runtime.rooms[0].roomId, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
    assert.equal(client.runtime.rooms[0].roomHandle, "old-room");
    assert.equal(client.runtime.sessionAddress, "@p.a.old");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("PARLE_PROFILES_PATH replaces the default catalog and resolves relative to cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profiles-path-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profiles-path-project-"));
  try {
    mkdirSync(join(cwd, ".parle"), { mode: 0o700 });
    writeFileSync(join(cwd, ".parle", "team-profiles"), "[local]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_override_token\n", { mode: 0o600 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILES_PATH=./.parle/team-profiles\nPARLE_PROFILE=local\n");
    const cfg = resolveConfig(cwd, { HOME: home });
    assert.equal(cfg.profile?.value, "local");
    assert.equal(cfg.agentToken?.value, "parle_agt_override_token");
    assert.equal(cfg.agentToken?.source, "profile:local");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("PARLE_PROFILES_PATH is exclusive: the default catalog is never layered in", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profiles-exclusive-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profiles-exclusive-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    mkdirSync(join(cwd, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[shared]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_personal_token\n", { mode: 0o600 });
    writeFileSync(join(cwd, ".parle", "team-profiles"), "[other]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_override_token\n", { mode: 0o600 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILES_PATH=./.parle/team-profiles\nPARLE_PROFILE=shared\n");
    assert.throws(
      () => resolveConfig(cwd, { HOME: home }),
      (error) => error instanceof ProfileNotFoundError
        && error.code === "profile_not_found"
        && error.selector === "shared"
        && error.availableProfiles.join(",") === "other",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a catalog inside a git work tree warns unless git-ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profiles-git-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profiles-git-project-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    mkdirSync(join(cwd, ".parle"), { mode: 0o700 });
    writeFileSync(join(cwd, ".parle", "team-profiles"), "[local]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_override_token\n", { mode: 0o600 });
    writeFileSync(join(cwd, ".env"), "PARLE_PROFILES_PATH=./.parle/team-profiles\nPARLE_PROFILE=local\n");
    const exposed = resolveConfig(cwd, { HOME: home });
    assert.match(exposed.warnings.join("\n"), /not git-ignored/);
    writeFileSync(join(cwd, ".gitignore"), ".parle/\n");
    const ignored = resolveConfig(cwd, { HOME: home });
    assert.doesNotMatch(ignored.warnings.join("\n"), /not git-ignored/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("profile rejects direct room-binding configuration", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-conflict-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-conflict-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[p]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_profile_token\n", { mode: 0o600 });
    assert.throws(() => resolveConfig(cwd, { HOME: home, PARLE_PROFILE: "p", PARLE_ROOM_ID: "stale-room" }), /PARLE_PROFILE from env conflicts with direct configuration/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("catalog without a default profile does not create an implicit selector", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-no-default-profile-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-no-default-profile-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[work]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_work_token\n", { mode: 0o600 });
    const cfg = resolveConfig(cwd, { HOME: home });
    assert.equal(cfg.profile, undefined);
    assert.equal(cfg.roomId?.value, undefined);
    assert.equal(cfg.agentToken?.value, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("default profile is selected when no explicit binding is configured", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-default-profile-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-default-profile-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_default_token\n", { mode: 0o600 });
    const cfg = resolveConfig(cwd, { HOME: home });
    assert.equal(cfg.profile?.value, "default");
    assert.equal(cfg.agentToken?.value, "parle_agt_default_token");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("version error hint preserves supported-version precedence", () => {
  const cfg = { version: { value: "old", source: "env" } };
  assert.equal(formatVersionErrorHint(cfg, { supported: ["new"], current: "also-new" }), " Sent Parle-Version old from env; adapter default is 2026-08-10. Server supports new. Unset the stale PARLE_VERSION override or upgrade the adapter.");
});

test("automatic bootstrap terminal latch fails closed while explicit connect remains a recovery path", async () => {
  let requests = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "revoked-token" },
    fetch: async () => {
      requests += 1;
      return json({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token" } }, 401);
    },
  });
  assert.equal(await client.ensureReadySafe(), true);
  assert.equal(await client.ensureReadySafe(), false);
  assert.equal(requests, 1);
  assert.equal(client.runtime.terminalCause?.action, "reauthorize");
  assert.equal(client.runtime.nextRetryAt, undefined);
  await assert.rejects(() => client.connect(), { status: 401 });
  assert.equal(requests, 2, "explicit connect must bypass the automatic latch");
  assert.equal(client.runtime.terminalCause?.streak, 2, "the next admitted terminal fault advances the terminal streak");
});

test("terminal wake failures use the same shared-client automatic latch", async () => {
  let wakeCalls = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "revoked-token" },
    fetch: async (url) => {
      if (String(url).endsWith("/v/agent/wake")) {
        wakeCalls += 1;
        return json({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token" } }, 401);
      }
      throw new Error("bootstrap should not run");
    },
  });
  Object.assign(client.runtime, { bootstrapped: true, bootstrapState: "ready", sessionHandle: "parle_ses_live", agentSessionId: "as-live", roomId: "room-1", expiresAt: "2999-01-01T00:00:00Z" });
  await assert.rejects(() => client.openWakeStream(), { status: 401 });
  assert.equal(wakeCalls, 1);
  assert.equal(client.runtime.terminalCause?.action, "reauthorize");
  assert.equal(client.runtime.terminalCause?.retryable, false);
  assert.equal(await client.ensureReadySafe(), false, "mid-session terminal cause keeps automatic readiness quiet");
  await assert.rejects(() => client.openWakeStream(), { status: 401 });
  assert.equal(wakeCalls, 1, "the automatic wake latch rejects without another request");
});

test("wake stream errors use the same unenveloped status fallback", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async (url) => {
      if (String(url).endsWith("/v/agent/wake")) return new Response("", { status: 502, statusText: "Bad Gateway" });
      throw new Error("unexpected request");
    },
  });
  Object.assign(client.runtime, { bootstrapped: true, bootstrapState: "ready", sessionHandle: "parle_ses_live", agentSessionId: "as-live", expiresAt: "2999-01-01T00:00:00Z" });
  await assert.rejects(() => client.openWakeStream(), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.retryable, true);
    return true;
  });
});

test("healthy shared-client sessions ignore ambient disk binding changes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-client-live-binding-"));
  try {
    writeFileSync(join(cwd, ".env"), "PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=old-token\n");
    const seen = [];
    const client = new ParleAgentClient({
      cwd,
      env: {},
      fetch: async (url, init = {}) => {
        const path = String(url);
        seen.push({ path, authorization: init.headers?.Authorization });
        if (path.endsWith("/v/agent/sessions")) return json({ agent_session_id: "as-live", session_credential: "parle_ses_live", expires_at: "2999-01-01T00:00:00Z" }, 201);
        if (path.endsWith("/participants")) return json({ participant_id: "p-live" }, 201);
        if (path.includes("/projection")) return json({ watermark: 0, messages: [] });
        if (path.endsWith("/probe")) return json({ ok: true });
        throw new Error(`unexpected ${path}`);
      },
    });
    await client.connect();
    writeFileSync(join(cwd, ".env"), "PARLE_ROOM_ID=room-2\nPARLE_ROOM_AGENT_TOKEN=new-token\n");
    assert.equal(await client.ensureReadySafe(), false);
    assert.equal(client.cfg.roomId?.value, "room-1");
    await client.requestJson("/probe");
    assert.equal(seen.at(-1).authorization, "Bearer old-token");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("unknown bootstrap transport failures retain a bounded automatic retry gate", async () => {
  let requests = 0;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "token" },
    now: () => new Date("2026-01-01T00:00:00Z"),
    fetch: async () => {
      requests += 1;
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(await client.ensureReadySafe(), true);
  assert.equal(client.runtime.nextRetryAt, "2026-01-01T00:00:05.000Z");
  assert.equal(await client.ensureReadySafe(), false);
  assert.equal(requests, 1);
  assert.equal(client.runtime.terminalCause, undefined);
});

test("disk credential rotation clears the automatic client latch and a retry gate stays exact", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-client-auto-latch-"));
  try {
    writeFileSync(join(cwd, ".env"), "PARLE_ROOM_AGENT_TOKEN=old-token\n");
    let nowMs = Date.parse("2026-01-01T00:00:00Z");
    let sessions = 0;
    const client = new ParleAgentClient({
      cwd,
      env: { PARLE_ROOM_ID: "room-1" },
      now: () => new Date(nowMs),
      fetch: async (url, init = {}) => {
        const path = String(url);
        if (path.endsWith("/v/agent/sessions")) {
          sessions += 1;
          if (sessions === 1) return json({ error: { code: "rate_limited", message: "wait", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: 2500 } }, 429);
          if (init.headers.Authorization === "Bearer old-token") return json({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token" } }, 401);
          return json({ agent_session_id: "as-1", session_credential: "parle_ses_new", expires_at: "later" }, 201);
        }
        if (path.endsWith("/participants")) return json({ participant_id: "p-1" }, 201);
        if (path.includes("/projection")) return json({ watermark: 0, messages: [] });
        throw new Error(`unexpected ${path}`);
      },
    });
    await client.ensureReadySafe();
    assert.equal(client.runtime.nextRetryAt, "2026-01-01T00:00:02.500Z");
    await client.ensureReadySafe();
    assert.equal(sessions, 1, "a closed 429 gate must not extend itself");
    nowMs += 2500;
    await client.ensureReadySafe();
    assert.equal(client.runtime.terminalCause?.streak, 1, "the next admitted terminal fault starts the terminal streak");
    writeFileSync(join(cwd, ".env"), "PARLE_ROOM_AGENT_TOKEN=new-token\n");
    await client.ensureReadySafe();
    assert.equal(client.runtime.bootstrapped, true);
    assert.equal(client.runtime.terminalCause, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// --- Multi-room configuration (issue #63 S1) ---

function roomSetProject(catalog, env = {}) {
  const home = mkdtempSync(join(tmpdir(), "parle-roomset-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-roomset-project-"));
  mkdirSync(join(home, ".parle"), { mode: 0o700 });
  writeFileSync(join(home, ".parle", "profiles"), catalog, { mode: 0o600 });
  return { home, cwd, env: { HOME: home, ...env }, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}

const TWO_ROOM_CATALOG = "[alpha]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_alpha\n\n[beta]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_beta\n";

test("PARLE_PROFILES resolves an explicit ordered room set", () => {
  const project = roomSetProject(TWO_ROOM_CATALOG, { PARLE_PROFILES: "alpha, beta" });
  try {
    const set = resolveRoomSet(project.cwd, project.env);
    assert.equal(set.mode, "multi");
    assert.deepEqual(set.rooms.map((room) => room.profile.value), ["alpha", "beta"]);
    assert.deepEqual(set.rooms.map((room) => room.roomId.value), ["019f2946-aef5-77ad-a41d-747ce0fd6a1e", "019f7b46-178f-7a5a-9f7b-b4af2e045261"]);
    assert.deepEqual(set.rooms.map((room) => room.agentToken.value), ["parle_agt_alpha", "parle_agt_beta"]);
  } finally {
    project.cleanup();
  }
});

test("an empty PARLE_PROFILES is treated as unset, a separator-only one is not", () => {
  const empty = roomSetProject(TWO_ROOM_CATALOG, { PARLE_PROFILES: "", PARLE_PROFILE: "alpha" });
  try {
    // Config resolution treats "" as absent everywhere; an exported-but-empty
    // variable must not fail a session that is otherwise configured.
    const set = resolveRoomSet(empty.cwd, empty.env);
    assert.equal(set.mode, "single");
    assert.equal(set.rooms[0].roomId.value, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
  } finally {
    empty.cleanup();
  }
});

test("an unset PARLE_PROFILES keeps single-room resolution unchanged", () => {
  const project = roomSetProject(TWO_ROOM_CATALOG, { PARLE_PROFILE: "alpha" });
  try {
    const set = resolveRoomSet(project.cwd, project.env);
    assert.equal(set.mode, "single");
    assert.equal(set.rooms.length, 1);
    assert.equal(set.rooms[0].roomId.value, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
  } finally {
    project.cleanup();
  }
});

test("PARLE_PROFILES rejects unsafe configuration before any network activity", () => {
  const cases = [
    [{ PARLE_PROFILES: "alpha,beta", PARLE_PROFILE: "alpha" }, /conflicts with PARLE_PROFILE/],
    [{ PARLE_PROFILES: "alpha,beta", PARLE_ROOM_ID: "019f2946-aef5-77ad-a41d-747ce0fd6a1e" }, /conflicts with direct room configuration/],
    [{ PARLE_PROFILES: " , " }, /names no profiles/],
    [{ PARLE_PROFILES: "," }, /names no profiles/],
    [{ PARLE_PROFILES: "alpha,alpha" }, /more than once/],
    [{ PARLE_PROFILES: "alpha,missing" }, /missing/],
  ];
  for (const [env, expected] of cases) {
    const project = roomSetProject(TWO_ROOM_CATALOG, env);
    try {
      assert.throws(() => resolveRoomSet(project.cwd, project.env), expected, JSON.stringify(env));
    } finally {
      project.cleanup();
    }
  }
});

test("PARLE_PROFILES rejects duplicate rooms and mixed origins", () => {
  const duplicateRoom = roomSetProject("[alpha]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_alpha\n\n[clone]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_clone\n", { PARLE_PROFILES: "alpha,clone" });
  try {
    assert.throws(() => resolveRoomSet(duplicateRoom.cwd, duplicateRoom.env), /same room/);
  } finally {
    duplicateRoom.cleanup();
  }
  const mixed = roomSetProject("[alpha]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_alpha\n\n[beta]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_beta\napi_base = https://api.staging.parle.sh\n", { PARLE_PROFILES: "alpha,beta" });
  try {
    assert.throws(() => resolveRoomSet(mixed.cwd, mixed.env), /mixes Parle origins/);
  } finally {
    mixed.cleanup();
  }
});

function twoRoomClient(options = {}) {
  const project = roomSetProject(TWO_ROOM_CATALOG, { PARLE_PROFILES: "alpha,beta" });
  const alpha = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const beta = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const auth = init.headers?.Authorization;
    calls.push([init.method || "GET", path, auth]);
    if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
      return json({ agent_session_id: "as-shared", session_credential: "parle_ses_shared", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: "@p.a.shared" }, 201);
    }
    if (path.endsWith("/participants")) {
      const room = path.includes(alpha) ? "alpha" : "beta";
      if (options.denyEntry === room) return json({ error: { code: "forbidden", message: "no seat", action: "fix_client", scope: "request" } }, 403);
      if (options.sessionDeny === room) return json({ error: { code: "agent_mismatch", message: "session not valid here", action: "rebootstrap", scope: "agent_session" } }, 403);
      return json({ participant_id: `part-${room}`, room_handle: `${room}-room` }, 201);
    }
    if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
    if (path.includes("/projection")) return json({ watermark: path.includes(alpha) ? 10 : 20, messages: [] });
    if (path.includes("/inbound")) return json({ watermark: path.includes(alpha) ? 11 : 21, messages: [{ seq: path.includes(alpha) ? 11 : 21, event_id: `e-${path.includes(alpha) ? "alpha" : "beta"}` }] });
    if (path.endsWith("/messages")) return json({ seq: 99, event_id: "sent" }, 201);
    if (path.endsWith("/affordances")) return json({ affordances: [] });
    if (path.endsWith("/end")) return new Response(null, { status: 204 });
    throw new Error(`unexpected ${path}`);
  };
  const client = new ParleAgentClient({ cwd: project.cwd, env: project.env, fetch });
  return { client, calls, alpha, beta, cleanup: project.cleanup };
}

test("one session enters every configured room with that room's own bearer", async () => {
  const harness = twoRoomClient();
  try {
    await harness.client.connect();
    const entries = harness.calls.filter(([, path]) => path.endsWith("/participants"));
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map(([, , auth]) => auth), ["Bearer parle_agt_alpha", "Bearer parle_agt_beta"]);
    assert.equal(harness.calls.filter(([, path]) => path === "/v/agent/sessions").length, 1, "one shared roomless session");
    const status = harness.client.status();
    assert.deepEqual(status.rooms.map((room) => [room.profile, room.state, room.cursor]), [["alpha", "ready", 10], ["beta", "ready", 20]]);
  } finally {
    harness.cleanup();
  }
});

test("multi-room room-scoped calls fail closed without roomId and never cross bearers", async () => {
  const harness = twoRoomClient();
  try {
    await harness.client.connect();
    await assert.rejects(harness.client.readInbox(), /roomId is required/);
    await assert.rejects(harness.client.readInbox({ roomId: "019f0000-0000-7000-8000-000000000000" }), /is not configured/);
    const inbox = await harness.client.readInbox({ roomId: harness.beta });
    assert.equal(inbox.roomId, harness.beta);
    assert.equal(inbox.cursorAfter, 21);
    assert.equal(harness.client.roomRuntime(harness.alpha).cursor, 10, "another room's cursor never moves");
    const beta = harness.calls.filter(([, path, auth]) => path.includes(harness.beta) && auth);
    assert.ok(beta.every(([, , auth]) => auth === "Bearer parle_agt_beta"));
    const sent = await harness.client.send({ body: "hello", roomId: harness.alpha });
    assert.equal(sent.roomId, harness.alpha);
    assert.deepEqual(harness.calls.at(-1), ["POST", `/v/rooms/${harness.alpha}/messages`, "Bearer parle_agt_alpha"]);
  } finally {
    harness.cleanup();
  }
});

test("eager multi-room bootstrap succeeds without reinjecting a profile selector conflict", async () => {
  const harness = twoRoomClient();
  try {
    // ensureReadySafe re-resolves configuration before bootstrapping. In
    // multi-room mode that re-resolution must run against PARLE_PROFILES
    // alone; reinjecting the bearer room's profile as PARLE_PROFILE made
    // every automatic bootstrap fail the selector conflict while explicit
    // connect still worked, so hook-bridge hosts never armed on startup.
    const attempted = await harness.client.ensureReadySafe();
    assert.equal(attempted, true);
    assert.equal(harness.client.runtime.bootstrapped, true);
    assert.deepEqual(harness.client.runtime.rooms.map((room) => room.state), ["ready", "ready"]);
  } finally {
    harness.cleanup();
  }
});

test("an ordinary room denial degrades only that room", async () => {
  const harness = twoRoomClient({ denyEntry: "beta" });
  try {
    await harness.client.connect();
    const status = harness.client.status();
    assert.deepEqual(status.rooms.map((room) => room.state), ["ready", "degraded"]);
    assert.match(status.rooms[1].lastError, /no seat/);
    const inbox = await harness.client.readInbox({ roomId: harness.alpha });
    assert.equal(inbox.cursorAfter, 11, "the healthy room keeps serving");
  } finally {
    harness.cleanup();
  }
});

test("a session-scope entry rejection aborts the whole configured set", async () => {
  const harness = twoRoomClient({ sessionDeny: "beta" });
  try {
    await assert.rejects(harness.client.connect(), /aborted the whole configured room set/);
    assert.equal(harness.client.runtime.bootstrapped, false);
  } finally {
    harness.cleanup();
  }
});

test("live profile switching fails closed in multi-room mode", async () => {
  const harness = twoRoomClient();
  try {
    await harness.client.connect();
    await assert.rejects(harness.client.switchProfile("alpha"), /unavailable while PARLE_PROFILES configures 2 rooms/);
  } finally {
    harness.cleanup();
  }
});

test("a profile switch and data-plane calls cannot interleave across a rebinding", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-serialize-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-serialize-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), ALIAS_CATALOG, { mode: 0o600 });
    const order = [];
    let releaseTargetSession;
    const targetGate = new Promise((resolve) => { releaseTargetSession = resolve; });
    const fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const target = init.headers?.Authorization === "Bearer parle_agt_target";
      if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
        if (target) await targetGate;
        return json({ agent_session_id: target ? "as-target" : "as-old", session_credential: target ? "parle_ses_target" : "parle_ses_old", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: target ? "@p.a.target" : "@p.a.old" }, 201);
      }
      if (path.endsWith("/participants")) return json({ participant_id: "p-1", room_handle: target ? "target-room" : "old-room" }, 201);
      if (path.includes("/projection")) return json({ watermark: 1, messages: [] });
      if (path.includes("/inbound")) { order.push(["read", init.headers?.Authorization]); return json({ watermark: 2, messages: [] }); }
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    };
    const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILE: "default" }, fetch });
    await client.connect();
    const switching = client.switchProfile("target");
    // The read is issued while the switch is mid-preparation. It must not land
    // between the room rebinding and its publication.
    const reading = client.readInbox().then(() => order.push(["read-resolved", client.cfg.roomId.value]));
    releaseTargetSession();
    await Promise.all([switching, reading]);
    assert.deepEqual(order.at(-1), ["read-resolved", "019f7b46-178f-7a5a-9f7b-b4af2e045261"]);
    assert.deepEqual(order.filter(([kind]) => kind === "read").map(([, auth]) => auth), ["Bearer parle_agt_target"], "the read used the committed binding, never a half-swapped one");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a session that cannot reclaim its configured alias reports an actionable warning", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-alias-recovery-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-alias-recovery-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), ALIAS_CATALOG, { mode: 0o600 });
    const client = new ParleAgentClient({
      cwd,
      env: { HOME: home, PARLE_PROFILE: "default", PARLE_SESSION_ALIAS: "main" },
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") return json({ agent_session_id: "as-1", session_credential: "parle_ses_1", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z", address: "@p.a.handle" }, 201);
        if (path.endsWith("/participants")) return json({ participant_id: "p-1", room_handle: "old-room" }, 201);
        if (path.includes("/projection")) return json({ watermark: 1, messages: [] });
        if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
        if (path === "/v/agent/session-aliases/main") return json({ alias: "main", generation: 1, current_agent_session_id: "someone-else" });
        // The server reports a different route than the one this process
        // configured. A replacement process must not treat that as success.
        if (path.endsWith("/claim-alias")) return json({ agent_session_id: "as-1", alias: "other", created_at: "2026-08-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00Z" });
        if (path.endsWith("/end")) return new Response(null, { status: 204 });
        throw new Error(`unexpected ${path}`);
      },
    });
    await client.connect();
    const warning = client.status().warnings.find((entry) => entry.includes("durable alias"));
    assert.match(warning || "", /did not reclaim its configured durable alias main/);
    assert.match(warning || "", /holds other instead/);
    assert.match(warning || "", /reconnect/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a durable alias from persistent configuration warns about route takeover", () => {
  const cwd = mkdtempSync(join(tmpdir(), "parle-alias-source-"));
  const home = mkdtempSync(join(tmpdir(), "parle-alias-source-home-"));
  try {
    writeFileSync(join(cwd, ".env"), "PARLE_ROOM_ID=019f2946-aef5-77ad-a41d-747ce0fd6a1e\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_SESSION_ALIAS=main\n");
    const persistent = resolveConfig(cwd, { HOME: home });
    assert.equal(persistent.sessionAlias.source, ".env");
    assert.match(persistent.warnings.join(" "), /every process started here takes over that named route/);
    // The process environment is the deliberate, per-launch way to claim one.
    const explicit = resolveConfig(cwd, { HOME: home, PARLE_SESSION_ALIAS: "main" });
    assert.equal(explicit.sessionAlias.source, "env");
    assert.equal(explicit.warnings.some((warning) => warning.includes("takes over that named route")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a caller-side request error never latches the session's automatic work", async () => {
  // An omitted roomId is a mistake in one call. Latching the binding on it
  // would stop the wake stream for the whole session, which is how a
  // two-room production dogfood lost all responsive delivery.
  const harness = twoRoomClient();
  try {
    await harness.client.connect();
    await assert.rejects(harness.client.readInbox(), /roomId is required/);
    await assert.rejects(harness.client.readInbox({ roomId: "019f0000-0000-7000-8000-000000000000" }), /is not configured/);
    assert.equal(harness.client.status().runtime.terminalCause, undefined, "a request-scoped error is not a terminal cause");
    // The session's automatic wake stream must still open.
    const stream = await harness.client.openWakeStream();
    assert.equal(stream.status, 200);
    await stream.body?.cancel().catch(() => undefined);
    // And room-explicit work still succeeds.
    const inbox = await harness.client.readInbox({ roomId: harness.beta });
    assert.equal(inbox.roomId, harness.beta);
  } finally {
    harness.cleanup();
  }
});

test("switchSessionAlias claims a durable alias with commit-guard, synthesis, and preserved cursor", async () => {
  const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const home = mkdtempSync(join(tmpdir(), "parle-alias-switch-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-alias-switch-project-"));
  let creates = 0;
  const ended = [];
  const guards = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
      creates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-${creates}`, session_credential: `parle_ses_${creates}`, session_handle: `raw-${creates}`, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    }
    if (path.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: `p-${creates}`, room_handle: "alias-room" }), { status: 201 });
    if (path.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
    if (path.startsWith("/v/agent/session-aliases/")) {
      return new Response(JSON.stringify({ alias: path.split("/").at(-1), generation: 1, current_agent_session_id: "prior" }), { status: 200 });
    }
    if (path.endsWith("/claim-alias")) {
      const alias = JSON.parse(String(init.body)).alias;
      return new Response(JSON.stringify({ agent_session_id: `as-${creates}`, alias, generation: 2, expires_at: "2099-01-01T00:00:00Z" }), { status: 200 });
    }
    if (path.includes("/responsive-delivery")) return new Response(JSON.stringify({ delivery: { cursor_scope: "alias" }, messages: [] }), { status: 200 });
    if (path.endsWith("/end")) {
      ended.push(path.split("/").at(-2));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${path}`);
  };
  const client = new ParleAgentClient({
    cwd,
    env: { HOME: home, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "parle_agt_alias" },
    fetch: fetchImpl,
    // The host knows its principal/agent handles; the server responses above
    // deliberately omit an address so synthesis is the only source.
    synthesizeSessionAddress: (route, serverAddress) => {
      const path = route.alias || route.sessionHandle;
      return path ? `@p.a.${path}` : serverAddress;
    },
  });
  const unsubscribe = client.onBeforeSessionCommit((plan) => guards.push(plan.reason));
  try {
    await client.connect();
    assert.equal(client.runtime.sessionAddress, "@p.a.raw-1", "an omitted server address is synthesized from the session route");
    client.roomRuntime(ROOM).cursor = 14;

    const first = await client.switchSessionAlias("workshop");
    assert.equal(first.alias, "workshop");
    assert.equal(first.generation, 2);
    assert.equal(first.sessionAddress, "@p.a.workshop");
    assert.equal(first.warning, undefined, "the first claim replaces nothing");
    assert.equal(client.roomRuntime(ROOM).cursor, 14, "an alias switch preserves the room cursor");
    assert.ok(guards.includes("alias_switch"), "the pre-claim commit guard sees the alias switch");
    // parle-adapters#115: an anonymous live session claims IN PLACE. Replacing
    // it would end the exact-session reply-route target and rotate every
    // participant row (parlehq/parle#797).
    assert.equal(creates, 1, "an anonymous claim mints no candidate session");
    assert.equal(client.runtime.agentSessionId, "as-1", "the live session survives its own claim");
    assert.deepEqual(ended, [], "an in-place claim retires nothing");

    const second = await client.switchSessionAlias("standup");
    assert.equal(second.priorAlias, "workshop");
    assert.match(second.warning, /left the alias workshop/);
    assert.equal(creates, 2, "an aliased predecessor keeps the candidate machinery");
    assert.deepEqual(ended, [], "an aliased predecessor is never retired by the client");
    await assert.rejects(client.switchSessionAlias("BAD ALIAS"), /unreserved 2-32 character/);
    await assert.rejects(client.switchSessionAlias("system"), /unreserved 2-32 character/);
    await assert.rejects(client.switchSessionAlias("abcdefghijklmno2"), /anonymous 16-character session shape/);
  } finally {
    unsubscribe();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// parle-adapters#115 acceptance: the in-place branch keeps the candidate
// path's fail-closed edge, recovers a lost claim response authoritatively,
// publishes exactly one revision, and leaves rollover claiming the runtime
// alias on the next genuine incarnation replacement.
test("in-place alias claim preserves the live session and its fences", async () => {
  const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const home = mkdtempSync(join(tmpdir(), "parle-alias-inplace-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-alias-inplace-project-"));
  let creates = 0;
  let claims = 0;
  let entries = 0;
  let wakes = 0;
  let aliasFactsCalls = 0;
  let failFirstClaim = false;
  const ended = [];
  const claimedAliases = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v/agent/sessions" && (init.method || "GET") === "POST") {
      creates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-${creates}`, session_credential: `parle_ses_${creates}`, session_handle: `raw-${creates}`, expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    }
    if (path === "/v/agent/sessions") {
      // Inventory confirmation for lost-response recovery.
      return new Response(JSON.stringify({ sessions: [{ agent_session_id: "as-1", alias: "workshop", generation: 2 }], next: null }), { status: 200 });
    }
    if (path.endsWith("/participants")) {
      entries += 1;
      return new Response(JSON.stringify({ participant_id: `p-${creates}`, room_handle: "alias-room" }), { status: 201 });
    }
    if (path.includes("/projection")) return new Response(JSON.stringify({ watermark: 3, messages: [] }), { status: 200 });
    if (path === "/v/agent/wake") {
      wakes += 1;
      return new Response(": ready\n\n", { status: 200 });
    }
    if (path.startsWith("/v/agent/session-aliases/")) {
      aliasFactsCalls += 1;
      const alias = path.split("/").at(-1);
      // After a swallowed claim response the durable fence already shows the
      // live session as the generation-2 owner.
      if (failFirstClaim && claims > 0) {
        return new Response(JSON.stringify({ alias, generation: 2, current_agent_session_id: "as-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ alias, generation: 1, current_agent_session_id: "prior" }), { status: 200 });
    }
    if (path.endsWith("/claim-alias")) {
      claims += 1;
      claimedAliases.push(JSON.parse(String(init.body)).alias);
      if (failFirstClaim) return new Response(null, { status: 500 });
      return new Response(JSON.stringify({ agent_session_id: "as-1", alias: JSON.parse(String(init.body)).alias, generation: 2, expires_at: "2099-01-01T00:00:00Z" }), { status: 200 });
    }
    if (path.includes("/responsive-delivery")) return new Response(JSON.stringify({ delivery: { cursor_scope: "alias" }, messages: [] }), { status: 200 });
    if (path.endsWith("/end")) {
      ended.push(path.split("/").at(-2));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${path}`);
  };
  const client = new ParleAgentClient({
    cwd,
    env: { HOME: home, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "parle_agt_inplace" },
    fetch: fetchImpl,
    synthesizeSessionAddress: (route, serverAddress) => {
      const path = route.alias || route.sessionHandle;
      return path ? `@p.a.${path}` : serverAddress;
    },
  });
  const revisions = [];
  const offRevision = client.onSessionRevision((event) => revisions.push(event));
  try {
    await client.connect();
    const entriesAfterConnect = entries;
    const wakesAfterConnect = wakes;

    // A commit-guard rejection is proven to precede the claim request.
    const deferral = client.onBeforeSessionCommit(() => { throw new Error("deferred by test guard"); });
    await assert.rejects(client.switchSessionAlias("workshop"), /deferred by test guard/);
    deferral();
    assert.equal(claims, 0, "a rejected commit guard sends no claim request");
    assert.equal(client.runtime.sessionAlias, undefined, "a rejected switch leaves the session anonymous");
    assert.equal(client.runtime.agentSessionId, "as-1", "a rejected switch leaves the live session untouched");

    // Lost-response recovery resolves against the durable alias fence and
    // still commits in place.
    failFirstClaim = true;
    const result = await client.switchSessionAlias("workshop");
    assert.equal(result.alias, "workshop");
    assert.equal(result.generation, 2);
    assert.equal(result.sessionAddress, "@p.a.workshop");
    assert.equal(client.runtime.agentSessionId, "as-1", "recovery confirms the same live session");
    assert.equal(creates, 1, "no candidate session exists anywhere in the flow");
    assert.equal(entries, entriesAfterConnect, "no room re-entry happens on an in-place claim");
    assert.equal(wakes, wakesAfterConnect, "the open wake stream is never replaced");
    assert.deepEqual(ended, [], "nothing is retired");
    assert.equal(revisions.filter((event) => event.reason === "alias_switch").length, 1, "exactly one revision publishes");
    assert.ok(aliasFactsCalls >= 2, "recovery consulted the durable alias fence");

    // The next genuine incarnation replacement re-claims the runtime alias.
    failFirstClaim = false;
    await client.performProactiveRollover();
    assert.equal(creates, 2, "rollover still replaces the incarnation");
    assert.equal(claimedAliases.at(-1), "workshop", "rollover re-claims the runtime alias, not the configured one");
  } finally {
    offRevision();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
