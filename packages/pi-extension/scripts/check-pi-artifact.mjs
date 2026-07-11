// The Pi harness loads the COMMITTED dist/index.js bundle (see package.json
// "pi".extensions); deployed checkouts never run installs or builds. This gate
// fails the suite whenever the committed bundle drifts from a fresh build of
// src, so source edits cannot ship without their bundle.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const built = buildSync({
  // Pin the working directory: esbuild writes cwd-relative path comments
  // into the bundle, so without this the gate result depends on where the
  // script is invoked from (package dir vs repo root).
  absWorkingDir: root,
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["typebox"],
  write: false,
});
const fresh = Buffer.from(built.outputFiles[0].contents);
const committed = readFileSync(resolve(root, "dist/index.js"));
if (!fresh.equals(committed)) {
  throw new Error("Pi extension bundle is stale. Run pnpm -F @parlehq/pi-extension build and commit dist/index.js.");
}
