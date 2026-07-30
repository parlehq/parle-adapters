import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..");
const repoRoot = resolve(extensionRoot, "../..");

function readPackage(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("Pi remains an optional host peer for git and package installs", () => {
  const manifests = [
    readPackage(resolve(repoRoot, "package.json")),
    readPackage(resolve(extensionRoot, "package.json")),
  ];

  for (const manifest of manifests) {
    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.80.4");
    assert.equal(manifest.peerDependenciesMeta["@earendil-works/pi-coding-agent"].optional, true);
    assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
    assert.equal(manifest.devDependencies?.["@earendil-works/pi-coding-agent"], undefined);
  }
});
