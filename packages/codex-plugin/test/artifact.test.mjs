import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const repo = resolve(root, "../..");
const builder = resolve(root, "scripts/build-artifact.mjs");

const expectedFiles = [
  ".agents/plugins/marketplace.json",
  "dogfood/rollout.mjs",
  "dogfood/scenarios.json",
  "dogfood/scenarios.schema.json",
  "plugins/parle-codex-plugin/.codex-plugin/plugin.json",
  "plugins/parle-codex-plugin/.mcp.json",
  "plugins/parle-codex-plugin/CHANGELOG.md",
  "plugins/parle-codex-plugin/README.md",
  "plugins/parle-codex-plugin/dist/parle-mcp.js",
  "plugins/parle-codex-plugin/hooks/hooks.json",
  "plugins/parle-codex-plugin/hooks/parle-hook.mjs",
  "plugins/parle-codex-plugin/hooks/run-parle-hook.cmd",
  "plugins/parle-codex-plugin/hooks/run-parle-hook.sh",
  "plugins/parle-codex-plugin/package.json",
  "plugins/parle-codex-plugin/skills/parle/SKILL.md",
];

function build(out) {
  // --allow-dirty: developer trees are routinely dirty while iterating; the
  // determinism claim under test is about the bytes, and metadata records it.
  execFileSync(process.execPath, [builder, "--out", out, "--allow-dirty"], { cwd: repo, stdio: "pipe" });
  const tarball = readdirSync(out).find((name) => name.endsWith(".tar.gz"));
  const bytes = readFileSync(join(out, tarball));
  return {
    name: tarball,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sidecar: readFileSync(join(out, `${tarball}.sha256`), "utf8"),
    metadata: JSON.parse(readFileSync(join(out, `${tarball}.metadata.json`), "utf8")),
  };
}

function readTar(gz) {
  const tar = gunzipSync(gz);
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const name = field(0, 100);
    const size = parseInt(field(124, 12), 8);
    entries.set(name, {
      mode: parseInt(field(100, 8), 8),
      uid: parseInt(field(108, 8), 8),
      gid: parseInt(field(116, 8), 8),
      mtime: parseInt(field(136, 12), 8),
      type: field(156, 1),
      content: tar.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("dogfood artifact builds byte-identically and carries exactly the installable plugin tree", () => {
  const outA = mkdtempSync(join(tmpdir(), "parle-codex-artifact-a-"));
  const outB = mkdtempSync(join(tmpdir(), "parle-codex-artifact-b-"));
  try {
    const first = build(outA);
    const second = build(outB);
    assert.equal(first.name, second.name);
    assert.equal(first.sha256, second.sha256, "two builds of the same tree must be byte-identical");
    assert.equal(first.metadata.sha256, first.sha256);
    // The uncompressed tar is the canonical identity; the .tar.gz bytes also
    // depend on Node's bundled zlib.
    const tarA = gunzipSync(first.bytes);
    assert.ok(tarA.equals(gunzipSync(second.bytes)), "two builds must produce identical tar streams");
    assert.equal(first.metadata.tarSha256, createHash("sha256").update(tarA).digest("hex"));
    assert.equal(first.metadata.tarSha256, second.metadata.tarSha256);
    assert.equal(first.sidecar, `${first.sha256}  ${first.name}\n`);
    assert.deepEqual(first.metadata.files, expectedFiles);

    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(first.name, `parle-codex-plugin-${version}-${head.slice(0, 12)}.tar.gz`);
    assert.equal(first.metadata.gitSha, head);
    assert.equal(typeof first.metadata.gitDirty, "boolean");
    const commitTime = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: repo, encoding: "utf8" }).trim());
    assert.equal(first.metadata.builtFromCommitTime, new Date(commitTime * 1000).toISOString());

    // gzip header: MTIME zero, no FNAME flag, OS unknown, so the container
    // itself carries no build-time or platform bytes.
    assert.deepEqual([...first.bytes.subarray(0, 10)], [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);

    const entries = readTar(first.bytes);
    const files = [...entries.entries()].filter(([, entry]) => entry.type === "0").map(([name]) => name);
    assert.deepEqual(files, expectedFiles);
    const directories = [...entries.entries()].filter(([, entry]) => entry.type === "5").map(([name]) => name);
    assert.deepEqual(directories, [
      ".agents/",
      ".agents/plugins/",
      "dogfood/",
      "plugins/",
      "plugins/parle-codex-plugin/",
      "plugins/parle-codex-plugin/.codex-plugin/",
      "plugins/parle-codex-plugin/dist/",
      "plugins/parle-codex-plugin/hooks/",
      "plugins/parle-codex-plugin/skills/",
      "plugins/parle-codex-plugin/skills/parle/",
    ]);
    for (const [name, entry] of entries) {
      assert.equal(entry.uid, 0, name);
      assert.equal(entry.gid, 0, name);
      assert.equal(entry.mtime, commitTime, name);
      assert.ok(entry.mode === 0o644 || entry.mode === 0o755, `${name} mode ${entry.mode.toString(8)}`);
    }
    assert.equal(entries.get("plugins/parle-codex-plugin/hooks/run-parle-hook.sh").mode, 0o755);
    assert.equal(entries.get("plugins/parle-codex-plugin/hooks/parle-hook.mjs").mode, 0o755);
    assert.equal(entries.get("plugins/parle-codex-plugin/hooks/run-parle-hook.cmd").mode, 0o644);
    assert.equal(entries.get("plugins/parle-codex-plugin/.codex-plugin/").mode, 0o755);

    // #169's env_vars travel with the artifact: the packaged manifest is the source manifest.
    assert.ok(entries.get("plugins/parle-codex-plugin/.mcp.json").content.equals(readFileSync(resolve(root, ".mcp.json"))));
    for (const relative of ["dist/parle-mcp.js", ".codex-plugin/plugin.json", "hooks/hooks.json", "skills/parle/SKILL.md"]) {
      assert.ok(entries.get(`plugins/parle-codex-plugin/${relative}`).content.equals(readFileSync(resolve(root, relative))), relative);
    }
    // The manifest and helpers ride outside the installable subtree, byte-equal to source.
    for (const relative of ["dogfood/rollout.mjs", "dogfood/scenarios.json", "dogfood/scenarios.schema.json"]) {
      assert.ok(entries.get(relative).content.equals(readFileSync(resolve(root, relative))), relative);
    }

    const marketplace = JSON.parse(entries.get(".agents/plugins/marketplace.json").content.toString("utf8"));
    const source = JSON.parse(readFileSync(resolve(repo, ".agents/plugins/marketplace.json"), "utf8"));
    assert.equal(marketplace.name, "parlehq");
    assert.deepEqual(marketplace.interface, source.interface);
    assert.deepEqual(marketplace.plugins, [{
      ...source.plugins.find((plugin) => plugin.name === "parle-codex-plugin"),
      source: { source: "local", path: "./plugins/parle-codex-plugin" },
    }]);
  } finally {
    rmSync(outA, { recursive: true, force: true });
    rmSync(outB, { recursive: true, force: true });
  }
});
