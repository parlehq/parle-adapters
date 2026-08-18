import assert from "node:assert/strict";
import test from "node:test";
import { DESKTOP_TEST_LANES, formatLaneSummary, runLanePlan } from "../scripts/test-lanes.mjs";

const EXPECTED_LANES = [
  "prepare-scan-roots",
  "artifact-parity",
  "runner-regression",
  "source-secret-scan",
  "smoke",
  "pack",
  "unpack",
  "archive-inspection",
  "packaged-secret-scan",
];

test("production plan is complete and preserves pre-pack evidence", () => {
  assert.ok(EXPECTED_LANES.length > 0);
  assert.deepEqual(DESKTOP_TEST_LANES.map((lane) => lane.id), EXPECTED_LANES);
  const source = EXPECTED_LANES.indexOf("source-secret-scan");
  const pack = DESKTOP_TEST_LANES.find((lane) => lane.id === "pack");
  assert.ok(source < EXPECTED_LANES.indexOf("pack"));
  assert.deepEqual(pack.prerequisites, ["artifact-parity"]);
  assert.deepEqual(pack.after, ["source-secret-scan", "smoke"]);
});

test("smoke failure cannot hide packaged secret-scan evidence", () => {
  const executed = [];
  const results = runLanePlan(DESKTOP_TEST_LANES, (lane) => {
    executed.push(lane.id);
    if (lane.id === "smoke" || lane.id === "packaged-secret-scan") return { ok: false, reason: `forced ${lane.id} failure` };
    return { ok: true };
  });
  assert.ok(executed.indexOf("packaged-secret-scan") > executed.indexOf("smoke"));
  assert.equal(results.find((result) => result.id === "smoke").status, "failed");
  assert.equal(results.find((result) => result.id === "packaged-secret-scan").status, "failed");
  const summary = formatLaneSummary(results);
  assert.match(summary, /failed\s+smoke: forced smoke failure/);
  assert.match(summary, /failed\s+packaged-secret-scan: forced packaged-secret-scan failure/);
  assert.ok(results.some((result) => result.status !== "passed"));
});

test("artifact parity failure preserves later independent evidence and explains blocked lanes", () => {
  const executed = [];
  const results = runLanePlan(DESKTOP_TEST_LANES, (lane) => {
    executed.push(lane.id);
    return lane.id === "artifact-parity" ? { ok: false, reason: "forced parity failure" } : { ok: true };
  });
  assert.ok(executed.includes("source-secret-scan"));
  assert.ok(executed.includes("smoke"));
  assert.ok(!executed.includes("pack"));
  for (const id of ["pack", "unpack", "archive-inspection", "packaged-secret-scan"]) {
    const result = results.find((item) => item.id === id);
    assert.equal(result.status, "not executed");
    assert.match(result.reason, /prerequisite/);
  }
});
