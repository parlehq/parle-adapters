import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const jitiFactory = req("jiti");
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const mod = jiti("../src/index.ts");
const { __testing } = mod;

function installHarness(cwd) {
  __testing.resetRuntime();
  const tools = {};
  const commands = {};
  const injected = [];
  const pi = {
    on() {},
    registerCommand(name, spec) { commands[name] = spec; },
    registerTool(spec) { tools[spec.name] = spec; },
    sendUserMessage(message) { injected.push(message); },
  };
  mod.default(pi);
  const statuses = [];
  const ctx = { cwd, ui: { setStatus(id, label) { statuses.push({ id, label }); }, notify() {} } };
  return {
    tools,
    commands,
    statuses,
    injected,
    pi,
    ctx,
    cwd,
    call(name, params = {}) {
      return tools[name].execute("tc", params, undefined, undefined, ctx);
    },
  };
}

function clearParleEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PARLE")) delete process.env[key];
  }
}

function tempProject(env = "") {
  clearParleEnv();
  const dir = mkdtempSync(join(tmpdir(), "parle-pi-extension-"));
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  if (env) writeFileSync(join(dir, ".env"), env);
  return dir;
}

test("status reads room and token from project .env and redacts token", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = async () => { throw new Error("offline test"); };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.roomId.set, true);
  assert.equal(status.details.roomId.value, "room-1");
  assert.equal(status.details.agentToken.set, true);
  assert.equal(status.details.agentToken.value, "<redacted>");
});

test("status ignores persisted PARLE_VERSION and warns", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_VERSION=from-dotenv\nPARLE_WATCH_ENABLED=0\n");
  mkdirSync(join(cwd, ".parle"));
  // A legacy credentials file is inert: no reads, no warnings about it.
  writeFileSync(join(cwd, ".parle", "credentials"), "PARLE_VERSION=from-credentials\nPARLE_ROOM_ID=legacy-room\n");
  globalThis.fetch = async () => { throw new Error("offline test"); };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.version.value, "2026-07-07");
  assert.equal(status.details.version.source, "default");
  assert.equal(status.details.roomId.value, "room-1");
  assert.match(status.details.warnings.join("\n"), /Ignoring PARLE_VERSION from project \.env/);
  assert.doesNotMatch(status.details.warnings.join("\n"), /credentials/);
});

test("status resolves explicit and default profiles with shared atomic-mode semantics", async () => {
  const cwd = tempProject("PARLE_PROFILE=work\nPARLE_WATCH_ENABLED=0\n");
  mkdirSync(join(process.env.HOME, ".parle"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".parle", "profiles"), "[work]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_work\n", { mode: 0o600 });
  globalThis.fetch = async () => { throw new Error("offline test"); };
  const status = await installHarness(cwd).call("parle_status");
  assert.equal(status.details.profile.value, "work");
  assert.equal(status.details.roomId.source, "profile:work");
  assert.equal(status.details.agentToken.value, "<redacted>");
  assert.equal(status.details.apiBase.value, "https://api.parle.sh");
  assert.equal(status.details.wakeBase.value, "https://api.parle.sh");

  writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=work\nPARLE_ROOM_ID=stale\n");
  await assert.rejects(installHarness(cwd).call("parle_status"), /PARLE_PROFILE from project_env conflicts with direct configuration/);

  writeFileSync(join(cwd, ".env"), "PARLE_WATCH_ENABLED=0\n");
  writeFileSync(join(process.env.HOME, ".parle", "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_default\n", { mode: 0o600 });
  const defaultStatus = await installHarness(cwd).call("parle_status");
  assert.equal(defaultStatus.details.profile.value, "default");
  assert.equal(defaultStatus.details.roomId.source, "profile:default");
});

test("Pi delegates API error taxonomy and version hints to the agent client", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /ERROR_ACTIONS, ERROR_REGISTRY[^\n]*formatVersionErrorHint[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(source, /function formatVersionErrorHint/);
  assert.doesNotMatch(source, /const ERROR_REGISTRY/);
});

test("Pi shares wire defaults with the agent client", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /DEFAULT_API_BASE, DEFAULT_VERSION[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(source, /const DEFAULT_API_BASE =/);
  assert.doesNotMatch(source, /const DEFAULT_VERSION =/);
});

test("Pi delegates secret redaction to the agent client", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /redactString[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(source, /function redactString/);
});

test("Pi delegates .env parsing to the agent client", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /parseKeyValueFile[^\n]*from "@parlehq\/agent-client"/);
  assert.match(source, /return parseKeyValueFile\(readFileSync\(path, "utf8"\)\);/);
});

test("deployed entrypoint is the committed bundle", () => {
  // The Pi harness loads the committed dist bundle in deployed checkouts
  // (no installs, no builds there); check-pi-artifact.mjs gates freshness.
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const rootManifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/index.js"]);
  assert.deepEqual(rootManifest.pi.extensions, ["./packages/pi-extension/dist/index.js"]);
});

test("status leaves profile unset when the catalog has no default section", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  mkdirSync(join(process.env.HOME, ".parle"), { recursive: true });
  writeFileSync(join(process.env.HOME, ".parle", "profiles"), "[work]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_work\n", { mode: 0o600 });
  globalThis.fetch = async () => { throw new Error("offline test"); };

  const status = await installHarness(cwd).call("parle_status");

  assert.equal(status.details.profile, undefined);
  assert.equal(status.details.roomId.set, false);
  assert.equal(status.details.agentToken.set, false);
});

test("watcher bootstrap failure records status instead of escaping", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_VERSION=bad-version\n");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "unsupported_version", message: "missing or unsupported Parle-Version header" } }), { status: 400 });
  const ctx = { cwd, ui: { setStatus() {} } };
  __testing.startWatcher({ sendUserMessage() {} }, ctx, __testing.resolveConfig(cwd));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const state = __testing.runtimeState();
  assert.equal(state.watcherState, "backoff");
  assert.match(state.lastError, /unsupported Parle-Version/);
});

function installWatcherFailureHarness(heartbeatResponse) {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  let sessionCreates = 0;
  const heartbeatAt = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: "as-watch", session_credential: "parle_ses_watch", expires_at: "2026-07-22T00:00:00Z", address: "@p.a.watch" }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-watch" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/heartbeat")) {
      heartbeatAt.push(Date.now());
      return heartbeatResponse(heartbeatAt.length);
    }
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  return { harness, heartbeatAt, sessionCreates: () => sessionCreates };
}

test("watcher stops after one terminal invalid-token heartbeat", async () => {
  const probe = installWatcherFailureHarness(() => new Response(JSON.stringify({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token", retry_after_ms: null } }), { status: 401 }));

  await probe.harness.call("parle_status");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(probe.sessionCreates(), 1);
  assert.equal(probe.heartbeatAt.length, 1);
  assert.equal(__testing.runtimeState().watcherState, "auth_expired");
});

test("watcher honors 429 Retry-After before a terminal 401 stops it", async () => {
  const probe = installWatcherFailureHarness((attempt) => attempt === 1
    ? new Response(JSON.stringify({ error: { code: "rate_limited", message: "back off", action: "backoff", retryable: true, scope: "rate_limit", retry_after_ms: 30 } }), { status: 429 })
    : new Response(JSON.stringify({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token", retry_after_ms: null } }), { status: 401 }));

  await probe.harness.call("parle_status");
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(probe.heartbeatAt.length, 2);
  assert.ok(probe.heartbeatAt[1] - probe.heartbeatAt[0] >= 25);
  assert.equal(__testing.runtimeState().watcherState, "auth_expired");
});

test("watcher stops on a terminal stop action", async () => {
  const probe = installWatcherFailureHarness(() => new Response(JSON.stringify({ error: { code: "participant_revoked", message: "removed", action: "stop", retryable: false, scope: "room_access", retry_after_ms: null } }), { status: 403 }));

  await probe.harness.call("parle_status");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(probe.heartbeatAt.length, 1);
  assert.equal(__testing.runtimeState().watcherState, "disconnected");
});

test("footer shows x when configured Parle cannot bootstrap", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_HANDLE=galexc-intercom\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_VERSION=bad-version\n");
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "unsupported_version", message: "missing or unsupported Parle-Version header" } }), { status: 400 });
  const harness = installHarness(cwd);
  await harness.call("parle_status");
  assert.equal(harness.statuses.at(-1).label, "parle x check version");
});

test("status bootstraps and redacts session handle", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-1", session_credential: "parle_ses_raw-session", session_handle: "raw-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.raw-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-1", room_id: "room-1", agent_session_id: "as-1" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.runtime.sessionHandle, "<redacted>");
  assert.equal(status.details.runtime.sessionAddress, "@p.a.raw-session");
  assert.equal(harness.statuses.at(-1).label, "#room-room-1 ✓ @p.a.raw-session");
});

test("status publishes a display-safe runtime snapshot", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_HANDLE=galexc-intercom\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-1", session_credential: "parle_ses_raw-session", session_handle: "raw-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.raw-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-1", room_id: "room-1", agent_session_id: "as-1" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  await harness.call("parle_status");
  const snapshot = JSON.parse(readFileSync(join(cwd, ".parle", "runtime", `${process.pid}.json`), "utf8"));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.agentSessionId, "as-1");
  assert.equal(snapshot.sessionAddress, "@p.a.raw-session");
  assert.equal(snapshot.roomId, "room-1");
  assert.equal(snapshot.roomHandle, "galexc-intercom");
  assert.deepEqual(snapshot.adapter, { name: "@parlehq/pi-extension", version: "0.1.29" });
  assert.equal(JSON.stringify(snapshot).includes("parle_ses_raw-session"), false);
});

test("footer prefers alias route when session uses an alias", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_PRINCIPAL_HANDLE=p\nPARLE_AGENT_HANDLE=a\nPARLE_SESSION_ALIAS=parle-landing\nPARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      assert.equal(JSON.parse(String(init.body)).alias, "parle-landing");
      return new Response(JSON.stringify({ agent_session_id: "as-alias", session_credential: "parle_ses_alias-session", session_handle: "raw-session", alias: "parle-landing", generation: 2, expires_at: "2026-07-04T00:00:00Z", address: "@p.a.raw-session" }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-alias", room_id: "room-1", room_handle: "actual-room", agent_session_id: "as-alias" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  const status = await harness.call("parle_status");
  assert.equal(status.details.runtime.sessionAddress, "@p.a.parle-landing");
  assert.equal(status.details.runtime.sessionAlias, "parle-landing");
  assert.equal(status.details.runtime.sessionGeneration, 2);
  assert.equal(status.details.runtime.roomHandle, "actual-room");
  assert.equal(harness.statuses.at(-1).label, "#actual-room ✓ @p.a.parle-landing");
});

test("parle_session_alias moves runtime without persistent config", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\nPARLE_PRINCIPAL_HANDLE=p\nPARLE_AGENT_HANDLE=a\nPARLE_WATCH_ENABLED=0\n");
  let sessionCreates = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const alias = body.alias;
      return new Response(JSON.stringify({ agent_session_id: `as-${sessionCreates}`, session_credential: `parle_ses_session-${sessionCreates}`, session_handle: `raw-${sessionCreates}`, alias, generation: alias ? 3 : 0, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.raw-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/end")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-alias-tool", room_id: "room-1", room_handle: "actual-room" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 9, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);
  await harness.call("parle_status");
  const result = await harness.call("parle_session_alias", { alias: "parle-landing" });
  assert.equal(result.details.sessionAddress, "@p.a.parle-landing");
  assert.equal(result.details.alias, "parle-landing");
  assert.equal(result.details.generation, 3);
  assert.equal(__testing.resolveConfig(cwd).sessionAlias.value, "");
  assert.equal(harness.statuses.at(-1).label, "#actual-room ✓ @p.a.parle-landing");
});

test("parle_switch_profile prepares the target before atomically replacing room state", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const catalogDir = join(process.env.HOME, ".parle");
  mkdirSync(catalogDir, { recursive: true });
  const oldRoom = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const newRoom = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
  writeFileSync(join(catalogDir, "profiles"), `[default]\nroom_id = ${oldRoom}\nagent_token = parle_agt_old\n\n[target]\nroom_id = ${newRoom}\nagent_token = parle_agt_target\n`, { mode: 0o600 });
  const order = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization;
    if (u.endsWith("/v/agent/sessions") && auth === "Bearer parle_agt_old") {
      order.push("old-session");
      return new Response(JSON.stringify({ agent_session_id: "as-old", session_credential: "parle_ses_old", session_handle: "old", expires_at: "later", address: "@p.a.old" }), { status: 201 });
    }
    if (u.endsWith("/v/agent/sessions") && auth === "Bearer parle_agt_target") {
      order.push("target-session");
      return new Response(JSON.stringify({ agent_session_id: "as-target", session_credential: "parle_ses_target", session_handle: "target", expires_at: "later", address: "@p.a.target" }), { status: 201 });
    }
    if (u.endsWith(`/v/rooms/${oldRoom}/participants`)) return new Response(JSON.stringify({ participant_id: "part-old", room_handle: "old-room" }), { status: 201 });
    if (u.endsWith(`/v/rooms/${newRoom}/participants`)) return new Response(JSON.stringify({ participant_id: "part-target", room_handle: "target-room" }), { status: 201 });
    if (u.includes(`/v/rooms/${oldRoom}/inbound`)) return new Response(JSON.stringify({ watermark: 7, messages: [{ seq: 7, event_id: "same-event", participant_id: "old-peer", content: "old room" }] }), { status: 200 });
    if (u.includes(`/v/rooms/${oldRoom}/projection`)) return new Response(JSON.stringify({ watermark: 5, messages: [] }), { status: 200 });
    if (u.includes(`/v/rooms/${newRoom}/projection`)) {
      order.push("target-ready");
      return new Response(JSON.stringify({ watermark: 42, messages: [] }), { status: 200 });
    }
    if (u.endsWith(`/v/rooms/${newRoom}/affordances`)) return new Response(JSON.stringify({ affordances: [{ action: "post_message", allowed: true }] }), { status: 200 });
    if (u.includes(`/v/rooms/${newRoom}/responsive-delivery?`)) return new Response(JSON.stringify({ watermark: 42, messages: [{ seq: 7, event_id: "same-event", participant_id: "new-peer", provenance_author: "new-peer", provenance_kind: "participant", content: "new room" }] }), { status: 200 });
    if (u.endsWith(`/v/rooms/${newRoom}/responsive-delivery/ack`)) return new Response(JSON.stringify({ acked: true }), { status: 200 });
    if (u.endsWith("/v/agent/sessions/as-old/end")) {
      order.push("old-ended");
      assert.equal(auth, "Bearer parle_agt_old");
      assert.equal(init.headers["Parle-Agent-Session"], "parle_ses_old");
      return new Response(JSON.stringify({ ended: true }), { status: 200 });
    }
    throw new Error(`unexpected ${u} ${auth}`);
  };
  const harness = installHarness(cwd);
  await harness.call("parle_status");
  await harness.call("parle_inbox");

  const switched = await harness.call("parle_switch_profile", { profile: "target" });

  assert.equal(switched.details.switched, true);
  assert.equal(switched.details.profile, "target");
  assert.equal(switched.details.roomId, newRoom);
  assert.equal(switched.details.cursor, 42);
  assert.equal(switched.details.sessionAddress, "@p.a.target");
  assert.equal(switched.details.roomHandle, "target-room");
  assert.equal(switched.details.ephemeral, true);
  assert.ok(order.indexOf("target-ready") < order.indexOf("old-ended"));
  const status = await harness.call("parle_status");
  assert.equal(status.details.profile.value, "target");
  assert.equal(status.details.profile.source, "runtime_profile");
  assert.equal(status.details.roomId.value, newRoom);
  assert.equal(status.details.runtime.roomId, newRoom);
  assert.equal(status.details.runtime.roomHandle, "target-room");
  assert.equal(harness.statuses.at(-1).label, "#target-room ✓ @p.a.target");
  const affordances = await harness.call("parle_affordances");
  assert.equal(affordances.details.affordances[0].action, "post_message");
  await __testing.handleWakeHint(harness.pi, harness.ctx, __testing.resolveConfig(cwd));
  assert.equal(harness.injected.length, 1, "same seq/event from old room must not suppress target-room delivery");
  assert.match(JSON.stringify(harness.injected[0]), /new room/);
  assert.equal(readFileSync(join(cwd, ".env"), "utf8"), "PARLE_WATCH_ENABLED=0\n");
});

test("parle_switch_profile refuses an active named route before scratch bootstrap", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const catalogDir = join(process.env.HOME, ".parle");
  mkdirSync(catalogDir, { recursive: true });
  writeFileSync(join(catalogDir, "profiles"), "[default]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_old\n\n[target]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_target\n", { mode: 0o600 });
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(JSON.stringify({})); };
  const harness = installHarness(cwd);
  __testing.patchRuntime({ sessionAlias: "main" });
  await assert.rejects(harness.call("parle_switch_profile", { profile: "target" }), /PARLE_SESSION_ALIAS/);
  assert.equal(called, false);
});

test("live Pi binding refuses naive PARLE_PROFILE edits until parle_switch_profile runs", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const catalogDir = join(process.env.HOME, ".parle");
  mkdirSync(catalogDir, { recursive: true });
  const oldRoom = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const newRoom = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
  writeFileSync(join(catalogDir, "profiles"), `[default]\nroom_id = ${oldRoom}\nagent_token = parle_agt_old\n\n[target]\nroom_id = ${newRoom}\nagent_token = parle_agt_target\n`, { mode: 0o600 });
  let targetCalled = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization;
    if (auth === "Bearer parle_agt_target") targetCalled = true;
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-old", session_credential: "parle_ses_old", expires_at: "later", address: "@p.a.old" }), { status: 201 });
    if (u.endsWith(`/v/rooms/${oldRoom}/participants`)) return new Response(JSON.stringify({ participant_id: "part-old" }), { status: 201 });
    if (u.includes(`/v/rooms/${oldRoom}/projection`)) return new Response(JSON.stringify({ watermark: 5, messages: [] }), { status: 200 });
    throw new Error(`unexpected ${u} ${auth}`);
  };
  const harness = installHarness(cwd);
  await harness.call("parle_status");
  writeFileSync(join(cwd, ".env"), "PARLE_PROFILE=target\nPARLE_WATCH_ENABLED=0\n");

  const status = await harness.call("parle_status");
  assert.equal(status.details.profile.value, "default");
  assert.equal(status.details.roomId.value, oldRoom);
  assert.match(status.details.warnings.join("\n"), /use parle_switch_profile/);
  await assert.rejects(harness.call("parle_affordances"), /Use parle_switch_profile/);
  assert.equal(targetCalled, false);
});

test("parle_switch_profile leaves the live profile intact when target preparation fails", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const catalogDir = join(process.env.HOME, ".parle");
  mkdirSync(catalogDir, { recursive: true });
  const oldRoom = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
  const badRoom = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
  writeFileSync(join(catalogDir, "profiles"), `[default]\nroom_id = ${oldRoom}\nagent_token = parle_agt_old\n\n[bad]\nroom_id = ${badRoom}\nagent_token = parle_agt_bad\n`, { mode: 0o600 });
  let oldEnded = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const auth = init.headers?.Authorization;
    if (u.endsWith("/v/agent/sessions") && auth === "Bearer parle_agt_old") return new Response(JSON.stringify({ agent_session_id: "as-old", session_credential: "parle_ses_old", expires_at: "later", address: "@p.a.old" }), { status: 201 });
    if (u.endsWith("/v/agent/sessions") && auth === "Bearer parle_agt_bad") return new Response(JSON.stringify({ agent_session_id: "as-bad", session_credential: "parle_ses_bad", expires_at: "later", address: "@p.a.bad" }), { status: 201 });
    if (u.endsWith(`/v/rooms/${oldRoom}/participants`)) return new Response(JSON.stringify({ participant_id: "part-old" }), { status: 201 });
    if (u.endsWith(`/v/rooms/${badRoom}/participants`)) return new Response(JSON.stringify({ error: { message: "not admitted" } }), { status: 404 });
    if (u.includes(`/v/rooms/${oldRoom}/projection`)) return new Response(JSON.stringify({ watermark: 5, messages: [] }), { status: 200 });
    if (u.endsWith("/v/agent/sessions/as-bad/end")) return new Response(JSON.stringify({ ended: true }), { status: 200 });
    if (u.endsWith("/v/agent/sessions/as-old/end")) { oldEnded = true; return new Response(JSON.stringify({ ended: true }), { status: 200 }); }
    throw new Error(`unexpected ${u} ${auth}`);
  };
  const harness = installHarness(cwd);
  await harness.call("parle_status");

  await assert.rejects(harness.call("parle_switch_profile", { profile: "bad" }), /not admitted/);

  assert.equal(oldEnded, false);
  const status = await harness.call("parle_status");
  assert.equal(status.details.profile.value, "default");
  assert.equal(status.details.roomId.value, oldRoom);
  assert.equal(status.details.runtime.roomId, oldRoom);
  assert.equal(status.details.runtime.sessionAddress, "@p.a.old");
});

test("status starts watcher after late lazy bootstrap", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-late", session_credential: "parle_ses_late-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.late-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-late", room_id: "room-1", agent_session_id: "as-late" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 7, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery")) return new Response(JSON.stringify({ delivery: { last_acked_seq: 7 }, messages: [] }), { status: 200 });
    if (u.endsWith("/v/agent/wake")) return new Response(": keepalive\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);

  const status = await harness.call("parle_status");
  await new Promise((resolve) => setTimeout(resolve, 25));
  const state = __testing.runtimeState();

  assert.equal(status.details.runtime.sessionAddress, "@p.a.late-session");
  assert.equal(state.watcherStarted, true);
  assert.notEqual(state.watcherState, "off");
  __testing.resetRuntime();
});

test("mutating request requires exact confirmation scope", async () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const harness = installHarness(cwd);
  await assert.rejects(
    harness.call("parle_request", { method: "POST", path: "/v/rooms" }),
    /confirmScope=POST \/v\/rooms/,
  );
  const ok = await harness.call("parle_request", { method: "POST", path: "/v/rooms", confirmMutation: true, confirmScope: "POST /v/rooms", reason: "test" });
  assert.equal(ok.details.ok, true);
});

test("session cookie files fail closed when group or world accessible", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const secretsDir = join(process.env.HOME, ".parle");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "session"), "__Host-parle_session=parle_sess_insecure\n", { mode: 0o644 });
  const status = await installHarness(cwd).call("parle_status");
  assert.equal(status.details.sessionCookie.set, false);
  assert.equal(status.details.humanSession.configured, false);
});

test("parle_create_room uses only the configured cookie and fixed room endpoint", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const secretsDir = join(process.env.HOME, ".parle");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "session"), "__Host-parle_session=parle_sess_create-secret\n", { mode: 0o600 });
  let request;
  globalThis.fetch = async (url, init = {}) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({
      room_id: "019f7b3b-996e-7548-805a-5ed0784f676c",
      room_handle: "galexc-kyleops",
      kind: "shared",
      seat_id: "019f7b3b-996e-7548-805a-5ed0784f676d",
      token: "parle_agt_must-not-escape",
    }), { status: 201, headers: { "Set-Cookie": "__Host-parle_session=parle_sess_must-not-escape" } });
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_create_room", {
    roomHandle: "  GalexC-KyleOps  ",
    kind: "shared",
    confirmMutation: true,
    reason: "Create the Gilman and Kyle operations room",
  });

  assert.equal(request.url, "https://api.parle.sh/v/rooms");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Cookie, "__Host-parle_session=parle_sess_create-secret");
  assert.deepEqual(JSON.parse(request.init.body), { kind: "shared", room_handle: "galexc-kyleops" });
  assert.deepEqual(result.details, {
    room_id: "019f7b3b-996e-7548-805a-5ed0784f676c",
    room_handle: "galexc-kyleops",
    kind: "shared",
    seat_id: "019f7b3b-996e-7548-805a-5ed0784f676d",
  });
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.deepEqual(Object.keys(harness.tools.parle_create_room.parameters.properties).sort(), ["confirmMutation", "kind", "reason", "roomHandle"]);
});

test("parle_create_room fails closed before fetch for missing confirmation, cookie, or invalid shape", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 201 });
  };
  const harness = installHarness(cwd);

  await assert.rejects(harness.call("parle_create_room", { roomHandle: "galexc-kyleops", kind: "shared", reason: "test" }), /confirmMutation=true/);
  await assert.rejects(harness.call("parle_create_room", { roomHandle: "bad_handle", kind: "shared", confirmMutation: true, reason: "test" }), /roomHandle must normalize/);
  await assert.rejects(harness.call("parle_create_room", { roomHandle: "admin", kind: "shared", confirmMutation: true, reason: "test" }), /roomHandle must normalize/);
  await assert.rejects(harness.call("parle_create_room", { kind: "private", confirmMutation: true, reason: "test" }), /requires roomHandle/);
  await assert.rejects(harness.call("parle_create_room", { roomHandle: "galexc-kyleops", kind: "shared", confirmMutation: true, reason: "test" }), /requires PARLE_SESSION_COOKIE/);
  assert.equal(called, false);
});

test("parle_add_own_agent_seat uses only validated IDs, the configured cookie, and the fixed seat endpoint", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const secretsDir = join(process.env.HOME, ".parle");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "session"), "__Host-parle_session=parle_sess_seat-secret\n", { mode: 0o600 });
  let request;
  globalThis.fetch = async (url, init = {}) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({
      seat_id: "019f7b49-69f2-7479-a998-d13451101935",
      agent_id: "019f2946-b010-7c7e-81ca-9830e6d1fc8b",
      admitted_at: "2026-07-19T16:50:00Z",
      token: "parle_agt_must-not-escape",
    }), { status: 201, headers: { "Set-Cookie": "__Host-parle_session=parle_sess_must-not-escape" } });
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_add_own_agent_seat", {
    roomId: "  019F7B46-178F-7A5A-9F7B-B4AF2E045261  ",
    agentId: "019F2946-B010-7C7E-81CA-9830E6D1FC8B",
    confirmMutation: true,
    reason: "Seat Gilman's GalexC agent in the shared operations room",
  });

  assert.equal(request.url, "https://api.parle.sh/v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045261/seats");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Cookie, "__Host-parle_session=parle_sess_seat-secret");
  assert.deepEqual(JSON.parse(request.init.body), { agent_id: "019f2946-b010-7c7e-81ca-9830e6d1fc8b" });
  assert.deepEqual(result.details, {
    room_id: "019f7b46-178f-7a5a-9f7b-b4af2e045261",
    seat_id: "019f7b49-69f2-7479-a998-d13451101935",
    agent_id: "019f2946-b010-7c7e-81ca-9830e6d1fc8b",
    admitted_at: "2026-07-19T16:50:00Z",
  });
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.deepEqual(Object.keys(harness.tools.parle_add_own_agent_seat.parameters.properties).sort(), ["agentId", "confirmMutation", "reason", "roomId"]);
});

test("parle_add_own_agent_seat fails closed before fetch for invalid IDs, confirmation, or cookie", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 201 });
  };
  const harness = installHarness(cwd);
  const roomId = "019f7b46-178f-7a5a-9f7b-b4af2e045261";
  const agentId = "019f2946-b010-7c7e-81ca-9830e6d1fc8b";

  await assert.rejects(harness.call("parle_add_own_agent_seat", { roomId, agentId, reason: "test" }), /confirmMutation=true/);
  await assert.rejects(harness.call("parle_add_own_agent_seat", { agentId, confirmMutation: true, reason: "test" }), /roomId must be a non-zero UUID/);
  await assert.rejects(harness.call("parle_add_own_agent_seat", { roomId: "not-a-uuid", agentId, confirmMutation: true, reason: "test" }), /roomId must be a non-zero UUID/);
  await assert.rejects(harness.call("parle_add_own_agent_seat", { roomId, agentId: "00000000-0000-0000-0000-000000000000", confirmMutation: true, reason: "test" }), /agentId must be a non-zero UUID/);
  await assert.rejects(harness.call("parle_add_own_agent_seat", { roomId, agentId, confirmMutation: true, reason: "test" }), /requires PARLE_SESSION_COOKIE/);
  assert.equal(called, false);
});

test("principal invite tools expose link-first mint and separate guided acceptance", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  const stateDir = join(process.env.HOME, ".parle");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, "profiles"), "[default]\nroom_id = 019f7b46-178f-7a5a-9f7b-b4af2e045261\nagent_token = parle_agt_fixture\n", { mode: 0o600 });
  writeFileSync(join(stateDir, "session"), "__Host-parle_session=human-cookie\n", { mode: 0o600 });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.parle.sh/v/rooms/019f7b46-178f-7a5a-9f7b-b4af2e045261/invites");
    assert.deepEqual(JSON.parse(init.body), { claim_mode: "target_session", seat_type: "principal", target: { kind: "principal", principal_handle: "kljensen" } });
    return new Response(JSON.stringify({ invite_id: "019f7c00-0000-7000-8000-000000000010", room_id: "019f7b46-178f-7a5a-9f7b-b4af2e045261", claim_mode: "target_session", claim_url: "https://api.parle.sh/join/019f7c00-0000-7000-8000-000000000010", seat_type: "principal", target_principal_id: "019f3894-bb87-726a-8deb-17d367054426", target_display: { handle: "kljensen" }, offered_rights: [], expires_at: "2026-07-26T20:00:00Z" }), { status: 201 });
  };
  const harness = installHarness(cwd);
  const result = await harness.call("parle_mint_principal_invite", { roomId: "019f7b46-178f-7a5a-9f7b-b4af2e045261", principalHandle: "kljensen", confirmMutation: true, reason: "Invite Kyle" });
  assert.equal(result.details.targetHandle, "kljensen");
  assert.equal(result.details.claimUrl, "https://api.parle.sh/join/019f7c00-0000-7000-8000-000000000010");
  assert.equal(result.details.sensitive, false);
  assert.deepEqual(Object.keys(harness.tools.parle_harden_account.parameters.properties).sort(), ["action", "confirmMutation", "reason"]);
  assert.doesNotMatch(JSON.stringify(harness.tools.parle_harden_account.parameters), /password|recovery|provisioning|path/i);
  assert.deepEqual(Object.keys(harness.tools.parle_mint_principal_invite.parameters.properties).sort(), ["confirmMutation", "principalHandle", "principalId", "reason", "roomId"]);
  assert.deepEqual([...harness.tools.parle_mint_principal_invite.parameters.required].sort(), ["principalHandle", "roomId"]);
  assert.deepEqual(Object.keys(harness.tools.parle_claim_principal_invite.parameters.properties).sort(), ["action", "confirmMutation", "deleteHandoffOnSuccess", "handoffPath", "reason"]);
  assert.deepEqual(Object.keys(harness.tools.parle_accept_room_invitation.parameters.properties).sort(), ["action", "confirmMutation", "invitation", "reason"]);
  assert.deepEqual(Object.keys(harness.tools.parle_connect_own_agent.parameters.properties).sort(), ["action", "agentHandle", "agentId", "confirmMutation", "createAgentHandle", "invitation", "profileLabel", "reason"]);
  assert.match(harness.tools.parle_connect_own_agent.description, /one owned durable agent per operation/);
  assert.match(harness.tools.parle_connect_own_agent.parameters.properties.createAgentHandle.description, /instead of selecting an existing agent/);
});

test("generic parle_request honestly excludes human-session auth", async () => {
  const cwd = tempProject("PARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  const harness = installHarness(cwd);
  const authModeSchema = harness.tools.parle_request.parameters.properties.authMode;
  assert.deepEqual(authModeSchema.enum, ["none", "agent_token"]);

  const status = await harness.call("parle_status");
  assert.equal(status.details.humanSession.genericRequest, "unsupported");
  assert.deepEqual(status.details.humanSession.supportedTools, ["parle_login", "parle_create_room", "parle_add_own_agent_seat", "parle_harden_account", "parle_mint_principal_invite", "parle_claim_principal_invite", "parle_accept_room_invitation", "parle_connect_own_agent"]);
});

test("parle_login starts email login without requiring raw request plumbing", async () => {
  const cwd = tempProject();
  let startBody;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(String(url), "https://api.parle.sh/v/auth/email/start");
    startBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ status: "if_account_exists_code_sent" }), { status: 202 });
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_login", { email: "user@example.test" });

  assert.deepEqual(startBody, { email: "user@example.test" });
  assert.equal(result.details.status, "code_requested");
  assert.match(result.details.next, /code/);
});

test("parle_login complete captures Set-Cookie, mints token, saves credentials, and redacts secrets", async () => {
  const cwd = tempProject();
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    seen.push({ url: u, init });
    if (u.endsWith("/v/auth/email/complete")) {
      assert.deepEqual(JSON.parse(init.body), { email: "user@example.test", code: "123456" });
      return new Response(JSON.stringify({ status: "logged_in", session_cookie: "__Host-parle_session" }), {
        status: 201,
        headers: { "Set-Cookie": "__Host-parle_session=parle_ses_cookie-secret; Path=/; HttpOnly; Secure; SameSite=Lax" },
      });
    }
    if (u.endsWith("/v/rooms")) {
      assert.equal(init.headers.Cookie, "__Host-parle_session=parle_ses_cookie-secret");
      return new Response(JSON.stringify({ rooms: [{ room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", room_handle: "room-one" }] }), { status: 200 });
    }
    if (u.endsWith("/v/agents")) {
      assert.equal(init.headers.Cookie, "__Host-parle_session=parle_ses_cookie-secret");
      return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "pi" }] }), { status: 200 });
    }
    if (u.endsWith("/v/agents/agent-1/tokens")) {
      assert.equal(init.headers.Cookie, "__Host-parle_session=parle_ses_cookie-secret");
      assert.deepEqual(JSON.parse(init.body), { room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e" });
      return new Response(JSON.stringify({ agent_token_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1f", agent_id: "agent-1", room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", token: "parle_agt_plain-secret" }), { status: 201 });
    }
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_login", { action: "complete", email: "user@example.test", code: "123456" });

  assert.equal(result.details.status, "credentials_saved");
  assert.equal(JSON.stringify(result.details).includes("parle_ses_cookie-secret"), false);
  assert.equal(JSON.stringify(result.details).includes("parle_agt_plain-secret"), false);
  // No project .parle/credentials file exists anymore; the session cookie
  // lives beside the resolved profile catalog.
  assert.equal(existsSync(join(cwd, ".parle", "credentials")), false);
  const cookieFile = readFileSync(join(process.env.HOME, ".parle", "session"), "utf8");
  assert.equal(cookieFile, "__Host-parle_session=parle_ses_cookie-secret\n");
  assert.equal(statSync(join(process.env.HOME, ".parle", "session")).mode & 0o777, 0o600);
  const profiles = readFileSync(join(process.env.HOME, ".parle", "profiles"), "utf8");
  assert.match(profiles, /^\[default\]$/m);
  assert.match(profiles, /^room_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e$/m);
  assert.match(profiles, /^agent_token = parle_agt_plain-secret$/m);
  assert.match(profiles, /^agent_token_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1f$/m);
  assert.equal(statSync(join(process.env.HOME, ".parle", "profiles")).mode & 0o777, 0o600);
  assert.equal(existsSync(join(cwd, ".gitignore")), false);

  const status = await harness.call("parle_status");
  assert.equal(status.details.sessionCookie.value, "<redacted>");
  assert.equal(status.details.agentToken.value, "<redacted>");
  assert.equal(seen.some((request) => request.url.endsWith("/v/agents/agent-1/tokens")), true);
});

test("parle_login validates labels and requires force before replacing a profile", async () => {
  const cwd = tempProject("PARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\nPARLE_ROOM_ID=019f2946-aef5-77ad-a41d-747ce0fd6a1e\nPARLE_AGENT_ID=agent-1\n");
  const catalogDir = join(process.env.HOME, ".parle");
  mkdirSync(catalogDir, { recursive: true });
  const original = "# prefix\r\n[keep]\r\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a20\r\nagent_token = parle_agt_keep\r\n[target]\r\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a21\r\nagent_token = parle_agt_old\r\nagent_token_id = 019f2946-aef5-77ad-a41d-747ce0fd6a23\r\n[tail]\r\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a22\r\nagent_token = parle_agt_tail\r\n";
  writeFileSync(join(catalogDir, "profiles"), original, { mode: 0o600 });
  let called = false;
  globalThis.fetch = async (url, init = {}) => {
    called = true;
    const u = String(url);
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", room_handle: "one" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "pi" }] }), { status: 200 });
    if (u.endsWith("/v/agents/agent-1/tokens")) return new Response(JSON.stringify({ agent_token_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1f", token: "parle_agt_new" }), { status: 201 });
    throw new Error("unexpected " + u + String(init.body || ""));
  };
  const harness = installHarness(cwd);

  await assert.rejects(harness.call("parle_login", { action: "mint-from-session", profile: "bad]label", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1" }), /profile must be/);
  await assert.rejects(harness.call("parle_login", { action: "mint-from-session", profile: "target", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1" }), /force=true/);
  assert.equal(called, false);

  const result = await harness.call("parle_login", { action: "mint-from-session", profile: "target", force: true, roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1" });
  assert.equal(result.details.profile, "target");
  assert.equal(result.details.profileReplaced, true);
  assert.equal(result.details.prior_agent_token_id, "019f2946-aef5-77ad-a41d-747ce0fd6a23");
  const updated = readFileSync(join(catalogDir, "profiles"), "utf8");
  const prefix = original.slice(0, original.indexOf("[target]"));
  const suffix = original.slice(original.indexOf("[tail]"));
  assert.equal(updated.slice(0, prefix.length), prefix);
  assert.equal(updated.slice(-suffix.length), suffix);
  assert.match(updated, /\[target\]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1e\nagent_token = parle_agt_new\nagent_token_id = 019f2946-aef5-77ad-a41d-747ce0fd6a1f\n/);
});

test("parle_login writes profiles through an owned directory symlink", async () => {
  const cwd = tempProject("PARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\nPARLE_ROOM_ID=019f2946-aef5-77ad-a41d-747ce0fd6a1e\nPARLE_AGENT_ID=agent-1\n");
  const targetDir = join(process.env.HOME, "profile-store");
  mkdirSync(targetDir, { recursive: true });
  symlinkSync(targetDir, join(process.env.HOME, ".parle"));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", room_handle: "one" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "pi" }] }), { status: 200 });
    if (u.endsWith("/v/agents/agent-1/tokens")) return new Response(JSON.stringify({ agent_token_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1f", token: "parle_agt_dir_symlink" }), { status: 201 });
    throw new Error("unexpected " + u);
  };

  const result = await installHarness(cwd).call("parle_login", { action: "mint-from-session", profile: "linked-dir", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1" });

  assert.equal(result.details.profile, "linked-dir");
  assert.equal(lstatSync(join(process.env.HOME, ".parle")).isSymbolicLink(), true);
  assert.match(readFileSync(join(targetDir, "profiles"), "utf8"), /^\[linked-dir\]$/m);
  assert.equal(statSync(join(targetDir, "profiles")).mode & 0o777, 0o600);
});

test("parle_login atomically updates an owned symlink profile catalog", async () => {
  const cwd = tempProject("PARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\nPARLE_ROOM_ID=019f2946-aef5-77ad-a41d-747ce0fd6a1e\nPARLE_AGENT_ID=agent-1\n");
  const catalogDir = join(process.env.HOME, ".parle");
  const targetDir = join(process.env.HOME, "profile-store");
  mkdirSync(catalogDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, "profiles");
  writeFileSync(target, "[keep]\nroom_id = 019f2946-aef5-77ad-a41d-747ce0fd6a20\nagent_token = parle_agt_keep\n", { mode: 0o600 });
  symlinkSync(target, join(catalogDir, "profiles"));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", room_handle: "one" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "pi" }] }), { status: 200 });
    if (u.endsWith("/v/agents/agent-1/tokens")) return new Response(JSON.stringify({ agent_token_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1f", token: "parle_agt_symlink" }), { status: 201 });
    throw new Error("unexpected " + u);
  };

  const result = await installHarness(cwd).call("parle_login", { action: "mint-from-session", profile: "linked", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1" });

  assert.equal(result.details.profile, "linked");
  assert.equal(lstatSync(join(catalogDir, "profiles")).isSymbolicLink(), true);
  assert.match(readFileSync(target, "utf8"), /^\[linked\]$/m);
  assert.match(readFileSync(join(catalogDir, "profiles"), "utf8"), /^\[keep\]$/m);
  assert.equal(statSync(target).mode & 0o777, 0o600);
});

test("parle_login preserves session cookie when room or agent selection is ambiguous", async () => {
  const cwd = tempProject();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/auth/email/complete")) {
      return new Response(JSON.stringify({ status: "logged_in" }), {
        status: 201,
        headers: { "Set-Cookie": "__Host-parle_session=parle_ses_saved; Path=/; HttpOnly; Secure" },
      });
    }
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "room-1", room_handle: "one" }, { room_id: "room-2", room_handle: "two" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "a" }, { agent_id: "agent-2", agent_handle: "b" }] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_login", { action: "complete", email: "user@example.test", code: "123456" });

  assert.equal(result.details.status, "selection_required");
  assert.equal(result.details.wroteSessionCookie, true);
  assert.equal(result.details.rooms.length, 2);
  assert.equal(result.details.agents.length, 2);
  assert.equal(existsSync(join(cwd, ".parle", "credentials")), false);
  assert.equal(readFileSync(join(process.env.HOME, ".parle", "session"), "utf8"), "__Host-parle_session=parle_ses_saved\n");
});

test("parle_login complete refuses to consume a code when credentials will not be saved", async () => {
  const cwd = tempProject();
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 201 });
  };
  const harness = installHarness(cwd);

  await assert.rejects(
    harness.call("parle_login", { action: "complete", email: "user@example.test", code: "123456", writeCredentials: false }),
    /consume a one-time code/,
  );
  assert.equal(called, false);
  assert.equal(existsSync(join(process.env.HOME, ".parle", "session")), false);
});

test("parle_login routes persistence through PARLE_PROFILES_PATH", async () => {
  const cwd = tempProject("PARLE_PROFILES_PATH=./secrets/parle-profiles\nPARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\n");
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", room_handle: "one" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "a" }] }), { status: 200 });
    if (u.endsWith("/v/agents/agent-1/tokens")) return new Response(JSON.stringify({ agent_token_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1f", token: "parle_agt_override-secret" }), { status: 201 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);

  const result = await harness.call("parle_login", { action: "mint-from-session", roomId: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", agentId: "agent-1", profile: "team" });

  assert.equal(result.details.status, "credentials_saved");
  assert.equal(result.details.profilePath, join(cwd, "secrets", "parle-profiles"));
  assert.equal(result.details.sessionCookiePath, join(cwd, "secrets", "session"));
  const profiles = readFileSync(join(cwd, "secrets", "parle-profiles"), "utf8");
  assert.match(profiles, /^\[team\]$/m);
  assert.match(profiles, /^agent_token = parle_agt_override-secret$/m);
  assert.equal(readFileSync(join(cwd, "secrets", "session"), "utf8"), "__Host-parle_session=parle_ses_existing\n");
  assert.equal(existsSync(join(process.env.HOME, ".parle", "profiles")), false);
});

test("parle_login fails closed on conflicting or duplicate selection", async () => {
  const cwd = tempProject("PARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\nPARLE_ROOM_ID=room-1\nPARLE_AGENT_ID=agent-1\n");
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/v/rooms")) return new Response(JSON.stringify({ rooms: [{ room_id: "room-1", room_handle: "one" }, { room_id: "room-2", room_handle: "two" }] }), { status: 200 });
    if (u.endsWith("/v/agents")) return new Response(JSON.stringify({ agents: [{ agent_id: "agent-1", agent_handle: "dup" }, { agent_id: "agent-2", agent_handle: "dup" }] }), { status: 200 });
    throw new Error("unexpected " + u);
  };
  const harness = installHarness(cwd);

  await assert.rejects(
    harness.call("parle_login", { action: "mint-from-session", roomId: "room-1", roomHandle: "two", agentId: "agent-1" }),
    /selection conflict/,
  );
  await assert.rejects(
    harness.call("parle_login", { action: "mint-from-session", roomHandle: "one", agentHandle: "dup" }),
    /Multiple agents match/,
  );
});

test("parle_login mint-from-session refuses to mint when credentials will not be saved", async () => {
  const cwd = tempProject("PARLE_SESSION_COOKIE=__Host-parle_session=parle_ses_existing\n");
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  const harness = installHarness(cwd);

  await assert.rejects(
    harness.call("parle_login", { action: "mint-from-session", writeCredentials: false, roomId: "room-1", agentId: "agent-1" }),
    /mint a plaintext token/,
  );
  assert.equal(called, false);
});

function installSendHarness(fetchImpl) {
  const cwd = tempProject("PARLE_ROOM_ID=room-send\nPARLE_ROOM_AGENT_TOKEN=token-send\nPARLE_WATCH_ENABLED=0\n");
  globalThis.fetch = fetchImpl;
  return installHarness(cwd);
}

test("parle_send includes direct addressing when to is present", async () => {
  let messageRequest;
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-send", session_credential: "parle_ses_send-session", session_handle: "send-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.send-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-send" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.endsWith("/v/rooms/room-send/messages")) {
      messageRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({ seq: 1, event_id: "event-1", moderation: { held: true, delivered: false, scan: "skipped", steps: [], verdict: "pending", reason: "awaiting moderation completion" } }), { status: 201 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_send", { body: "What time is it?", to: "@gilman.galexc.mme3hxrdumknrpvv", idempotencyKey: "idem-1" });

  assert.deepEqual(messageRequest.addressing, { audience: "direct", to: "@gilman.galexc.mme3hxrdumknrpvv" });
  assert.equal(messageRequest.payload.body, "What time is it?");
  assert.equal(result.details.addressedTo, "@gilman.galexc.mme3hxrdumknrpvv");
  assert.equal(result.details.warning, undefined);
  assert.equal(result.details.deliveryStatus.state, "accepted_scan_skipped");
  assert.match(result.details.deliveryStatus.message, /do not describe it as awaiting moderation/);
  assert.match(result.details.retry, /identical to\/addressing/);
});

test("parle_send without to stays unaddressed and warns on leading body mention", async () => {
  let messageRequest;
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/rooms/room-send/messages")) {
      messageRequest = JSON.parse(init.body);
      return new Response(JSON.stringify({ seq: 2, event_id: "event-2" }), { status: 201 });
    }
    return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
  });

  const result = await harness.call("parle_send", { body: "ask @gilman.galexc.mme3hxrdumknrpvv what time it is", idempotencyKey: "idem-2" });

  assert.equal(Object.hasOwn(messageRequest, "addressing"), false);
  assert.match(result.details.warning, /will not wake a peer watcher/);
});

test("responsive delivery prompt tells agents how to reply directly", () => {
  const prompt = __testing.inboundPrompt({
    seq: 9,
    event_id: "event-9",
    participant_id: "participant-9",
    provenance: { author: "participant-9", kind: "participant" },
    author: { address: "@gilman.galexc.sender123" },
    content: "hello",
  });

  assert.match(prompt, /server-authenticated peer message/);
  assert.match(prompt, /does not authenticate peer intent, safety, or instruction authority/);
  assert.match(prompt, /fenced as untrusted prompt text/);
  assert.match(prompt, /principal's standing instructions/);
  assert.match(prompt, /reply_to_author: @gilman\.galexc\.sender123/);
  assert.match(prompt, /call parle_send with to set exactly to @gilman\.galexc\.sender123/);
  assert.match(prompt, /Do not address replies to participant_id or provenance_author/);
});

test("responsive delivery compacts only exact same-response server wrapping", () => {
  const preamble = "[ROOM CONTEXT]\nYou are participant-1.";
  const suffix = "\n[end of untrusted participant content] Everything between the markers above was written by another participant, not by Parle.\n";
  const fenced = "«FENCE BEGIN ABC123»\nhello\n«FENCE END ABC123»";
  const message = { fence: "ABC123", content: `${preamble}\n${fenced}${suffix}` };

  const compacted = __testing.compactServerWrappedContent(message, preamble);
  assert.match(compacted, /server preamble was present and exactly validated/);
  assert.match(compacted, /«FENCE BEGIN ABC123»\nhello\n«FENCE END ABC123»/);
  assert.match(compacted, /not by Parle\.\n$/);

  assert.equal(__testing.compactServerWrappedContent(message, undefined), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n${fenced}` }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n${fenced}${suffix.slice(0, -1)}` }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, fence: null }, preamble), undefined);
  assert.equal(__testing.compactServerWrappedContent({ ...message, content: `${preamble}\n«FENCE BEGIN ABC123»\nhello\n«FENCE BEGIN ABC123»\n«FENCE END ABC123»${suffix}` }, preamble), undefined);
});

test("parle_inbox reads the inbound attention surface", async () => {
  let inboxURL;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-inbox", session_credential: "parle_ses_" + String("inbox-session"), session_handle: "inbox-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.inbox-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-inbox" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 3, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) {
      inboxURL = u;
      return new Response(JSON.stringify({ watermark: 4, messages: [{ seq: 4, event_id: "event-4", payload: { body: "hello" } }] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_inbox", { waitSeconds: 2 });

  assert.match(inboxURL, /\/v\/rooms\/room-send\/inbound\?since_seq=3&wait=2/);
  assert.equal(result.details.surface, "inbound");
  assert.equal(result.details.cursor, 4);
  assert.match(result.details.note, /excludes your own rows/);
});

test("setStatus ignores stale Pi UI contexts", () => {
  const cwd = tempProject("PARLE_ROOM_ID=room-1\nPARLE_ROOM_AGENT_TOKEN=token-1\n");
  const staleCtx = {
    cwd,
    get ui() {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    },
  };

  assert.doesNotThrow(() => __testing.setStatus(staleCtx));
});

test("parle_affordances wraps the room affordances endpoint", async () => {
  let sawAffordances = false;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-aff", session_credential: "parle_ses_" + String("aff-session"), session_handle: "aff-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.aff-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-aff" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.endsWith("/v/rooms/room-send/affordances")) {
      sawAffordances = true;
      return new Response(JSON.stringify({ affordances: [{ action: "post_message", allowed: true }] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_affordances");

  assert.equal(sawAffordances, true);
  assert.equal(result.details.affordances[0].action, "post_message");
  assert.match(result.details.note, /advisory/);
});

test("SSE parser ignores keepalives and returns wake events", () => {
  const parsed = __testing.parseSSEBlocks(": keepalive\n\nevent: config\ndata: {\"keepalive_ms\":25000}\n\nevent: wake\ndata: {\"room_id\":\"room-send\"}\n\npartial");

  assert.deepEqual(parsed.events, [
    { event: "config", data: "{\"keepalive_ms\":25000}" },
    { event: "wake", data: "{\"room_id\":\"room-send\"}" },
  ]);
  assert.equal(parsed.rest, "partial");
});

test("wake hint drains responsive delivery without long polling", async () => {
  const requested = [];
  const injected = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    requested.push(u);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-wake", session_credential: "parle_ses_" + String("wake-session"), session_handle: "wake-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.wake-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-wake" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ last_acked_seq: 7, last_ack_event_id: "evt-wake" }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) {
      return new Response(JSON.stringify({
        watermark: 7,
        delivery: { last_acked_seq: 0 },
        messages: [{ seq: 7, event_id: "evt-wake", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "hello" }],
      }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });
  const cfg = __testing.resolveConfig(harness.cwd);
  await harness.call("parle_status");
  const pi = { sendUserMessage: async (message) => injected.push(message) };

  await __testing.handleWakeHint(pi, harness.ctx, cfg);

  assert.equal(injected.length, 1);
  assert.equal(__testing.runtimeState().lastAckedSeq, 7);
  assert.equal(requested.some((u) => u.includes("/responsive-delivery?wait=0")), true);
  assert.equal(requested.some((u) => /responsive-delivery\?wait=(?!0)/.test(u)), false);
});

test("wake hint coalesces responsive delivery backlog into one follow-up", async () => {
  const injected = [];
  const acked = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-batch", session_credential: "parle_ses_batch-session", session_handle: "batch-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.batch-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-batch" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      acked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ last_acked_seq: acked.at(-1).seq, last_ack_event_id: acked.at(-1).event_id }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) {
      return new Response(JSON.stringify({
        watermark: 8,
        delivery: { last_acked_seq: 0 },
        messages: [
          { seq: 7, event_id: "evt-batch-7", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "first" },
          { seq: 8, event_id: "evt-batch-8", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "second" },
        ],
      }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.handleWakeHint({ sendUserMessage: async (message) => injected.push(message) }, harness.ctx, cfg);

  assert.equal(injected.length, 1);
  assert.match(injected[0], /received 2 server-authenticated peer messages/);
  assert.match(injected[0], /responsive delivery 1\/2/);
  assert.match(injected[0], /responsive delivery 2\/2/);
  assert.deepEqual(acked, [{ seq: 8, event_id: "evt-batch-8" }]);
  assert.equal(__testing.runtimeState().lastInjectedSeq, 8);
});

test("busy Pi buffers responsive rows until settled, then injects one batch", async () => {
  const injected = [];
  const acked = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-settled", session_credential: "parle_ses_settled-session", session_handle: "settled-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.settled-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-settled" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      acked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ last_acked_seq: acked.at(-1).seq }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) return new Response(JSON.stringify({ delivery: { last_acked_seq: 0 }, messages: [] }), { status: 200 });
    throw new Error("unexpected " + u);
  });
  await harness.call("parle_status");
  const cfg = __testing.resolveConfig(harness.cwd);
  let idle = false;
  harness.ctx.isIdle = () => idle;
  const pi = { sendUserMessage: async (message) => injected.push(message) };
  const messages = [
    { seq: 7, event_id: "evt-settled-7", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "first" },
    { seq: 8, event_id: "evt-settled-8", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "second" },
  ];

  await __testing.queueResponsiveMessages(harness.ctx, cfg, messages);
  await __testing.flushPendingResponsiveMessages(pi, harness.ctx, cfg);
  assert.equal(injected.length, 0);
  assert.deepEqual(acked, []);
  assert.equal(__testing.runtimeState().pendingResponsiveCount, 2);

  idle = true;
  await __testing.flushPendingResponsiveMessages(pi, harness.ctx, cfg);
  assert.equal(injected.length, 1);
  assert.match(injected[0], /received 2 server-authenticated peer messages/);
  assert.deepEqual(acked, [{ seq: 8, event_id: "evt-settled-8" }]);
  assert.equal(__testing.runtimeState().pendingResponsiveCount, 0);
});

test("wake hint silently acks rows already surfaced by manual inbox reads", async () => {
  const injected = [];
  const acked = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-seen", session_credential: "parle_ses_seen-session", session_handle: "seen-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.seen-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-seen" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) {
      return new Response(JSON.stringify({ watermark: 9, messages: [{ seq: 9, event_id: "evt-seen", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "already read" }] }), { status: 200 });
    }
    if (u.includes("/responsive-delivery/ack")) {
      acked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ last_acked_seq: 9, last_ack_event_id: "evt-seen" }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) {
      return new Response(JSON.stringify({
        watermark: 9,
        delivery: { last_acked_seq: 0 },
        messages: [{ seq: 9, event_id: "evt-seen", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "already read" }],
      }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  const read = await harness.call("parle_inbox");
  assert.equal(read.details.messages[0].event_id, "evt-seen");
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.handleWakeHint({ sendUserMessage: async (message) => injected.push(message) }, harness.ctx, cfg);

  assert.equal(injected.length, 0);
  assert.deepEqual(acked, [{ seq: 9, event_id: "evt-seen" }]);
  assert.equal(__testing.runtimeState().seenSuppressed, 1);
  assert.equal(__testing.runtimeState().lastAckedSeq, 9);
});

test("wake hint acks seen and injected prefix only after successful injection", async () => {
  const order = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-prefix", session_credential: "parle_ses_prefix-session", session_handle: "prefix-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.prefix-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-prefix" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) return new Response(JSON.stringify({ watermark: 6, messages: [{ seq: 6, event_id: "evt-prefix-6", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "seen" }] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      order.push(`ack:${JSON.parse(String(init.body)).seq}`);
      return new Response(JSON.stringify({ last_acked_seq: 6, last_ack_event_id: "evt-prefix-6" }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) return new Response(JSON.stringify({ watermark: 6, delivery: { last_acked_seq: 0 }, messages: [
      { seq: 5, event_id: "evt-prefix-5", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "inject me" },
      { seq: 6, event_id: "evt-prefix-6", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "seen" },
    ] }), { status: 200 });
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  await harness.call("parle_inbox");
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.handleWakeHint({ sendUserMessage: async () => order.push("send") }, harness.ctx, cfg);

  assert.deepEqual(order, ["send", "ack:6"]);
  assert.equal(__testing.runtimeState().seenSuppressed, 1);
  assert.equal(__testing.runtimeState().lastInjectedSeq, 5);
  assert.equal(__testing.runtimeState().lastAckedSeq, 6);
});

test("advanceCursor false manual reads do not consume responsive delivery", async () => {
  const injected = [];
  const acked = [];
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) return new Response(JSON.stringify({ agent_session_id: "as-peek", session_credential: "parle_ses_peek-session", session_handle: "peek-session", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.peek-session" }), { status: 201 });
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-peek" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) return new Response(JSON.stringify({ watermark: 9, messages: [{ seq: 9, event_id: "evt-peek", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "peeked" }] }), { status: 200 });
    if (u.includes("/responsive-delivery/ack")) {
      acked.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ last_acked_seq: 9, last_ack_event_id: "evt-peek" }), { status: 200 });
    }
    if (u.includes("/responsive-delivery")) return new Response(JSON.stringify({ watermark: 9, delivery: { last_acked_seq: 0 }, messages: [{ seq: 9, event_id: "evt-peek", participant_id: "p-peer", provenance_author: "peer", provenance_kind: "participant", content: "peeked" }] }), { status: 200 });
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  await harness.call("parle_inbox", { advanceCursor: false });
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.handleWakeHint({ sendUserMessage: async (message) => injected.push(message) }, harness.ctx, cfg);

  assert.equal(injected.length, 1);
  assert.deepEqual(acked, [{ seq: 9, event_id: "evt-peek" }]);
  assert.equal(__testing.runtimeState().seenSuppressed, undefined);
});

test("heartbeat rebootstrap action replaces the session before the watcher can wedge", async () => {
  let sessionCreates = 0;
  let heartbeatCalls = 0;
  const harness = installSendHarness(async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-heart-${sessionCreates}`, session_credential: `parle_ses_heart-session-${sessionCreates}`, session_handle: `heart-session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.heart-session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-heart" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/heartbeat")) {
      heartbeatCalls += 1;
      assert.equal(init.headers["Parle-Client-Name"], "@parlehq/pi-extension");
      assert.equal(init.headers["Parle-Client-Version"], "0.1.29");
      if (heartbeatCalls === 1) return new Response(JSON.stringify({ error: { code: "agent_session_ended", message: "ended", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }), { status: 401 });
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  const cfg = __testing.resolveConfig(harness.cwd);
  await __testing.maybeHeartbeatAgentSession(harness.ctx, cfg);

  assert.equal(sessionCreates, 2);
  assert.equal(heartbeatCalls, 2);
  assert.equal(__testing.runtimeState().agentSessionId, "as-heart-2");
  assert.equal(typeof __testing.runtimeState().lastHeartbeatAt, "string");
});

test("terminal invalid agent token does not rebootstrap or enter a heartbeat loop", async () => {
  let sessionCreates = 0;
  let heartbeatCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: "as-terminal", session_credential: "parle_ses_terminal", expires_at: "2026-07-04T00:00:00Z", address: "@p.a.terminal" }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-terminal" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/heartbeat")) {
      heartbeatCalls += 1;
      return new Response(JSON.stringify({ error: { code: "invalid_agent_token", message: "revoked", action: "reauthorize", retryable: false, scope: "agent_token", retry_after_ms: null } }), { status: 401 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  const cfg = __testing.resolveConfig(harness.cwd);
  await assert.rejects(__testing.maybeHeartbeatAgentSession(harness.ctx, cfg), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "invalid_agent_token");
    assert.equal(error.action, "reauthorize");
    assert.equal(error.retryable, false);
    return true;
  });

  assert.equal(sessionCreates, 1);
  assert.equal(heartbeatCalls, 1);
  assert.equal(__testing.terminalWatcherState({ action: "reauthorize" }), "auth_expired");
  assert.equal(__testing.terminalWatcherState({ action: "fix_client" }), "disconnected");
  assert.equal(__testing.watcherRetryDelayMs({ retryAfterMs: 120_000 }), 120_000);
});

test("room tool calls rebootstrap on the server action", async () => {
  let sessionCreates = 0;
  let inboxCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-${sessionCreates}`, session_credential: `parle_ses_session-${sessionCreates}`, session_handle: `session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-reboot" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/inbound")) {
      inboxCalls += 1;
      if (inboxCalls === 1) return new Response(JSON.stringify({ error: { code: "agent_session_expired", message: "expired", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }), { status: 401 });
      return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  const result = await harness.call("parle_inbox");

  assert.equal(result.details.surface, "inbound");
  assert.equal(sessionCreates, 2);
  assert.equal(inboxCalls, 2);
});

test("mid-run unpinned rebootstrap baselines the new session before retry", async () => {
  let sessionCreates = 0;
  let inboxCalls = 0;
  let baselineCalls = 0;
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/agent/sessions")) {
      sessionCreates += 1;
      return new Response(JSON.stringify({ agent_session_id: `as-baseline-${sessionCreates}`, session_credential: `parle_ses_baseline-session-${sessionCreates}`, session_handle: `baseline-session-${sessionCreates}`, expires_at: "2026-07-04T00:00:00Z", address: `@p.a.baseline-session-${sessionCreates}` }), { status: 201 });
    }
    if (u.endsWith("/participants")) return new Response(JSON.stringify({ participant_id: "p-baseline" }), { status: 201 });
    if (u.includes("/projection")) return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    if (u.includes("/responsive-delivery")) {
      baselineCalls += 1;
      return new Response(JSON.stringify({ watermark: 0, delivery: { last_acked_seq: 0 }, messages: [] }), { status: 200 });
    }
    if (u.includes("/inbound")) {
      inboxCalls += 1;
      if (inboxCalls === 1) return new Response(JSON.stringify({ error: { code: "agent_session_expired", message: "expired", action: "rebootstrap", retryable: false, scope: "agent_session", retry_after_ms: null } }), { status: 401 });
      return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
    }
    throw new Error("unexpected " + u);
  });

  await harness.call("parle_status");
  __testing.patchRuntime({ baselineAt: "2026-07-05T20:00:00.000Z" });
  const result = await harness.call("parle_inbox");

  assert.equal(result.details.surface, "inbound");
  assert.equal(sessionCreates, 2);
  assert.equal(inboxCalls, 2);
  assert.equal(baselineCalls, 1);
});

test("parle_send treats direct addressing failures as non-retryable with hint", async () => {
  const harness = installSendHarness(async (url) => {
    const u = String(url);
    if (u.endsWith("/v/rooms/room-send/messages")) {
      return new Response(JSON.stringify({ error: { code: "address_not_deliverable", message: "address not deliverable" } }), { status: 422 });
    }
    return new Response(JSON.stringify({ watermark: 0, messages: [] }), { status: 200 });
  });

  const result = await harness.call("parle_send", { body: "hello", to: "@missing.agent", idempotencyKey: "idem-3" });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.retryable, false);
  assert.equal(result.details.idempotencyKey, "<redacted>");
  assert.match(result.details.hint, /target is a live room participant/);
  assert.match(result.details.error, /address not deliverable/);
});

test("Pi delegates delivery summary wording and precedence to agent client", async () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /summarizeSendDelivery[^\n]*from "@parlehq\/agent-client"/);
  assert.doesNotMatch(source, /function summarizeSendDelivery/);
  const { summarizeSendDelivery } = await import("@parlehq/agent-client");
  assert.deepEqual(summarizeSendDelivery({ moderation: { held: true, delivered: false, scan: "skipped", steps: [] } }), {
    state: "accepted_scan_skipped",
    message: "Message accepted. This room/config skipped moderation scanning, so do not describe it as awaiting moderation completion.",
  });
  assert.deepEqual(summarizeSendDelivery({ seq: 9, moderation: { held: true, reason: "queued" } }), {
    state: "held_for_moderation", message: "queued", nextStep: "Poll parle_read or parle_inbox around seq 9; if held_backlog drains and the row never appears, it was blocked.",
  });
  assert.deepEqual(summarizeSendDelivery({ moderation: { delivered: true } }), { state: "delivered", message: "Message accepted and delivered." });
  assert.equal(summarizeSendDelivery({}), undefined);
});
