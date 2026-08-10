import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(join(tmpdir(), "parle-command-code-mod-"));
const output = join(temporary, "parle.ts");
try {
  const result = spawnSync("pnpm", ["exec", "esbuild", "src/index.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Command Code mod rebuild failed");
  if (!readFileSync(output).equals(readFileSync(resolve(import.meta.dirname, "../mods/parle.ts")))) {
    throw new Error("Command Code mod artifact is stale. Rebuild @parlehq/command-code-adapter.");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
