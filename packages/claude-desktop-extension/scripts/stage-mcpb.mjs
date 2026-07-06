import { copyFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const staging = resolve(root, "out/staging");

rmSync(staging, { recursive: true, force: true });
mkdirSync(resolve(staging, "server"), { recursive: true });

const files = [
  ["manifest.json", "manifest.json"],
  ["README.md", "README.md"],
  ["server/parle-mcp.js", "server/parle-mcp.js"],
];

for (const [sourceRel, targetRel] of files) {
  const source = resolve(root, sourceRel);
  const target = resolve(staging, targetRel);
  const sourceStat = statSync(source);
  if (!sourceStat.isFile() || sourceStat.size === 0) throw new Error(`Missing staged input ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
