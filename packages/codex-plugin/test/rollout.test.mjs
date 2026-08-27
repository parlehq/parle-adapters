import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDiagnostics, extractCodeModeCalls, parseRollout } from "../dogfood/rollout.mjs";

const fixtures = resolve(fileURLToPath(new URL("./fixtures/rollout/", import.meta.url)));

function loadFixture(name) {
  return parseRollout(readFileSync(resolve(fixtures, `${name}.jsonl`), "utf8"));
}

function evaluateOne(fixture, check) {
  const [row] = evaluateDiagnostics(loadFixture(fixture), [check]);
  assert.equal(row.kind, check.kind);
  return row;
}

test("rollout parser extracts function calls, outputs by call id, and role messages", () => {
  const parsed = loadFixture("tool-calls-pass");
  assert.deepEqual(parsed.toolCalls.map((call) => call.name), [
    "mcp__parle__parle_connect",
    "mcp__parle__parle_inbox",
    "mcp__parle__parle_inbox",
    "mcp__parle__parle_reply",
  ]);
  assert.deepEqual(parsed.toolCalls[2].args, { waitSeconds: 30, limit: 5 });
  assert.equal(parsed.toolCalls[1].ts, "2026-08-27T20:00:03.000Z");
  assert.deepEqual(parsed.toolResults.map((result) => [result.name, result.text]), [
    ["mcp__parle__parle_connect", "Connected to Parle"],
    ["mcp__parle__parle_inbox", "No new messages."],
    ["mcp__parle__parle_inbox", "1 message: beacon-FIXTURE"],
    ["mcp__parle__parle_reply", "Replied."],
  ]);
  assert.deepEqual(parsed.agentMessages, ["Replied to the peer with its beacon."]);
  assert.deepEqual(parsed.developerMessages, []);
});

test("rollout parser tolerates blank and non-JSON lines and non-response items", () => {
  const parsed = parseRollout(["", "not json", JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })]);
  assert.deepEqual(parsed, { toolCalls: [], toolResults: [], agentMessages: [], developerMessages: [], userMessages: [] });
});

test("rollout parser extracts code-mode tool calls from exec input", () => {
  assert.deepEqual(extractCodeModeCalls("await tools.mcp__parle__parle_inbox({ waitSeconds: 30, filter: 'direct', });"), [
    { name: "mcp__parle__parle_inbox", args: { waitSeconds: 30, filter: "direct" } },
  ]);
  assert.deepEqual(extractCodeModeCalls("tools.mcp__parle__parle_status()"), [{ name: "mcp__parle__parle_status", args: {} }]);
  assert.deepEqual(extractCodeModeCalls("tools.mcp__parle__parle_send({ body: `x(${y})` })")[0].args, { _raw: "{ body: `x(${y})` }" });

  const parsed = loadFixture("code-mode");
  assert.deepEqual(parsed.toolCalls.map((call) => [call.name, call.via, call.args]), [
    ["mcp__parle__parle_status", "exec", {}],
    ["mcp__parle__parle_inbox", "exec", { waitSeconds: 30, limit: 5 }],
    ["mcp__parle__parle_inbox", "exec", { waitSeconds: 30, filter: "direct" }],
    ["exec_command", "exec", { cmd: "ls -la" }],
  ]);
  assert.deepEqual(parsed.toolResults.map((result) => result.name), [
    "mcp__parle__parle_status",
    "mcp__parle__parle_inbox",
    "mcp__parle__parle_inbox",
    "exec_command",
  ]);
  const rows = evaluateDiagnostics(parsed, [
    { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 2, argsSubset: { waitSeconds: 30 } },
    { kind: "status-text", contains: ["Acting as     @fixture.codex", "idle wake unavailable"], excludes: ["idle wake unarmed"] },
    { kind: "no-shell-polling" },
  ]);
  assert.deepEqual(rows.map((row) => row.pass), [true, true, true]);
});

const kinds = [
  { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 2, argsSubset: { waitSeconds: 30 } },
  { kind: "no-shell-polling" },
  { kind: "status-text", contains: ["Acting as     @fixture.codex", "idle wake unavailable"], excludes: ["arm or verify", "idle wake unarmed"] },
  { kind: "agent-message", containsAny: ["mismatch", "does not match", "could not confirm"] },
  { kind: "hook-delivery-present" },
];

for (const check of kinds) {
  test(`diagnostic ${check.kind} passes its passing fixture and fails its failing fixture`, () => {
    const pass = evaluateOne(`${check.kind}-pass`, check);
    assert.equal(pass.pass, true, pass.detail);
    const fail = evaluateOne(`${check.kind}-fail`, check);
    assert.equal(fail.pass, false, fail.detail);
    assert.equal(typeof fail.detail, "string");
    assert.notEqual(fail.detail, "");
  });
}

test("diagnostic tool-calls honors max and argsSubset", () => {
  const once = evaluateOne("tool-calls-fail", { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 1, max: 1 });
  assert.equal(once.pass, true, once.detail);
  const twice = evaluateOne("tool-calls-pass", { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 1, max: 1 });
  assert.equal(twice.pass, false);
  assert.match(twice.detail, /2 call\(s\).*in \[1, 1\]/);
  const subset = evaluateOne("tool-calls-fail", { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 1, argsSubset: { waitSeconds: 30 } });
  assert.equal(subset.pass, false);
  assert.match(subset.detail, /0 call\(s\)/);
});

test("diagnostic no-shell-polling names the offending command", () => {
  const row = evaluateOne("no-shell-polling-fail", { kind: "no-shell-polling" });
  assert.match(row.detail, /while true; do curl/);
});

test("diagnostic agent-message requires all of contains and one of containsAny", () => {
  const all = evaluateOne("agent-message-pass", { kind: "agent-message", contains: ["Identity mismatch", "did not post"] });
  assert.equal(all.pass, true, all.detail);
  const partial = evaluateOne("agent-message-pass", { kind: "agent-message", contains: ["Identity mismatch", "posted hello"] });
  assert.equal(partial.pass, false);
  assert.match(partial.detail, /missing \["posted hello"\]/);
});

test("diagnostic rows fail closed on missing evidence and unknown kinds", () => {
  const rows = evaluateDiagnostics(parseRollout([]), [
    { kind: "status-text", contains: ["x"] },
    { kind: "agent-message", contains: ["x"] },
    { kind: "hook-delivery-present" },
    { kind: "tool-calls", tool: "mcp__parle__parle_inbox", min: 0 },
    { kind: "made-up" },
  ]);
  assert.deepEqual(rows.map((row) => row.pass), [false, false, false, true, false]);
  assert.match(rows[4].detail, /unknown diagnostic kind/);
});
