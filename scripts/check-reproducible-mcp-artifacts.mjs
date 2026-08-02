import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalArtifact = "packages/mcp-server/dist/parle-mcp.js";
const wrapperArtifacts = [
  "packages/claude-plugin/dist/parle-mcp.js",
  "packages/claude-desktop-extension/server/parle-mcp.js",
  "packages/command-code/skills/parle/server/parle-mcp.js",
  "packages/codex-plugin/dist/parle-mcp.js",
];
const staleSentinel = "stale-ignored-client-dist-fixture";

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: process.env });
}

function copyWorkingTree(targetRoot) {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  for (const relativePath of listed.split("\0").filter(Boolean)) {
    const source = resolve(repoRoot, relativePath);
    if (!existsSync(source)) continue;
    const target = resolve(targetRoot, relativePath);
    const stat = lstatSync(source);
    mkdirSync(dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (stat.isFile()) {
      copyFileSync(source, target);
      chmodSync(target, stat.mode);
    }
  }
}

function assertArtifactsMatch(root) {
  const canonicalBytes = readFileSync(resolve(root, canonicalArtifact));
  for (const relativePath of wrapperArtifacts) {
    const wrapperBytes = readFileSync(resolve(root, relativePath));
    if (!canonicalBytes.equals(wrapperBytes)) {
      throw new Error(`${relativePath} differs from the clean canonical MCP build. Run pnpm refresh:mcp-artifacts and commit the required wrapper version and changelog updates.`);
    }
  }
}

function seedStaleClientDist(root) {
  run("pnpm", ["-F", "@parlehq/agent-client", "build"], root);
  const fixturePath = resolve(root, "packages/client/dist/protocol.js");
  const compiled = readFileSync(fixturePath, "utf8");
  const changed = compiled.replace(
    /DEFAULT_VERSION\s*=\s*"[^"]+"/,
    `DEFAULT_VERSION = "${staleSentinel}"`,
  );
  if (changed === compiled) throw new Error("Could not seed the stale client dist fixture because the compiled protocol version shape changed.");
  writeFileSync(fixturePath, changed);
}

function assertStaleFixtureWasRebuilt(root) {
  const canonicalBytes = readFileSync(resolve(root, canonicalArtifact), "utf8");
  if (canonicalBytes.includes(staleSentinel)) {
    throw new Error("The canonical MCP build consumed stale ignored client dist output instead of rebuilding @parlehq/agent-client first.");
  }
}

function assertDivergenceDetection(root) {
  const probeTarget = wrapperArtifacts[0];
  appendFileSync(resolve(root, probeTarget), "\n// reproducibility-gate-divergence-probe\n");
  try {
    assertArtifactsMatch(root);
  } catch (error) {
    if (error instanceof Error && error.message.includes(probeTarget)) return;
    throw error;
  }
  throw new Error("The reproducibility gate did not reject a modified tracked wrapper artifact.");
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "parle-adapters-artifact-check-"));
try {
  copyWorkingTree(isolatedRoot);
  run("pnpm", ["install", "--filter", "@parlehq/mcp-server...", "--frozen-lockfile", "--offline"], isolatedRoot);
  seedStaleClientDist(isolatedRoot);
  run("pnpm", ["build:mcp"], isolatedRoot);
  assertStaleFixtureWasRebuilt(isolatedRoot);
  assertArtifactsMatch(isolatedRoot);
  assertDivergenceDetection(isolatedRoot);
  console.log("Clean MCP artifact reproducibility, stale-dist isolation, and wrapper divergence checks passed.");
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
