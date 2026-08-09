import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../hooks/parle-hook.mjs", import.meta.url));
const ROOM = "019f2946-aef5-77ad-a41d-747ce0fd6a1e";

function registryEntry(address, overrides = {}) {
  return {
    apiOrigin: "https://api.parle.sh",
    roomId: ROOM,
    address,
    continuity: "durable",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixture(entries) {
  const home = mkdtempSync(join(tmpdir(), "parle-registry-hook-"));
  mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
  if (entries) writeFileSync(join(home, ".parle", "registry"), `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function runHook(home, payload, args = ["--known-address-context"], env = {}) {
  const output = execFileSync(process.execPath, [hookPath, ...args], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      HOME: home,
      PARLE_PROFILES_PATH: join(home, ".parle", "profiles"),
      PARLE_ROOM_ID: ROOM,
      PARLE_ROOM_AGENT_TOKEN: "parle_agt_test",
      COMMANDCODE_SESSION_ID: "",
      ...env,
    },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n")[0]);
}

test("supported hooks render bounded local known-address context at SessionStart", () => {
  const f = fixture([registryEntry("@principal.agent.alias")]);
  try {
    const result = runHook(f.home, { hook_event_name: "SessionStart", session_id: "", cwd: f.home });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /\[Parle known-address context\]/);
    assert.match(context, /@principal\.agent\.alias/);
    assert.match(context, /proves neither identity, authorization, liveness, nor deliverability/);
    assert.match(context, /Never reuse any other session-qualified route remembered from context/);
  } finally { f.cleanup(); }
});

test("known-address restoration requires the explicit supported-host flag and SessionStart", () => {
  const f = fixture([registryEntry("@principal.agent.alias")]);
  try {
    assert.deepEqual(runHook(f.home, { hook_event_name: "SessionStart", session_id: "", cwd: f.home }, []), {});
    assert.deepEqual(runHook(f.home, { hook_event_name: "UserPromptSubmit", session_id: "", cwd: f.home }), {});
    assert.deepEqual(runHook(f.home, { hook_event_name: "PreToolUse", session_id: "", cwd: f.home }), {});
    assert.deepEqual(runHook(f.home, { hook_event_name: "Stop", session_id: "", cwd: f.home }), {});
  } finally { f.cleanup(); }
});

test("hook resolves the registry beside a project-relative profile catalog", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-registry-dotenv-"));
  const project = join(home, "project");
  mkdirSync(join(project, "relocated"), { recursive: true, mode: 0o700 });
  writeFileSync(join(project, ".env"), `PARLE_PROFILES_PATH=./relocated/profiles\nPARLE_ROOM_ID=${ROOM}\nPARLE_ROOM_AGENT_TOKEN=parle_agt_test\n`);
  writeFileSync(join(project, "relocated", "registry"), `${JSON.stringify({ version: 1, entries: [registryEntry("@principal.agent.relocated")] })}\n`, { mode: 0o600 });
  mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".parle", "registry"), `${JSON.stringify({ version: 1, entries: [registryEntry("@principal.agent.stale")] })}\n`, { mode: 0o600 });
  try {
    const output = execFileSync(process.execPath, [hookPath, "--known-address-context"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "", cwd: project }),
      cwd: project,
      env: { ...process.env, HOME: home, PARLE_PROFILES_PATH: "", PARLE_ROOM_ID: "", PARLE_ROOM_AGENT_TOKEN: "", COMMANDCODE_SESSION_ID: "" },
      encoding: "utf8",
    });
    const context = JSON.parse(output.trim().split("\n")[0]).hookSpecificOutput.additionalContext;
    assert.match(context, /@principal\.agent\.relocated/);
    assert.doesNotMatch(context, /@principal\.agent\.stale/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("unsafe registry custody renders unavailable without reading legacy peer files", { skip: process.platform === "win32" }, () => {
  const f = fixture([registryEntry("@principal.agent.alias")]);
  try {
    chmodSync(join(f.home, ".parle", "registry"), 0o644);
    writeFileSync(join(f.home, ".parle", "peers"), "legacy bytes must stay irrelevant", { mode: 0o600 });
    const result = runHook(f.home, { hook_event_name: "SessionStart", session_id: "", cwd: f.home });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /local registry is unavailable/);
    assert.doesNotMatch(context, /legacy bytes/);
  } finally { f.cleanup(); }
});
