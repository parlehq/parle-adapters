import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { summarizeWorkspacePackages } from "./test-workspaces.mjs";

test("matches real paths, fails skipped tests, and annotates downstream evidence", () => {
  const fixture = mkdtempSync(join(tmpdir(), "parle-workspace-summary-"));
  const real = join(fixture, "real");
  const alias = join(fixture, "alias");
  try {
    for (const name of ["upstream", "skipped", "missing", "unsupported", "downstream"]) mkdirSync(join(real, name), { recursive: true });
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const packages = [
      { name: "upstream", dir: join(alias, "upstream"), workspaceDependencies: [] },
      { name: "skipped", dir: join(alias, "skipped"), workspaceDependencies: [] },
      { name: "missing", dir: join(alias, "missing"), workspaceDependencies: [] },
      { name: "unsupported", dir: join(alias, "unsupported"), workspaceDependencies: [] },
      { name: "downstream", dir: join(alias, "downstream"), workspaceDependencies: ["upstream"] },
    ];
    const rows = summarizeWorkspacePackages(packages, {
      [join(real, "upstream")]: { status: "failure", error: { errno: 7 } },
      [join(real, "skipped")]: { status: "skipped" },
      [join(real, "unsupported")]: { status: "future-status" },
      [join(real, "downstream")]: { status: "passed" },
    });
    assert.deepEqual(rows.map(({ name, status, reason }) => ({ name, status, reason })), [
      { name: "upstream", status: "failed", reason: "exit 7" },
      { name: "skipped", status: "not executed", reason: "required test script missing" },
      { name: "missing", status: "not executed", reason: "pnpm did not report this required package" },
      { name: "unsupported", status: "not executed", reason: "pnpm reported unsupported status \"future-status\"" },
      { name: "downstream", status: "passed", reason: undefined },
    ]);
    assert.equal(rows[4].annotation, "result may not be independent: upstream failed");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
