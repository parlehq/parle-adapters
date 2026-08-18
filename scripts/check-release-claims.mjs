import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] || "HEAD";
const packages = [
  {
    name: "Pi extension",
    changelog: "packages/pi-extension/CHANGELOG.md",
    artifact: "packages/pi-extension/dist/index.js",
    normalize: (text) => text.replace(/PI_EXTENSION_VERSION = "[^"]+"/g, 'PI_EXTENSION_VERSION = "<version>"'),
  },
  {
    name: "Command Code",
    changelog: "packages/command-code/CHANGELOG.md",
    artifact: "packages/command-code/mods/parle.ts",
    normalize: (text) => text.replace(/ADAPTER_VERSION = "[^"]+"/g, 'ADAPTER_VERSION = "<version>"'),
  },
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function addedClaims(changelog) {
  return git(["diff", "--unified=0", "--no-ext-diff", base, "--", changelog])
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.startsWith("-"));
}

function claimsRuntimeChange(line) {
  return !/\b(?:no [^.]*runtime behavior changed|runtime behavior is unchanged)\b/i.test(line);
}

const failures = [];
for (const pkg of packages) {
  const claims = addedClaims(pkg.changelog);
  if (claims.length === 0) continue;

  const positiveClaims = claims.filter(claimsRuntimeChange);
  if (positiveClaims.length === 0) continue;
  // This is a floor, not semantic proof: reviewers still verify that prose
  // describes the behavior-bearing bytes that changed.
  const before = pkg.normalize(git(["show", `${base}:${pkg.artifact}`]));
  const after = pkg.normalize(readFileSync(resolve(root, pkg.artifact), "utf8"));
  if (before === after) {
    failures.push(`${pkg.name} claims runtime behavior changed, but ${pkg.artifact} changed only by version or not at all: ${positiveClaims.join(" | ")}`);
  }
}

if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(`Native adapter release claims match carried artifact changes since ${base}.`);
