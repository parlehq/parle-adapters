// Build the immutable Codex dogfood artifact: a self-contained local
// marketplace tree, gzipped tar, with a sha256 sidecar and build metadata.
//
// Determinism contract: the same tree at the same commit produces a
// byte-identical tarball on macOS and Linux. Entries are sorted, mtimes are the
// commit time, uid/gid are 0, modes are normalized (0644 files, 0755 dirs and
// executables), and the gzip container is written by hand so its header carries
// no timestamp, name, or platform OS byte. The tar writer is a minimal ustar
// implementation so no external tar flags (which differ between bsdtar and GNU
// tar) or extra dependencies are involved.
//
// The canonical artifact identity is the uncompressed tar stream, recorded as
// `tarSha256` in the metadata: it depends only on the tree and the commit. The
// .tar.gz bytes (`sha256`, the sidecar) additionally depend on Node's bundled
// zlib deflate output; mise pins the Node major, but the exact zlib patch may
// vary between Node releases, so provenance comparisons across machines use
// tarSha256 and consumers verify the downloaded .tar.gz against its sidecar.
//
// Usage: node scripts/build-artifact.mjs [--out <dir>] [--allow-dirty]
// Exit 2 when the worktree is dirty and --allow-dirty was not passed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const marketplaceSource = resolve(repoRoot, ".agents/plugins/marketplace.json");
const pluginName = "parle-codex-plugin";
const pluginPrefix = `plugins/${pluginName}`;
// Exactly what `codex plugin add` needs: the manifest plus the skills,
// mcpServers, and hooks paths it declares, the bundled server, and the package
// documents. Nothing from test/, scripts/, node_modules/, or out/.
const pluginFiles = [".codex-plugin/plugin.json", ".mcp.json", "README.md", "CHANGELOG.md", "package.json", "dist/parle-mcp.js"];
const pluginDirectories = ["hooks", "skills"];
// Shipped beside the installable subtree so parle's driver reads the scenario
// manifest and rollout helpers from the same immutable artifact it installs.
const dogfoodFiles = ["dogfood/rollout.mjs", "dogfood/scenarios.json", "dogfood/scenarios.schema.json"];

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const options = { out: resolve(packageRoot, "out"), allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--out") options.out = resolve(argv[++index] || "");
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function walk(directory, prefix, into) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relative = posix.join(prefix, entry.name);
    if (entry.isDirectory()) walk(join(directory, entry.name), relative, into);
    else if (entry.isFile()) into.push(relative);
  }
}

function collectPluginFiles() {
  const files = [...pluginFiles];
  for (const directory of pluginDirectories) walk(resolve(packageRoot, directory), directory, files);
  return files.sort();
}

function marketplaceDocument() {
  const source = JSON.parse(readFileSync(marketplaceSource, "utf8"));
  const plugin = source.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) throw new Error(`${marketplaceSource} does not list ${pluginName}`);
  return `${JSON.stringify({
    ...source,
    plugins: [{ ...plugin, source: { source: "local", path: `./${pluginPrefix}` } }],
  }, null, 2)}\n`;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(name, { mode, size, mtime, type }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar entry name too long for a plain ustar header: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(size, 12), 124, 12, "ascii");
  header.write(octal(mtime, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "utf8");
  header.write("root", 297, 32, "utf8");
  header.write(octal(0, 8), 329, 8, "ascii");
  header.write(octal(0, 8), 337, 8, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function writeTar(entries, mtime) {
  const blocks = [];
  for (const entry of entries) {
    if (entry.type === "5") {
      blocks.push(tarHeader(`${entry.name}/`, { mode: 0o755, size: 0, mtime, type: "5" }));
      continue;
    }
    blocks.push(tarHeader(entry.name, { mode: entry.mode, size: entry.content.length, mtime, type: "0" }));
    blocks.push(entry.content);
    const remainder = entry.content.length % 512;
    if (remainder) blocks.push(Buffer.alloc(512 - remainder));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// gzip container with MTIME=0, no FNAME, XFL=0, OS=255 (unknown): the same
// bytes regardless of platform, equivalent to `gzip -n`.
function gzipDeterministic(payload) {
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(payload) >>> 0, 0);
  trailer.writeUInt32LE(payload.length >>> 0, 4);
  return Buffer.concat([header, deflateRawSync(payload, { level: 9 }), trailer]);
}

function directoriesFor(paths) {
  const directories = new Set();
  for (const path of paths) {
    let parent = posix.dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = posix.dirname(parent);
    }
  }
  return [...directories];
}

export function buildArtifact(options) {
  const version = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;
  const gitSha = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]) !== "";
  if (dirty && !options.allowDirty) {
    const error = new Error("Worktree is dirty; commit the changes or pass --allow-dirty (the metadata will record gitDirty: true).");
    error.exitCode = 2;
    throw error;
  }
  const commitTime = Number(git(["log", "-1", "--format=%ct"]));

  const files = new Map();
  files.set(".agents/plugins/marketplace.json", { content: Buffer.from(marketplaceDocument()), mode: 0o644 });
  for (const relative of collectPluginFiles()) {
    const source = resolve(packageRoot, relative);
    const mode = statSync(source).mode & 0o111 ? 0o755 : 0o644;
    files.set(`${pluginPrefix}/${relative}`, { content: readFileSync(source), mode });
  }
  for (const relative of dogfoodFiles) files.set(relative, { content: readFileSync(resolve(packageRoot, relative)), mode: 0o644 });
  const names = [...files.keys()].sort();
  const entries = [
    ...directoriesFor(names).map((name) => ({ name, type: "5" })),
    ...names.map((name) => ({ name, type: "0", ...files.get(name) })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const tar = writeTar(entries, commitTime);
  const tarSha256 = createHash("sha256").update(tar).digest("hex");
  const tarball = gzipDeterministic(tar);
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const baseName = `${pluginName}-${version}-${gitSha.slice(0, 12)}.tar.gz`;
  mkdirSync(options.out, { recursive: true });
  const tarballPath = join(options.out, baseName);
  writeFileSync(tarballPath, tarball);
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${baseName}\n`);
  const metadata = {
    name: pluginName,
    version,
    gitSha,
    gitDirty: dirty,
    builtFromCommitTime: new Date(commitTime * 1000).toISOString(),
    sha256,
    tarSha256,
    files: names,
  };
  writeFileSync(`${tarballPath}.metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
  return { tarballPath, metadata };
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const { tarballPath, metadata } = buildArtifact(parseArgs(process.argv.slice(2)));
    console.log(`${tarballPath}\n${metadata.sha256}  ${posix.basename(tarballPath)}${metadata.gitDirty ? "\n(worktree dirty: gitDirty=true)" : ""}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(error?.exitCode || 1);
  }
}
