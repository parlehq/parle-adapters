import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "packages/client/dist/responsive-delivery.js");
const targets = [
  "packages/claude-plugin/statusline/responsive-delivery-reader.mjs",
];

for (const relative of targets) {
  const target = resolve(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
