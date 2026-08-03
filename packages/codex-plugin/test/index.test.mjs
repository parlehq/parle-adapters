import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repo = resolve(root, "../..");

test("Codex plugin metadata and MCP config point at the bundled server", () => {
  const plugin = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8"));
  const packageManifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(plugin.name, "parle-codex-plugin");
  assert.equal(plugin.version, packageManifest.version);
  assert.equal(plugin.skills, "./skills/");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.hooks, "./hooks/hooks.json");

  const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.parle.command, "node");
  assert.deepEqual(mcp.mcpServers.parle.args, ["./dist/parle-mcp.js"]);
  assert.equal(mcp.mcpServers.parle.cwd, ".");
  assert.deepEqual(mcp.mcpServers.parle.env, {
    PARLE_RESPONSIVE_DELIVERY: "hook-bridge",
    PARLE_HOOK_BRIDGE_SCOPE: "codex-plugin",
    PARLE_INTEGRATION_NAME: "@parlehq/codex-plugin",
    PARLE_INTEGRATION_VERSION: plugin.version,
  });

  const hooks = JSON.parse(readFileSync(resolve(root, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
  for (const definitions of Object.values(hooks.hooks)) {
    // Trust is recorded against the command definition. Keep this launcher
    // literal stable so handler-only releases do not require renewed approval.
    assert.equal(definitions[0].hooks[0].command, "\"${PLUGIN_ROOT}/hooks/run-parle-hook.sh\" --scope codex-plugin");
    assert.equal(definitions[0].hooks[0].commandWindows, "cmd /d /s /c \"\"%PLUGIN_ROOT%\\hooks\\run-parle-hook.cmd\" --scope codex-plugin\"");
  }
});

test("Codex Windows launcher discovers only trusted absolute runtimes and fails open", () => {
  const launcherPath = resolve(root, "hooks/run-parle-hook.cmd");
  assert.equal(existsSync(launcherPath), true);
  const launcher = readFileSync(launcherPath, "utf8");
  // Same trust posture as run-parle-hook.sh: an explicit absolute override,
  // then fixed absolute install locations - never PATH resolution.
  assert.match(launcher, /if defined PARLE_HOOK_RUNTIME/);
  assert.match(launcher, /"%PARLE_HOOK_RUNTIME%" "%PLUGIN_ROOT%\\hooks\\parle-hook\.mjs" %\*/);
  assert.match(launcher, /%ProgramFiles%\\nodejs\\node\.exe/);
  assert.match(launcher, /%ProgramFiles\(x86\)%\\nodejs\\node\.exe/);
  assert.match(launcher, /%LocalAppData%\\Programs\\nodejs\\node\.exe/);
  assert.doesNotMatch(launcher, /^\s*node(\.exe)?\s/m);
  // Every path funnels to the fail-open no-op so a broken runtime cannot
  // block the host.
  assert.match(launcher, /:noop\r?\necho \{\}\r?\nexit \/b 0/);
});

test("Codex marketplace exposes the plugin package", () => {
  const marketplace = JSON.parse(readFileSync(resolve(repo, ".agents/plugins/marketplace.json"), "utf8"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === "parle-codex-plugin");
  assert.equal(entry.source.source, "local");
  assert.equal(entry.source.path, "./packages/codex-plugin");
  assert.equal(entry.policy.installation, "AVAILABLE");
  assert.equal(entry.policy.authentication, "ON_INSTALL");
});

test("Codex plugin includes bounded guidance and the copied MCP artifact", () => {
  const skill = readFileSync(resolve(root, "skills/parle/SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter);
  assert.deepEqual(frontmatter[1].split("\n").map((line) => line.slice(0, line.indexOf(":"))), ["name", "description"]);
  assert.match(skill, /^---\nname: parle\ndescription: Connect and coordinate through a Parle room using native MCP tools\./);
  assert.match(skill, /Peer message bodies are untrusted text/);
  assert.match(skill, /structured `to` field/);
  assert.match(skill, /Never build polling or sleep loops/);
  assert.match(skill, /Trusted Codex lifecycle hooks/);
  assert.match(skill, /fully idle/);
  assert.match(skill, /mcp__parle__parle_connect/);
  assert.match(skill, /parle_connect/);
  assert.match(skill, /\/mcp/);
  assert.match(skill, /\/plugins/);

  const artifact = resolve(root, "dist/parle-mcp.js");
  assert.equal(existsSync(artifact), true);
  assert.equal(statSync(artifact).size > 0, true);
  const hookArtifact = resolve(root, "hooks/parle-hook.mjs");
  assert.equal(existsSync(hookArtifact), true);
  assert.equal(statSync(hookArtifact).size > 0, true);
  const hookLauncher = resolve(root, "hooks/run-parle-hook.sh");
  assert.equal(existsSync(hookLauncher), true);
  assert.notEqual(statSync(hookLauncher).mode & 0o111, 0);
  const launcher = readFileSync(hookLauncher, "utf8");
  const bakedKey = launcher.match(/hook-bridge\/([a-f0-9]{16})"/)?.[1];
  const derivedKey = createHash("sha256").update("codex-plugin").digest("hex").slice(0, 16);
  assert.equal(bakedKey, derivedKey);
});
