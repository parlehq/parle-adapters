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
  {
    manifestPath: 'packages/codex-plugin/.codex-plugin/plugin.json',
    packagePath: 'packages/codex-plugin/package.json',
  },
];

const runtimeChecks = [
  {
    sourcePath: 'packages/command-code/src/index.ts',
    packagePath: 'packages/command-code/package.json',
    patterns: [/const ADAPTER_VERSION = "([^"]+)";/],
  },
  {
    sourcePath: 'packages/pi-extension/src/index.ts',
    packagePath: 'packages/pi-extension/package.json',
    patterns: [/const PI_EXTENSION_VERSION = "([^"]+)";/],
  },
  {
    sourcePath: 'packages/mcp-server/src/index.ts',
    packagePath: 'packages/mcp-server/package.json',
    patterns: [/const MCP_CLIENT_VERSION = "([^"]+)";/],
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

for (const plugin of ['claude-plugin', 'codex-plugin', 'claude-desktop-extension']) {
  const path = `packages/${plugin}`;
  const manifestPath = `${path}/${plugin === 'claude-desktop-extension' ? 'manifest.json' : '.mcp.json'}`;
  const [manifest, packageJson] = await Promise.all([
    readJson(manifestPath),
    readJson(`${path}/package.json`),
  ]);
  const env = plugin === 'claude-desktop-extension' ? manifest.server?.mcp_config?.env : manifest.mcpServers?.parle?.env;
  const version = env?.PARLE_INTEGRATION_VERSION;
  if (version !== packageJson.version) {
    failed = true;
    console.error(`${manifestPath} integration version ${version || '<missing>'} does not match package version ${packageJson.version}`);
  }
}

for (const check of runtimeChecks) {
  const [source, packageJson] = await Promise.all([
    readFile(check.sourcePath, 'utf8'),
    readJson(check.packagePath),
  ]);
  for (const pattern of check.patterns) {
    const match = source.match(pattern);
    if (!match || match[1] !== packageJson.version) {
      failed = true;
      console.error(
        `${check.sourcePath} runtime version ${match?.[1] || '<missing>'} does not match ${check.packagePath} version ${packageJson.version}`,
      );
    }
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('Manifest versions match package versions.');
}
