import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SavedStartConfigError,
  SavedStartNotFoundError,
  deleteSavedStart,
  loadSavedStart,
  parseSavedStarts,
  readSavedStarts,
  resolveSavedStartCatalogPath,
  saveSavedStart,
  savedStartCatalogPath,
  serializeSavedStarts,
} from "../dist/index.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parle-launches-"));
  const parle = join(root, ".parle");
  mkdirSync(parle, { mode: 0o700 });
  return { root, path: join(parle, "launches"), profiles: join(parle, "profiles") };
}

test("saved-start catalog lives beside the selected profile catalog", () => {
  const { root, profiles } = fixture();
  try {
    assert.equal(savedStartCatalogPath(profiles), join(root, ".parle", "launches"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved-start catalog follows process and project profile-catalog overrides", () => {
  const { root } = fixture();
  try {
    writeFileSync(join(root, ".env"), "PARLE_PROFILES_PATH=./state/team-profiles\n");
    assert.equal(resolveSavedStartCatalogPath(root, { HOME: join(root, "home") }), join(root, "state", "launches"));
    assert.equal(resolveSavedStartCatalogPath(root, { HOME: join(root, "home"), PARLE_PROFILES_PATH: join(root, "private", "profiles") }), join(root, "private", "launches"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved starts parse independent optional profile, alias, and next fields", () => {
  const starts = parseSavedStarts(`
[galexc-guru]
profile = galexc-seedwork
alias = galexc-net-guru
next = load the GalexC Guru skill and initialize

[ask]
next = ask me what I want to work on

[standard]
profile = default

[current]
`);
  assert.deepEqual(starts.get("galexc-guru"), {
    name: "galexc-guru",
    profile: "galexc-seedwork",
    alias: "galexc-net-guru",
    next: "load the GalexC Guru skill and initialize",
  });
  assert.deepEqual(starts.get("ask"), { name: "ask", next: "ask me what I want to work on" });
  assert.deepEqual(starts.get("standard"), { name: "standard", profile: "default" });
  assert.deepEqual(starts.get("current"), { name: "current" });
});

test("saved starts reject unknown fields, invalid aliases, duplicate names, and multiline next values", () => {
  assert.throws(() => parseSavedStarts("[bad]\nscript = run\n"), SavedStartConfigError);
  assert.throws(() => parseSavedStarts("[bad]\nalias = Not Valid\n"), /alias must be/);
  assert.throws(() => parseSavedStarts("[same]\n[same]\n"), /duplicate saved start/);
  assert.throws(() => serializeSavedStarts([{ name: "bad", next: "one\ntwo" }]), /must fit on one line/);
});

test("save, load, list, replace, and delete use one owner-only catalog", () => {
  const { root, path } = fixture();
  try {
    assert.throws(
      () => loadSavedStart("missing", path),
      (error) => error instanceof SavedStartNotFoundError && error.message === `Parle saved start missing was not found in ${path}.\nNo saved starts are configured. Create one with /parle save <name>.`,
    );

    saveSavedStart({ name: "galexc-guru", profile: "galexc-seedwork", alias: "galexc-net-guru", next: "/galexc-guru" }, path);
    saveSavedStart({ name: "issue-collector", profile: "galexc-seedwork", alias: "issue-collector", next: "/issue-collector" }, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual([...readSavedStarts(path).keys()], ["galexc-guru", "issue-collector"]);
    assert.throws(
      () => loadSavedStart("missing", path),
      (error) => error instanceof SavedStartNotFoundError
        && error.message === `Parle saved start missing was not found in ${path}.\nAvailable saved starts:\n- galexc-guru\n- issue-collector`,
    );
    assert.equal(loadSavedStart("galexc-guru", path).next, "/galexc-guru");

    saveSavedStart({ name: "galexc-guru", profile: "galexc-seedwork", next: "say hello!" }, path);
    assert.deepEqual(loadSavedStart("galexc-guru", path), { name: "galexc-guru", profile: "galexc-seedwork", next: "say hello!" });
    assert.equal(readFileSync(path, "utf8").includes("agent_token"), false);

    assert.equal(deleteSavedStart("galexc-guru", path), true);
    assert.equal(deleteSavedStart("galexc-guru", path), false);
    assert.deepEqual([...readSavedStarts(path).keys()], ["issue-collector"]);
    assert.throws(
      () => loadSavedStart("missing", path),
      (error) => error instanceof SavedStartNotFoundError
        && error.availableSavedStarts.join(",") === "issue-collector"
        && error.message === `Parle saved start missing was not found in ${path}.\nAvailable saved starts:\n- issue-collector`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved-start catalog rejects loose permissions and symlinks", { skip: process.platform === "win32" }, () => {
  const loose = fixture();
  const linked = fixture();
  try {
    writeFileSync(loose.path, "[safe]\n", { mode: 0o600 });
    chmodSync(loose.path, 0o644);
    assert.throws(() => readSavedStarts(loose.path), /mode 600/);

    const target = join(linked.root, "target");
    writeFileSync(target, "[safe]\n", { mode: 0o600 });
    symlinkSync(target, linked.path);
    assert.throws(() => readSavedStarts(linked.path), /symbolic link/);
  } finally {
    rmSync(loose.root, { recursive: true, force: true });
    rmSync(linked.root, { recursive: true, force: true });
  }
});
