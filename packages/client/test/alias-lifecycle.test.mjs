import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParleAgentClient, aliasLifecycleStatePath, readAliasLifecycleState, recordAliasAssumption, transitionAliasState } from "../dist/index.js";

const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";
const API = "https://api.parle.sh";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parle-alias-lifecycle-"));
  const state = join(root, ".parle");
  mkdirSync(state, { mode: 0o700 });
  const catalog = join(state, "profiles");
  const path = aliasLifecycleStatePath(catalog, API, [ROOM], [createHash("sha256").update("agent-token").digest("hex")]);
  return { root, catalog, path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("identity-bound state fences old responses and contains no credentials", () => {
  const f = fixture();
  const now = "2026-01-01T00:00:00Z";
  try {
    const instruction = randomUUID();
    const requested = recordAliasAssumption(f.path, "worker", ROOM, 3, instruction, now);
    assert.equal(requested.state, "requested");
    const pending = transitionAliasState(f.path, requested, "outcome_unknown", now);
    assert.equal(readAliasLifecycleState(f.path).state.operationId, instruction);
    const lost = transitionAliasState(f.path, pending, "lost", now);
    assert.equal(lost.lostGeneration, 3);
    assert.equal(recordAliasAssumption(f.path, "worker", ROOM, 3, instruction, now), undefined);
    const newer = recordAliasAssumption(f.path, "worker", ROOM, 4, randomUUID(), now);
    assert.equal(transitionAliasState(f.path, lost, "held", now, 4), undefined);
    assert.equal(readAliasLifecycleState(f.path).state.instructionRef, newer.instructionRef);
    const recreated = randomUUID();
    assert.ok(recordAliasAssumption(f.path, "worker", recreated, 5, randomUUID(), now));
    const stored = JSON.parse(readFileSync(f.path, "utf8"));
    assert.equal(stored.records[ROOM].requestedGeneration, 4);
    assert.equal(stored.records[recreated].requestedGeneration, 5);
    assert.ok(transitionAliasState(f.path, newer, "refused", now));
    for (let i = 0; i < 80; i++) {
      const entry = recordAliasAssumption(f.path, "worker", randomUUID(), i, randomUUID(), now);
      assert.ok(entry);
      assert.ok(transitionAliasState(f.path, entry, "held", now, i + 1));
    }
    const bounded = JSON.parse(readFileSync(f.path, "utf8")).records;
    assert.equal(Object.keys(bounded).length, 16);
    assert.equal(bounded[recreated].state, "requested", "unresolved diagnostics survive settled history eviction");
    assert.equal(transitionAliasState(f.path, newer, "held", now, 5), undefined, "eviction cannot authorize an old completion");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(f.path, "utf8"), /parle_ses_|parle_agt_|cookie/i);
    assert.notEqual(f.path, aliasLifecycleStatePath(f.catalog, API, [ROOM], ["other-agent"]));
    assert.notEqual(f.path, aliasLifecycleStatePath(f.catalog, API, [randomUUID()], ["agent-token"]));
    writeFileSync(f.path, '{"version":3,"secret":"no"}\n', { mode: 0o600 });
    assert.equal(readAliasLifecycleState(f.path).available, false);
  } finally { f.cleanup(); }
});

test("configured aliases are requested only; bootstrap and recovery never claim them", async () => {
  const f = fixture();
  let sessions = 0;
  const client = new ParleAgentClient({
    cwd: f.root,
    env: { HOME: f.root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "agent-token", PARLE_SESSION_ALIAS: "worker" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path.includes("session-aliases") || path.endsWith("claim-alias")) throw new Error(`unexpected alias authority request: ${path}`);
      if (path === "/v/agent/sessions") return json({ agent_session_id: `s-${++sessions}`, session_credential: `parle_ses_${sessions}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.includes("/projection")) return json({ messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    assert.equal(client.runtime.sessionAlias, undefined);
    assert.equal(client.status().alias.configured, "worker");
    assert.match(client.status().warnings.join(" "), /requested but inactive/);
    await client.performProactiveRollover();
    assert.equal(sessions, 2);
    assert.equal(client.runtime.sessionAlias, undefined);
  } finally {
    await client.endSession().catch(() => undefined);
    f.cleanup();
  }
});

test("automatic rollover reuses its held identity and generation without alias lookup", async () => {
  const f = fixture();
  let sessions = 0;
  const claims = [];
  const ended = [];
  const client = new ParleAgentClient({
    cwd: f.root,
    env: { HOME: f.root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "agent-token" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json({ agent_session_id: `s-${++sessions}`, session_credential: `parle_ses_${sessions}`, session_handle: `h-${sessions}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: `p-${sessions}`, baseline_seq: 0 }, 201);
      if (path.includes("/projection")) return json({ messages: [] });
      if (path === "/v/agent/wake") return new Response(": ready\n\n", { status: 200 });
      if (path === "/v/agent/session-aliases/worker") {
        assert.equal(claims.length, 0, "only explicit assume may inspect the current alias fence");
        return json({ alias: "worker", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: 3, current_agent_session_id: "other" });
      }
      if (path.endsWith("/claim-alias")) {
        claims.push({ candidate: path.split("/").at(-2), body: JSON.parse(init.body) });
        return json({ agent_session_id: `s-${sessions}`, alias: "worker", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: claims.length + 3, expires_at: "2099-01-01T00:00:00Z" });
      }
      if (path.includes("/responsive-delivery")) return json({ delivery: { cursor_scope: "alias" }, messages: [] });
      if (path.endsWith("/end")) { ended.push(path.split("/").at(-2)); return new Response(null, { status: 204 }); }
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await client.switchSessionAlias("worker");
    await client.performProactiveRollover();
    assert.deepEqual(claims, [
      { candidate: "s-1", body: { alias: "worker", expected_generation: 3 } },
      { candidate: "s-2", body: { alias: "worker", expected_generation: 4 } },
    ]);
    assert.deepEqual(ended, [], "the predecessor remains available for exact-session work");
  } finally {
    await client.endSession().catch(() => undefined);
    f.cleanup();
  }
});

test("explicit assume records policy and a conflict marks claim loss without retry authority", async () => {
  const f = fixture();
  const client = new ParleAgentClient({
    cwd: f.root,
    env: { HOME: f.root, PARLE_ROOM_ID: ROOM, PARLE_ROOM_AGENT_TOKEN: "agent-token" },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v/agent/sessions") return json({ agent_session_id: "s-1", session_credential: "parle_ses_1", expires_at: "2099-01-01T00:00:00Z" }, 201);
      if (path.endsWith("/participants")) return json({ participant_id: "p", baseline_seq: 0 }, 201);
      if (path.includes("/projection")) return json({ messages: [] });
      if (path === "/v/agent/session-aliases/worker") return json({ alias: "worker", alias_identity_id: "019f2946-aef5-77ad-a41d-747ce0fd6a1e", generation: 3, current_agent_session_id: "other" });
      if (path.endsWith("/claim-alias")) return json({ error: { code: "alias_conflict", message: "taken", retryable: false } }, 409);
      if (path.endsWith("/end")) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${path}`);
    },
  });
  try {
    await client.connect();
    await assert.rejects(client.switchSessionAlias("worker"), (error) => error.status === 409);
    assert.equal(readAliasLifecycleState(f.path).state.state, "refused");
    assert.equal(client.status().alias.active, undefined);
    assert.equal(client.aliasLifecycleState.state, "refused");
  } finally {
    await client.endSession().catch(() => undefined);
    f.cleanup();
  }
});
