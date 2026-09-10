import assert from "node:assert/strict";
import { createServer } from "node:https";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const PI = process.env.PARLE_PI_CLI || spawnSync("which", ["pi"], { encoding: "utf8" }).stdout?.trim();
const EXTENSION = new URL("../dist/index.js", import.meta.url).pathname;
const ROOM = "room-native";
const ALIAS = "native-worker";
const TIMEOUT = 8_000;

function cleanEnv(extra) {
  return { PATH: process.env.PATH, LANG: "C.UTF-8", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...extra };
}

function waitFor(check, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(new Error(`timed out waiting for ${label}`)); }, TIMEOUT);
    const tick = () => {
      if (done) return;
      try {
        const value = check();
        if (value) { done = true; clearTimeout(timer); resolve(value); }
        else setTimeout(tick, 10);
      } catch (error) { done = true; clearTimeout(timer); reject(error); }
    };
    tick();
  });
}

async function fakeParle({ rejectClaim = false, rejectWake = false, rejectDrain = false } = {}) {
  const calls = [];
  let liveWakes = 0;
  const certDir = mkdtempSync(join(tmpdir(), "parle-native-cert-"));
  const cert = join(certDir, "cert.pem");
  const key = join(certDir, "key.pem");
  const config = join(certDir, "openssl.cnf");
  writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:fixture.parle.sh\nbasicConstraints=critical,CA:TRUE\n");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", config, "-keyout", key, "-out", cert], { timeout: 15000 });
  assert.equal(made.status, 0, "test certificate generation failed");
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) },async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    calls.push({ method: req.method, path });
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (path === "/v/agent/sessions" && req.method === "POST") return json({ agent_session_id: "native-session", session_credential: "parle_ses_fixture", session_handle: "native", expires_at: "2099-01-01T00:00:00Z", address: "@fixture.agent.native" }, 201);
    if (path.endsWith("/participants")) return json({ participant_id: "native-participant", room_id: ROOM, room_handle: "native-room", agent_session_id: "native-session", baseline_seq: 0 }, 201);
    if (path.includes("/projection")) return json({ watermark: 0, messages: [] });
    if (path === `/v/agent/session-aliases/${ALIAS}`) return json({ alias: ALIAS, alias_identity_id: "019f7b46-178f-7a5a-9f7b-b4af2e045261", generation: 0, current_agent_session_id: "other" });
    if (path.endsWith("/claim-alias")) {
      if (rejectClaim) return json({ error: { code: "alias_conflict", message: "fixture rejected alias", action: "stop", retryable: false } }, 409);
      return json({ agent_session_id: "native-session", alias: ALIAS, alias_identity_id: "019f7b46-178f-7a5a-9f7b-b4af2e045261", generation: 1, address: "@fixture.agent.native-worker", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (path.includes("/responsive-delivery")) {
      if (rejectDrain) return json({error: {code: "unavailable", message: "fixture drain failed", action: "backoff", retryable: true}}, 503);
      const scope = new URL(req.url, "https://fixture.parle.sh").searchParams.get("cursor_scope") || "session";
      return json({ watermark: 0, scanned_max: 0, has_more: false, messages: [], delivery: { cursor_scope: scope, ...(scope === "alias" ? { alias_context: { alias_identity_id: "019f7b46-178f-7a5a-9f7b-b4af2e045261", alias_generation: 1 } } : {}) } });
    }
    if (path === "/v/agent/wake") {
      if (rejectWake) return json({error: {code: "unavailable", message: "fixture wake failed", action: "backoff", retryable: true}}, 503);
      liveWakes++;
      res.once("close", () => { liveWakes--; });
      // A real delayed open catches mistaking controller.start() for readiness.
      setTimeout(() => { if (!res.destroyed) { res.writeHead(200, {"content-type": "text/event-stream"}); res.write(": connected\n\n"); } }, 100);
      return;
    }
    if (path.endsWith("/end")) { res.writeHead(204); return res.end(); }
    return json({ error: { message: `unexpected fixture request ${req.method} ${path}` } }, 500);
  });
  try {
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  } catch (error) {
    if (error?.code === "EPERM") { rmSync(certDir, {recursive: true, force: true}); return { unavailable: true, error }; }
    throw error;
  }
  const { port } = server.address();
  return { calls, liveWakes: () => liveWakes, cert, base: `https://127.0.0.1:${port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => { rmSync(certDir, {recursive: true, force: true}); resolve(); }); }) };
}

function start(api, { alias = true, watch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "parle-native-pi-"));
  const preload = join(root, "local-transport.cjs");
  // Keep the production HTTPS allowlist and TLS verification intact. Only DNS
  // is redirected; all requests still traverse the real native HTTP client.
  writeFileSync(preload, `const dns = require("node:dns"); dns.lookup = (host, options, callback) => { if (typeof options === "function") { callback = options; options = {}; } if (host !== "fixture.parle.sh") return callback(new Error("Native fixture forbids external DNS")); callback(null, options?.all ? [{address:"127.0.0.1",family:4}] : "127.0.0.1", 4); };`);
  const child = spawn(PI, [ "--mode", "rpc", "--no-session", "--no-extensions", "-e", EXTENSION, ...(alias ? ["--parle-alias", ALIAS] : [])], {
    cwd: root,
    env: cleanEnv({ HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"), PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "fixture-token-not-a-secret", PARLE_API_BASE: api.base.replace("127.0.0.1", "fixture.parle.sh"), PARLE_WAKE_BASE: api.base.replace("127.0.0.1", "fixture.parle.sh"), NODE_OPTIONS: `--require=${preload}`, NODE_EXTRA_CA_CERTS: api.cert, PARLE_SESSION_ALIAS: ALIAS, PARLE_WATCH_ENABLED: watch ? "1" : "0" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({code, signal})));
  const events = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const i = buffer.indexOf("\n");
      if (i < 0) break;
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (line) events.push(JSON.parse(line));
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const send = command => child.stdin.write(`${JSON.stringify(command)}\n`);
  const stop = async () => {
    child.stdin.end();
    let timer;
    try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000); })]); }
    finally { clearTimeout(timer); }
    await exited;
    rmSync(root, { recursive: true, force: true });
  };
  return { child, exited, events, send, stop, stderr: () => stderr };
}

const unavailable = !PI || !existsSync(PI) || !existsSync(EXTENSION);

test("native Pi 0.85.1 RPC claims --parle-alias once and publishes ready without a model turn", { skip: unavailable && "Pi 0.85.1 or explicit built extension bundle is unavailable" }, async (t) => {
  const api = await fakeParle();
  if (api.unavailable) return t.skip(`sandbox denies localhost listen (${api.error.code}); preload-fetch fallback is not used because it would not exercise real HTTP transport`);
  const pi = start(api, { watch: true });
  try {
    const ready = await waitFor(() => pi.events.find(event => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "parle-alias-launch" && JSON.parse(event.statusText).phase === "ready"), "structured ready status");
    assert.equal(JSON.parse(ready.statusText).sessionAddress, "@fixture.agent.native-worker");
    assert.equal(JSON.parse(ready.statusText).generation, 1);
    assert.equal(api.liveWakes(), 1);
    assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 1);
    assert.equal(pi.events.some(event => event.type === "agent_start" || event.type === "turn_start"), false, "launch made no model turn");
    pi.send({ id: "new", type: "new_session" });
    await waitFor(() => pi.events.find(event => event.id === "new" && event.type === "response"), "new-session response");
    assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 1, "native new-session rebind does not reclaim");
    assert.equal(pi.events.some(event => event.type === "agent_start" || event.type === "turn_start"), false);
    await waitFor(() => pi.child.exitCode !== null, "terminal ended-launch exit");
    assert.equal(api.liveWakes(), 0);
    assert.equal(api.calls.filter(call => call.path.endsWith("/end")).length, 1, "native new session ends the claimed Parle session");
    assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 1);
    assert.ok(pi.events.some(event => event.type === "extension_error" && /launch session ended/.test(event.error || "")), "supervisor receives terminal ended-launch evidence");
    assert.equal(`${JSON.stringify(pi.events)}${pi.stderr()}`.includes("fixture-token-not-a-secret"), false, "credential is never emitted");
  } catch (error) { throw new Error(`${error.message}; calls=${JSON.stringify(api.calls)}; events=${JSON.stringify(pi.events)}; stderr=${pi.stderr()}`); }
  finally { await pi.stop(); await api.close(); }
});

test("native Pi failure refuses later RPC input without a second claim", { skip: unavailable && "Pi 0.85.1 or explicit built extension bundle is unavailable" }, async (t) => {
  const api = await fakeParle({ rejectClaim: true });
  if (api.unavailable) return t.skip(`sandbox denies localhost listen (${api.error.code}); preload-fetch fallback is not used because it would not exercise real HTTP transport`);
  const pi = start(api);
  try {
    await waitFor(() => pi.events.find(event => event.type === "extension_error" && /fixture rejected alias/.test(event.error || "")), "launch failure");
    // The refused headless host requests shutdown, so test input refusal rather
    // than asking a terminating process to complete a new-session transition.
    pi.send({ id: "blocked", type: "prompt", message: "must not reach a model" });
    await waitFor(() => pi.events.find(event => event.id === "blocked" && event.type === "response"), "blocked prompt response");
    assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 1);
    assert.equal(pi.events.some(event => event.type === "agent_start" || event.type === "turn_start"), false, "refused prompt made no model turn");
  } catch (error) { throw new Error(`${error.message}; calls=${JSON.stringify(api.calls)}; events=${JSON.stringify(pi.events)}; stderr=${pi.stderr()}`); }
  finally { await pi.stop(); await api.close(); }
});

test("native Pi ignores env-only alias configuration without --parle-alias", { skip: unavailable && "Pi 0.85.1 or explicit built extension bundle is unavailable" }, async (t) => {
  const api = await fakeParle();
  if (api.unavailable) return t.skip(`sandbox denies localhost listen (${api.error.code}); preload-fetch fallback is not used because it would not exercise real HTTP transport`);
  const pi = start(api, { alias: false });
  try {
    pi.send({ id: "state", type: "get_state" });
    await waitFor(() => pi.events.find(event => event.id === "state" && event.type === "response"), "RPC state response");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 0);
    assert.equal(pi.events.some(event => event.type === "agent_start" || event.type === "turn_start"), false);
  } catch (error) { throw new Error(`${error.message}; calls=${JSON.stringify(api.calls)}; events=${JSON.stringify(pi.events)}; stderr=${pi.stderr()}`); }
  finally { await pi.stop(); await api.close(); }
});

for (const failure of ["rejectWake", "rejectDrain"]) {
  test(`native Pi ${failure} preserves confirmed claim evidence but never admits work`, { skip: unavailable && "native Pi or bundle unavailable" }, async (t) => {
    const api = await fakeParle({ [failure]: true });
    if (api.unavailable) return t.skip(`localhost unavailable: ${api.error.code}`);
    const pi = start(api, { watch: true });
    try {
      await waitFor(() => pi.events.some(event => event.type === "extension_error"), "postclaim refusal");
      const phases = pi.events.filter(event => event.statusKey === "parle-alias-launch").map(event => JSON.parse(event.statusText).phase);
      assert.deepEqual(phases, ["claimed"]);
      pi.send({id: "blocked", type: "prompt", message: "must not reach a model"});
      await waitFor(() => pi.events.some(event => event.id === "blocked"), "refused input response");
      assert.equal(api.calls.filter(call => call.path.endsWith("/claim-alias")).length, 1);
      assert.equal(pi.events.some(event => event.type === "agent_start" || event.type === "turn_start"), false);
      assert.equal(api.calls.some(call => call.path.includes("/ack") || call.path.includes("/release")), false);
    } catch (error) { throw new Error(`${error.message}; calls=${JSON.stringify(api.calls)}; events=${JSON.stringify(pi.events)}; stderr=${pi.stderr()}`); }
    finally { await pi.stop(); await api.close(); }
  });
}
