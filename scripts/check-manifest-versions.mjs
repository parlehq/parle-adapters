import { readFile } from 'node:fs/promises';

const checks = [
  {
    manifestPath: 'packages/claude-plugin/.claude-plugin/plugin.json',
    packagePath: 'packages/claude-plugin/package.json',
  },
  {
    manifestPath: 'packages/claude-desktop-extension/manifest.json',
    packagePath: 'packages/claude-desktop-extension/package.json',
  },
];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

let failed = false;

for (const check of checks) {
  const [manifest, packageJson] = await Promise.all([
    readJson(check.manifestPath),
    readJson(check.packagePath),
  ]);

  if (manifest.version !== packageJson.version) {
    failed = true;
    console.error(
      `${check.manifestPath} version ${manifest.version} does not match ${check.packagePath} version ${packageJson.version}`,
    );
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('Manifest versions match package versions.');
}
