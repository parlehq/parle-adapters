import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = join(root, "pnpm-exec-summary.json");

export function loadWorkspacePackages(workspaceRoot = root) {
  return readdirSync(join(workspaceRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(workspaceRoot, "packages", entry.name);
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
        ...manifest.peerDependencies,
      };
      return {
        dir,
        name: manifest.name,
        workspaceDependencies: Object.entries(dependencies)
          .filter(([, version]) => String(version).startsWith("workspace:"))
          .map(([name]) => name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeWorkspacePackages(packages, executionStatus) {
  const reported = new Map(
    Object.entries(executionStatus).map(([path, result]) => [realpathSync(path), result]),
  );
  const rows = packages.map((pkg) => {
    const result = reported.get(realpathSync(pkg.dir));
    if (!result) return { ...pkg, status: "not executed", reason: "pnpm did not report this required package" };
    if (result.status === "passed") return { ...pkg, status: "passed" };
    if (result.status === "failure") {
      const exit = result.error?.errno;
      return { ...pkg, status: "failed", reason: Number.isInteger(exit) ? `exit ${exit}` : result.message || "pnpm reported failure" };
    }
    if (result.status === "skipped") return { ...pkg, status: "not executed", reason: "required test script missing" };
    return { ...pkg, status: "not executed", reason: `pnpm reported unsupported status ${JSON.stringify(result.status)}` };
  });

  const byName = new Map(rows.map((row) => [row.name, row]));
  const ancestors = (row, seen = new Set()) => {
    const found = [];
    for (const name of row.workspaceDependencies) {
      if (seen.has(name)) continue;
      seen.add(name);
      const dependency = byName.get(name);
      if (!dependency) continue;
      found.push(dependency, ...ancestors(dependency, seen));
    }
    return found;
  };
  for (const row of rows) {
    const uncertain = [...new Map(ancestors(row).filter((item) => item.status !== "passed").map((item) => [item.name, item])).values()];
    if (uncertain.length) row.annotation = `result may not be independent: ${uncertain.map((item) => `${item.name} ${item.status}`).join(", ")}`;
  }
  return rows;
}

export function formatWorkspaceSummary(regression, rows) {
  return [
    "Workspace required test summary",
    `${regression.status.padEnd(12)} workspace evidence regression${regression.reason ? `: ${regression.reason}` : ""}`,
    ...rows.map((row) => `${row.status.padEnd(12)} ${row.name}${row.reason ? `: ${row.reason}` : ""}${row.annotation ? ` (${row.annotation})` : ""}`),
  ].join("\n");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: "inherit" });
  return {
    ok: !result.error && result.status === 0,
    reason: result.error?.message || (result.signal ? `signal ${result.signal}` : `exit ${result.status ?? "unknown"}`),
    status: result.status,
  };
}

function pnpmCommand(args) {
  return process.env.npm_execpath
    ? [process.execPath, [process.env.npm_execpath, ...args]]
    : [process.platform === "win32" ? "pnpm.cmd" : "pnpm", args];
}

function main() {
  const packages = loadWorkspacePackages();
  const regressionRun = run(process.execPath, ["--test", "scripts/test-workspaces.test.mjs"]);
  const regression = regressionRun.ok ? { status: "passed" } : { status: "failed", reason: regressionRun.reason };
  rmSync(summaryPath, { force: true });
  const [command, args] = pnpmCommand(["-r", "--no-bail", "--sequential", "--report-summary", "test"]);
  const recursiveRun = run(command, args);
  let rows;
  try {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    rows = summarizeWorkspacePackages(packages, summary.executionStatus || {});
  } catch (error) {
    rows = packages.map((pkg) => ({ ...pkg, status: "not executed", reason: `workspace summary unavailable: ${error.message}` }));
  } finally {
    rmSync(summaryPath, { force: true });
  }
  console.log(`\n${formatWorkspaceSummary(regression, rows)}`);
  if (!regressionRun.ok || !recursiveRun.ok || rows.some((row) => row.status !== "passed")) process.exitCode = 1;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) main();
