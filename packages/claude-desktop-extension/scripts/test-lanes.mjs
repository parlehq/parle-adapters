import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DESKTOP_TEST_LANES = [
  { id: "prepare-scan-roots", clean: ["out/staging", "out/unpacked"] },
  { id: "artifact-parity", node: ["scripts/check-mcp-artifact.mjs"] },
  { id: "runner-regression", node: ["--test", "test/test-lanes.test.mjs"] },
  { id: "source-secret-scan", prerequisites: ["prepare-scan-roots"], node: ["scripts/secret-scan.mjs", "."] },
  { id: "smoke", node: ["scripts/smoke-server.mjs"] },
  { id: "pack", prerequisites: ["artifact-parity"], after: ["source-secret-scan", "smoke"], pnpm: ["run", "pack:mcpb"] },
  { id: "unpack", prerequisites: ["prepare-scan-roots", "pack"], pnpm: ["dlx", "@anthropic-ai/mcpb@2.1.2", "unpack", "out/parle-claude-desktop-extension.mcpb", "out/unpacked"] },
  { id: "archive-inspection", prerequisites: ["unpack"], node: ["scripts/inspect-pack.mjs", "out/unpacked"] },
  { id: "packaged-secret-scan", prerequisites: ["unpack"], node: ["scripts/secret-scan.mjs", "out/staging", "out/unpacked"] },
];

export function validateLanePlan(lanes) {
  const positions = new Map();
  lanes.forEach((lane, index) => {
    if (!lane.id || positions.has(lane.id)) throw new Error(`Duplicate or missing lane id: ${lane.id || "<missing>"}`);
    positions.set(lane.id, index);
  });
  lanes.forEach((lane, index) => {
    for (const dependency of [...(lane.prerequisites || []), ...(lane.after || [])]) {
      if (!positions.has(dependency)) throw new Error(`${lane.id} references unknown lane ${dependency}`);
      if (positions.get(dependency) >= index) throw new Error(`${lane.id} must run after ${dependency}`);
    }
  });
}

export function runLanePlan(lanes, execute = executeLane) {
  validateLanePlan(lanes);
  const results = [];
  const byId = new Map();
  for (const lane of lanes) {
    const blocked = (lane.prerequisites || []).map((id) => byId.get(id)).filter((result) => result?.status !== "passed");
    let result;
    if (blocked.length) {
      result = { id: lane.id, status: "not executed", reason: `prerequisite ${blocked.map((item) => `${item.id} ${item.status}`).join(", ")}` };
    } else {
      try {
        const outcome = execute(lane);
        result = outcome.ok ? { id: lane.id, status: "passed" } : { id: lane.id, status: "failed", reason: outcome.reason || "command failed" };
      } catch (error) {
        result = { id: lane.id, status: "failed", reason: error.message };
      }
    }
    results.push(result);
    byId.set(lane.id, result);
  }
  return results;
}

export function formatLaneSummary(results) {
  return [
    "Claude Desktop required lane summary",
    ...results.map((result) => `${result.status.padEnd(12)} ${result.id}${result.reason ? `: ${result.reason}` : ""}`),
  ].join("\n");
}

function executeLane(lane) {
  if (lane.clean) {
    for (const path of lane.clean) rmSync(resolve(root, path), { recursive: true, force: true });
    return { ok: true };
  }
  let command = process.execPath;
  let args = lane.node;
  if (lane.pnpm) {
    if (process.env.npm_execpath) args = [process.env.npm_execpath, ...lane.pnpm];
    else {
      command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      args = lane.pnpm;
    }
  }
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  return {
    ok: !result.error && result.status === 0,
    reason: result.error?.message || (result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`),
  };
}

function main() {
  let results;
  try {
    results = runLanePlan(DESKTOP_TEST_LANES);
  } catch (error) {
    results = DESKTOP_TEST_LANES.map((lane) => ({ id: lane.id, status: "not executed", reason: `invalid lane plan: ${error.message}` }));
  }
  console.log(`\n${formatLaneSummary(results)}`);
  if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
