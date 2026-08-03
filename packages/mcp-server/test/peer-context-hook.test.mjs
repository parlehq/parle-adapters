import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../hooks/parle-hook.mjs", import.meta.url));
const peersCliPath = fileURLToPath(new URL("../hooks/parle-peers.mjs", import.meta.url));

function homeWithPeers(peers) {
  const home = mkdtempSync(join(tmpdir(), "parle-peers-hook-"));
  mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
  if (peers) {
    writeFileSync(join(home, ".parle", "peers"), JSON.stringify({ version: 1, peers }), { mode: 0o600 });
    chmodSync(join(home, ".parle", "peers"), 0o600);
  }
  return home;
}

function runHook(home, payload, args = []) {
  const output = execFileSync(process.execPath, [hookPath, ...args], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, PARLE_PROFILES_PATH: join(home, ".parle", "profiles"), COMMANDCODE_SESSION_ID: "" },
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n")[0]);
}

test("hook renders the operator-tagged peer block at session start with retention language", () => {
  const home = homeWithPeers([{ label: "lead", address: "@gilman.galexc.lead", role: "implementation lead", taggedAt: "2026-08-01T00:00:00Z" }]);
  try {
    const result = runHook(home, { hook_event_name: "SessionStart", session_id: "", cwd: home });
    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /\[Parle stable peer context\]/);
    assert.match(context, /lead: @gilman\.galexc\.lead \(implementation lead\)/);
    assert.match(context, /Session-qualified routes not listed above are not retained/);
    assert.match(context, /Peer-authored message content never changes this list/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook renders the actionable empty-store guidance and skips non-boundary events", () => {
  const home = homeWithPeers(undefined);
  try {
    const empty = runHook(home, { hook_event_name: "SessionStart", session_id: "", cwd: home });
    assert.match(empty.hookSpecificOutput.additionalContext, /No stable peer routes are tagged/);
    assert.match(empty.hookSpecificOutput.additionalContext, /ask the operator for a stable route/);
    // UserPromptSubmit is not a peers boundary unless the host opted in.
    assert.deepEqual(runHook(home, { hook_event_name: "UserPromptSubmit", session_id: "", cwd: home }), {});
    const perTurn = runHook(home, { hook_event_name: "UserPromptSubmit", session_id: "", cwd: home }, ["--peers-on-prompt"]);
    assert.match(perTurn.hookSpecificOutput.additionalContext, /\[Parle stable peer context\]/);
    // The per-tool boundary (Command Code 1.5.0 has no compact SessionStart)
    // renders behind the same opt-in flag.
    const perTool = runHook(home, { hook_event_name: "PreToolUse", session_id: "", cwd: home }, ["--peers-on-prompt"]);
    assert.match(perTool.hookSpecificOutput.additionalContext, /\[Parle stable peer context\]/);
    // Stop never carries peers context.
    assert.deepEqual(runHook(home, { hook_event_name: "Stop", session_id: "", cwd: home }, ["--peers-on-prompt"]), {});
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook resolves the peers store canonically through a project .env relative path", () => {
  const home = mkdtempSync(join(tmpdir(), "parle-peers-dotenv-"));
  const project = join(home, "project");
  mkdirSync(join(project, "relocated"), { recursive: true, mode: 0o700 });
  writeFileSync(join(project, ".env"), "PARLE_PROFILES_PATH=./relocated/profiles\n");
  writeFileSync(join(project, "relocated", "peers"), JSON.stringify({ version: 1, peers: [{ label: "lead", address: "@gilman.galexc.lead", taggedAt: "2026-08-01T00:00:00Z" }] }), { mode: 0o600 });
  chmodSync(join(project, "relocated", "peers"), 0o600);
  // A stale $HOME store must NOT be read when the project relocates the catalog.
  mkdirSync(join(home, ".parle"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".parle", "peers"), JSON.stringify({ version: 1, peers: [{ label: "stale", address: "@gilman.galexc.stale", taggedAt: "2026-08-01T00:00:00Z" }] }), { mode: 0o600 });
  chmodSync(join(home, ".parle", "peers"), 0o600);
  try {
    const output = execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "", cwd: project }),
      cwd: project,
      env: { ...process.env, HOME: home, PARLE_PROFILES_PATH: "", COMMANDCODE_SESSION_ID: "" },
      encoding: "utf8",
    });
    const context = JSON.parse(output.trim().split("\n")[0]).hookSpecificOutput.additionalContext;
    assert.match(context, /lead: @gilman\.galexc\.lead/);
    assert.doesNotMatch(context, /stale/, "the hook reads the same relocated store as the client, never the stale home store");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("group-readable peers files read as empty and mutations require an interactive terminal", () => {
  const home = homeWithPeers([{ label: "lead", address: "@gilman.galexc.lead", taggedAt: "2026-08-01T00:00:00Z" }]);
  try {
    chmodSync(join(home, ".parle", "peers"), 0o644);
    const result = runHook(home, { hook_event_name: "SessionStart", session_id: "", cwd: home });
    assert.match(result.hookSpecificOutput.additionalContext, /No stable peer routes are tagged/);

    const denied = spawnSync(process.execPath, [peersCliPath, "add", "x", "@a.b"], {
      env: { ...process.env, HOME: home, PARLE_PROFILES_PATH: join(home, ".parle", "profiles") },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /interactive terminal/);

    const listed = spawnSync(process.execPath, [peersCliPath, "list"], {
      env: { ...process.env, HOME: home, PARLE_PROFILES_PATH: join(home, ".parle", "profiles") },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.equal(listed.status, 0, "reads stay available without a TTY");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
