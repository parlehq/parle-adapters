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
// Hook-runtime mirrors: every wrapper copy must be byte-identical to the
// canonical script so a release can never ship a stale hook or peers helper.
const hookMirrorSets = [
  {
    canonical: "packages/mcp-server/hooks/parle-hook.mjs",
    mirrors: [
      "packages/claude-plugin/hooks/parle-hook.mjs",
      "packages/command-code/skills/parle/scripts/parle-hook.mjs",
      "packages/codex-plugin/hooks/parle-hook.mjs",
    ],
  },
  {
    canonical: "packages/mcp-server/hooks/parle-peers.mjs",
    mirrors: [
      "packages/claude-plugin/hooks/parle-peers.mjs",
      "packages/command-code/skills/parle/scripts/parle-peers.mjs",
      "packages/codex-plugin/hooks/parle-peers.mjs",
    ],
  },
];
const piArtifact = "packages/pi-extension/dist/index.js";
const piArtifactChecker = "packages/pi-extension/scripts/check-pi-artifact.mjs";
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

function assertPiArtifactFresh(root) {
  run("node", [piArtifactChecker], root);
}

function assertPiDivergenceDetection(root) {
  appendFileSync(resolve(root, piArtifact), "\n// reproducibility-gate-divergence-probe\n");
  try {
    execFileSync("node", [piArtifactChecker], { cwd: root, stdio: "pipe", env: process.env });
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : String(error?.stderr || "");
    if (stderr.includes("Pi extension bundle is stale")) return;
    throw error;
  }
  throw new Error("The reproducibility gate did not reject a modified tracked Pi artifact.");
}

const isolatedRoot = mkdtempSync(join(tmpdir(), "parle-adapters-artifact-check-"));
try {
  copyWorkingTree(isolatedRoot);
  run("pnpm", ["install", "--filter", "@parlehq/mcp-server...", "--filter", "@parlehq/pi-extension...", "--frozen-lockfile", "--offline"], isolatedRoot);
  seedStaleClientDist(isolatedRoot);
  run("pnpm", ["build:mcp"], isolatedRoot);
  assertStaleFixtureWasRebuilt(isolatedRoot);
  assertPiArtifactFresh(isolatedRoot);
  assertArtifactsMatch(isolatedRoot);
  assertDivergenceDetection(isolatedRoot);
  assertPiDivergenceDetection(isolatedRoot);
  for (const set of hookMirrorSets) {
  const canonicalBytes = readFileSync(resolve(repoRoot, set.canonical));
  for (const mirror of set.mirrors) {
    const mirrorBytes = readFileSync(resolve(repoRoot, mirror));
    if (!canonicalBytes.equals(mirrorBytes)) {
      throw new Error(`Hook mirror ${mirror} diverges from ${set.canonical}. Run pnpm refresh:mcp-artifacts.`);
    }
  }
}

console.log("Clean MCP and Pi artifact reproducibility, hook/helper mirror parity, stale-dist isolation, and divergence checks passed.");
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
