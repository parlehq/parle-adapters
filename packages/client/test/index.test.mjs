import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findForbiddenImports } from "../scripts/check-boundaries.mjs";
import {
  DEFAULT_VERSION,
  ERROR_ACTIONS,
  ERROR_REGISTRY,
  ERROR_SCOPES,
  ParleAgentClient,
  formatVersionErrorHint,
  addressingWarning,
  assertSafeBase,
  capProjectionMessages,
  clampWaitSeconds,
  compactServerWrappedContent,
  parseKeyValueFile,
  parseSSEBlocks,
  performProfileSwitch,
  redactedSecretValue,
  redactString,
  resolveConfig,
  responsiveDeliveryKey,
  summarizeSendDelivery,
  terminalStatusFor,
  updateCursorFromMessages,
} from "../dist/index.js";

test("adapter DEFAULT_VERSION stays in lockstep with the pinned core fixture", () => {
  const clientSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const piSrc = readFileSync(new URL("../../pi-extension/src/index.ts", import.meta.url), "utf8");
  const watchScript = readFileSync(new URL("../../claude-plugin/skills/parle/scripts/parle-watch.sh", import.meta.url), "utf8");
  const mcpSrc = readFileSync(new URL("../../mcp-server/src/index.ts", import.meta.url), "utf8");
  const pin = JSON.parse(readFileSync(new URL("../conformance.pin.json", import.meta.url), "utf8"));
  const versionFixture = JSON.parse(readFileSync(new URL(`../conformance/${pin.parle_version}/version.json`, import.meta.url), "utf8"));
  // The whole chain holds by construction: version fixture -> generated
  // conformance-data.ts -> DEFAULT_VERSION -> Pi via client import.
  assert.equal(DEFAULT_VERSION, versionFixture.parle_version);
  assert.equal(DEFAULT_VERSION, pin.parle_version);
  assert.match(clientSrc, /DEFAULT_VERSION = CONFORMANCE_PARLE_VERSION/);
  assert.match(piSrc, /DEFAULT_VERSION[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(piSrc, /const DEFAULT_VERSION =/);
  assert.match(watchScript, /--parle-watch/);
  assert.match(mcpSrc, /PARLE_VERSION: config\.version\.value/);
});

test("vendored conformance fixtures match the pin and regenerate cleanly", async () => {
  const { sha256, renderConformanceData } = await import("../../../scripts/sync-conformance.mjs");
  const pin = JSON.parse(readFileSync(new URL("../conformance.pin.json", import.meta.url), "utf8"));
  assert.equal(pin.fixture_schema_version, 1);
  assert.match(pin.core_ref, /^[0-9a-f]{40}$/);
  const dir = new URL(`../conformance/${pin.parle_version}/`, import.meta.url);
  for (const [path, expected] of Object.entries(pin.files)) {
    assert.equal(sha256(readFileSync(new URL(path, dir))), expected, `pin hash mismatch for ${path}`);
  }
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
  assert.equal(manifest.parle_version, pin.parle_version);
  assert.equal(manifest.fixture_schema_version, pin.fixture_schema_version);
  for (const fixture of manifest.fixtures) assert.equal(pin.files[fixture.path], fixture.sha256);
  const generated = readFileSync(new URL("../src/conformance-data.ts", import.meta.url), "utf8");
  const rendered = renderConformanceData(
    readFileSync(new URL("version.json", dir), "utf8"),
    readFileSync(new URL("token-classes.json", dir), "utf8"),
  );
  assert.equal(generated, rendered, "src/conformance-data.ts is stale; re-run scripts/sync-conformance.mjs");
});

test("redaction follows the core conformance corpus", () => {
  const pin = JSON.parse(readFileSync(new URL("../conformance.pin.json", import.meta.url), "utf8"));
  const tokens = JSON.parse(readFileSync(new URL(`../conformance/${pin.parle_version}/token-classes.json`, import.meta.url), "utf8"));
  for (const cls of tokens.token_classes) {
    for (const example of cls.examples) {
      assert.equal(redactString(example.input), example.expected, `token class ${cls.name}`);
    }
  }
  for (const example of tokens.protocol_redaction_examples) {
    assert.equal(redactString(example.input), example.expected, `protocol example: ${example.input}`);
  }
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

test("config resolves env before files and redacts tokens", () => {
  const cfg = resolveConfig(process.cwd(), {
    PARLE_ROOM_ID: "room-1",
    PARLE_ROOM_AGENT_TOKEN: "parle_agt_secret",
  });
  assert.equal(cfg.roomId?.value, "room-1");
  assert.equal(cfg.agentToken?.source, "env");
  assert.equal(redactString("Authorization: Bearer parle_agt_secret"), "Authorization: Bearer <redacted>");
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
    assert.equal(defaultCfg.version.value, "2026-07-07");
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
    assert.equal(cleanCfg.version.value, "2026-07-07");
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

test("safe base rejects non-Parle hosts unless loopback opt-in is set", () => {
  assert.doesNotThrow(() => assertSafeBase("https://api.parle.sh"));
  assert.throws(() => assertSafeBase("http://evil.example"));
  assert.throws(() => assertSafeBase("https://evilparle.sh"));
  assert.doesNotThrow(() => assertSafeBase("http://localhost:3000", { PARLE_ALLOW_INSECURE_LOCAL: "1" }));
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
  assert.equal(calls[1].url, "http://localhost:3000/v/rooms/room-1/responsive-delivery?wait=0");
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

test("addressing warning fires only for body mentions without structured to", () => {
  assert.match(addressingWarning("@gilman.agent hello"), /will not wake/);
  assert.equal(addressingWarning("@gilman.agent hello", "@gilman.agent.session"), undefined);
});

test("send delivery summary classifies moderation envelopes", () => {
  assert.deepEqual(summarizeSendDelivery({ seq: 7, moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending", reason: "awaiting moderation completion" } }), {
    state: "accepted_scan_skipped",
    message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
  });
  const held = summarizeSendDelivery({ seq: 8, moderation: { held: true, delivered: false, scan: "queued", steps: [{ name: "scan" }], verdict: "pending", reason: "awaiting scan" } });
  assert.equal(held.state, "held_for_moderation");
  assert.equal(held.message, "awaiting scan");
  assert.match(held.nextStep, /seq 8/);
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivered: true } }), { state: "delivered", message: "Message accepted and delivered." });
  assert.equal(Object.hasOwn({ event_id: "evt-1" }, "deliveryStatus"), false);
  assert.equal(summarizeSendDelivery({ event_id: "evt-1" }), undefined);
});

test("wrapped content compacts only exact same-response framing", () => {
  const preamble = "trusted";
  const content = "trusted\n«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
  assert.equal(compactServerWrappedContent(content, preamble, "ABC"), "«FENCE BEGIN ABC»\nhello\n«FENCE END ABC»");
  assert.equal(compactServerWrappedContent(content, "wrong", "ABC"), content);
  assert.equal(compactServerWrappedContent(content.replace("trusted\n", "trusted\n\n"), preamble, "ABC"), content.replace("trusted\n", "trusted\n\n"));
});

test("requestJson sends low-cardinality client identity headers", async () => {
  let observed;
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    publishRuntime: { adapterName: "@parlehq/test-adapter", adapterVersion: "1.2.3" },
    fetch: async (_url, init = {}) => {
      observed = init.headers;
      return json({ ok: true });
    },
  });
  await client.requestJson("/v/test");
  assert.equal(observed["Parle-Client-Name"], "@parlehq/test-adapter");
  assert.equal(observed["Parle-Client-Version"], "1.2.3");
});

test("unsupported version errors include source, default, and server versions", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token", PARLE_VERSION: "bad-version" },
    fetch: async () => json({ error: { code: "unsupported_parle_version", message: "unsupported Parle-Version header", supported: ["2026-07-07"], current: "2026-07-07" } }, 400),
  });
  await assert.rejects(
    () => client.requestJson("/v/test"),
    /Sent Parle-Version bad-version from env; adapter default is 2026-07-07\. Server supports 2026-07-07\. Unset the stale PARLE_VERSION override or upgrade the adapter\./,
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
      if (u.includes("/messages")) return json({ event_id: "evt-1", seq: 5, replayed: false, moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending" } }, 201);
      return json({});
    },
  });
  const inbox = await client.readInbox({ waitSeconds: 2 });
  assert.equal(inbox.cursorAfter, 4);
  const sent = await client.send({ body: "hello", to: "@p.a.s1" });
  assert.equal(sent.idempotencyKey, "idem-1");
  assert.equal(sent.deliveryStatus.state, "accepted_scan_skipped");
  assert.equal(requests.some((r) => r.url.includes("/inbound?since_seq=3&wait=2")), true);
  const sendReq = requests.find((r) => r.url.includes("/messages"));
  assert.equal(sendReq.init.headers["Idempotency-Key"], "idem-1");
  assert.equal(JSON.parse(sendReq.init.body).payload.turn, undefined);
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
  assert.equal(client.runtime.cursor, 12);
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
  assert.equal(client.runtime.cursor, 21);
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
  assert.equal(client.runtime.cursor, 33);
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
  assert.equal(client.runtime.cursor, 44);
});

test("send maps bootstrap setup errors into structured send failure", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1" },
    randomUUID: () => "idem-setup-needed",
  });
  const result = await client.send({ body: "hello" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.idempotencyKey, "<redacted>");
  assert.match(result.error, /PARLE_ROOM_AGENT_TOKEN is missing/);
});

test("shared error contract matches the pinned core error-registry fixture", () => {
  const pin = JSON.parse(readFileSync(new URL("../conformance.pin.json", import.meta.url), "utf8"));
  const fixture = JSON.parse(readFileSync(new URL(`../conformance/${pin.parle_version}/error-registry.json`, import.meta.url), "utf8"));
  const registry = Object.fromEntries(fixture.errors.map(({ code, ...spec }) => [code, spec]));
  assert.deepEqual(ERROR_REGISTRY, registry);
  // The fixture carries per-error facts; every action/scope it uses must be a
  // member of the shared closed sets.
  for (const entry of fixture.errors) {
    assert.equal(ERROR_ACTIONS.includes(entry.action), true, `unknown action ${entry.action}`);
    assert.equal(ERROR_SCOPES.includes(entry.scope), true, `unknown scope ${entry.scope}`);
  }
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

test("requestJson uses Retry-After header when retry_after_ms is absent", async () => {
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: null } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "4" } }),
  });
  await assert.rejects(() => client.requestJson("/v/test", { retry: false }), (error) => {
    assert.equal(error.retryAfterMs, 4000);
    return true;
  });
});

test("requestJson honors Retry-After before retrying retryable GET failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const client = new ParleAgentClient({
    env: { PARLE_ROOM_ID: "room-1", PARLE_ROOM_AGENT_TOKEN: "opaque-token" },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: null } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
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
      if (u.includes("/messages")) return json({ error: { code: "rate_limited", message: "Bearer secret" } }, 429);
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
  assert.equal(first.participantId, "part-1");
  assert.equal(first.cursor, 7);
  assert.equal(first.heldBacklogCount, 2);
  assert.equal(first.roomHandle, "room-handle");
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
      fetch: async () => json({ error: { code: "unauthenticated", message: "missing or invalid credential" } }, 401),
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
    const fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const auth = init.headers?.Authorization;
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
    assert.equal(result.roomId, "019f7b46-178f-7a5a-9f7b-b4af2e045261");
    assert.equal(result.roomHandle, "target-room");
    assert.equal(result.cursor, 42);
    assert.equal(result.watcherRestartRequired, true);
    assert.equal(result.watcherRestarted, false);
    assert.equal(client.status().config.profile.value, "target");
    assert.equal(client.status().runtime.roomHandle, "target-room");
    assert.deepEqual(calls.at(-1), ["end-old", "Bearer parle_agt_old", "parle_ses_old"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("client profile switch refuses configured named-route aliases before scratch bootstrap", async () => {
  const home = mkdtempSync(join(tmpdir(), "parle-profile-alias-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "parle-profile-alias-project-"));
  try {
    mkdirSync(join(home, ".parle"), { mode: 0o700 });
    writeFileSync(join(home, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_old\n\n[target]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_target\n", { mode: 0o600 });
    let called = false;
    const client = new ParleAgentClient({ cwd, env: { HOME: home, PARLE_PROFILE: "default", PARLE_SESSION_ALIAS: "main" }, fetch: async () => { called = true; return json({}); } });
    await assert.rejects(client.switchProfile("target"), /PARLE_SESSION_ALIAS/);
    assert.equal(called, false);
    assert.equal(client.status().config.profile.value, "default");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
    assert.equal(client.runtime.roomId, "019f2946-aef5-77ad-a41d-747ce0fd6a1e");
    assert.equal(client.runtime.roomHandle, "old-room");
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
    assert.throws(() => resolveConfig(cwd, { HOME: home }), /Parle profile shared was not found in .*team-profiles/);
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
  assert.equal(formatVersionErrorHint(cfg, { supported: ["new"], current: "also-new" }), " Sent Parle-Version old from env; adapter default is 2026-07-07. Server supports new. Unset the stale PARLE_VERSION override or upgrade the adapter.");
});
