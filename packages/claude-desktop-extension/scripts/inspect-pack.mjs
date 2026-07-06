import { readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] || "out/unpacked");
const allowed = new Set([
  "manifest.json",
  "README.md",
  "server/parle-mcp.js",
]);
const forbiddenSegments = new Set([
  ".env",
  ".parle",
  ".galexc",
  ".claude",
  ".pi",
  ".agents",
  ".git",
  "node_modules",
  "coverage",
  ".pnpm-store",
]);
const forbiddenSuffixes = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

const files = walk(root).map((path) => relative(root, path).split(sep).join("/")).sort();
for (const file of files) {
  if (!allowed.has(file)) throw new Error(`Unexpected MCPB archive content: ${file}`);
  const segments = file.split("/");
  if (segments.some((segment) => forbiddenSegments.has(segment))) throw new Error(`Forbidden MCPB archive path: ${file}`);
  if (forbiddenSuffixes.some((suffix) => file.endsWith(suffix))) throw new Error(`Forbidden MCPB archive lockfile: ${file}`);
}
for (const expected of allowed) {
  if (!files.includes(expected)) throw new Error(`Missing MCPB archive content: ${expected}`);
}
const artifact = resolve(root, "server/parle-mcp.js");
if (!statSync(artifact).isFile() || statSync(artifact).size === 0) throw new Error("Bundled server artifact is missing or empty");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
