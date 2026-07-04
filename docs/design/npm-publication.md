# Npm Publication Design

Status: design iteration for issue #1  
Issue: https://github.com/parlehq/parle-agent-adapters/issues/1  
Date: 2026-07-04

## Objective

Make the Parle adapter packages installable from npm where npm is the correct distribution channel, while keeping Claude Code plugin distribution accurate and avoiding premature publication of placeholder packages.

## Recommendation

Use a phased npm rollout:

1. Publish `@parle/pi-extension` first once its package metadata and pack output are clean.
2. Keep `@parle/agent-client` and `@parle/mcp-server` private until they contain real APIs.
3. Keep `packages/claude-plugin` as a git-installed Claude Code plugin directory, not an npm-published package.
4. Add Changesets now for versioning, changelogs, and future multi-package release automation.
5. Add a package validation workflow now, but make actual npm publishing a separate explicit release step.

This keeps the currently useful package installable without forcing empty packages into npm.

## Package publication posture

- `@parle/pi-extension`: real extracted Pi extension. Publish candidate now because it has live functionality and tests.
- `@parle/agent-client`: placeholder. Do not publish yet because a placeholder creates semver and support obligations before the API exists.
- `@parle/mcp-server`: placeholder. Do not publish yet for the same reason. Publish after the MCP tool surface exists.
- `packages/claude-plugin`: placeholder plugin directory. Do not publish to npm because Claude Code plugins are plugin directories installed through Claude plugin mechanisms, not npm packages.

## Install story after npm support

### Current install path

```bash
pi install git:github.com/parlehq/parle-agent-adapters@main
```

### Target npm install path

Once published, the preferred Pi install path should be:

```bash
pi install npm:@parle/pi-extension
```

For project-local install:

```bash
pi install -l npm:@parle/pi-extension
```

Keep the Git install path documented as a development or prerelease path.

## Required package metadata

For each npm-published package:

- `private: false` or no `private` field.
- `license: MIT`.
- `repository` with GitHub URL and package directory.
- `bugs` pointing to GitHub issues.
- `homepage` pointing to the package README or repo.
- `type: module`.
- `exports` pointing to built JS and declarations.
- `types` pointing to declaration output.
- `files` allowlist, at minimum `dist`, `README.md`, and package metadata.
- `publishConfig.access: public` for scoped public packages.
- `peerDependencies` for host-provided Pi dependencies.
- no bundled secrets, local credentials, generated caches, or workspace-only assumptions.

For `@parle/pi-extension`, the npm package must publish built JavaScript, not source TypeScript as the runtime entry. The Pi manifest should point at `dist/index.js`; `main`, `types`, and `exports` should point at built artifacts as well. Source TypeScript may be included only if useful for debugging, not as the runtime load path.

No published package may depend on an unpublished private workspace package. Before publication, inspect `dependencies`, `peerDependencies`, and the packed tarball to verify there are no `workspace:*` dependencies that resolve only inside the monorepo.

## Build and pack validation

Add scripts scoped to publish candidates, not placeholder packages:

```json
{
  "scripts": {
    "pack:check": "pnpm filter @parle/pi-extension pack dry run",
    "release:version": "changeset version",
    "release:publish": "changeset publish"
  }
}
```

When `@parle/agent-client` or `@parle/mcp-server` become real publish candidates, add them explicitly to `pack:check` rather than sweeping all workspace packages.

Add package-specific validation for publishable packages:

```bash
pnpm filter @parle/pi-extension build
pnpm filter @parle/pi-extension test
pnpm filter @parle/pi-extension pack dry run
```

The pack dry run must be reviewed before first publication. It should include only expected files. After packing, install the local tarball into a disposable Pi test project and verify Pi can load the extension and expose `parle_status`.

## Release workflow

### Phase 1: manual publication readiness

- Add Changesets config.
- Keep the root package `private: true`.
- Keep placeholder packages explicitly `private: true` and unpublishable.
- Configure Changesets so placeholder packages cannot be released accidentally.
- Add a Changeset for the first `@parle/pi-extension` release.
- Add CI validation that runs test, typecheck, build, and pack dry run.
- Publish manually from a clean maintainer workstation or a one-off GitHub Actions workflow after reviewing pack output.

### Phase 2: automated publication

After one or two successful manual releases:

- Add a GitHub Actions release workflow using Changesets Action.
- Prefer npm trusted publishing or provenance from GitHub Actions if compatible with the selected workflow.
- If a token is required, store a least-privilege `NPM_TOKEN` as a GitHub secret.
- Require npm organization access to be configured for `@parle` and require maintainer 2FA.
- Protect release workflow triggers so publishing only happens from `main` and only after a version PR is merged.

## CI design

Add `.github/workflows/ci.yml`:

- checkout
- setup Node from `.mise.toml` or explicit Node version
- enable pnpm through Corepack
- `pnpm install with frozen lockfile`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm filter @parle/pi-extension pack dry run`

Do not publish from CI in the first implementation PR unless explicitly approved.

## Security and trust guardrails

- Run `gitleaks` or equivalent before first npm publication.
- Require a clean git tree before release.
- Run frozen install, test, typecheck, build, pack dry run, secret scan, lifecycle script review, and local packed Pi install smoke test before first publish.
- Ensure package tarballs do not include `.env`, `.parle/credentials`, `.galexc`, `.claude`, `.pi/git`, `node_modules`, or `dist` from unrelated packages.
- Keep `@earendil-works/pi-coding-agent` as a peer dependency with a real compatible range rather than `*`.
- Decide `typebox` before release: make it a dependency if the published package imports it at runtime, unless Pi package loading demonstrably supplies it.
- Replace wildcard peer ranges before publication.
- Do not publish placeholder packages.
- Do not publish the Claude plugin as npm unless Claude Code plugin distribution changes or a clear npm-based installer is intentionally designed.

## Implementation sequence

1. Add Changesets dev dependency and initialize config.
2. Update root README and package README to describe current Git install and future npm install clearly.
3. Update `packages/pi-extension/package.json` metadata for npm publication.
4. Point the Pi manifest, `main`, `types`, and `exports` at built artifacts.
5. Add `files` allowlist and verify `pnpm filter @parle/pi-extension pack dry run`.
6. Resolve dependency classification and remove wildcard peer ranges.
7. Add local packed tarball Pi install smoke test.
8. Add CI validation, including pack dry run.
9. Add a first release Changeset for `@parle/pi-extension`.
10. Manually publish `@parle/pi-extension` with public access after pack, secret scans, lifecycle script review, and smoke tests pass.
11. Update README to make `pi install npm:@parle/pi-extension` primary and Git install secondary.
12. Leave `@parle/agent-client`, `@parle/mcp-server`, and `packages/claude-plugin` unpublished until real APIs exist.

## Open decisions

### Should `@parle/pi-extension` publish source TS or built JS?

Decision: publish built JS and declarations, with the Pi manifest pointing at `dist/index.js`. This makes npm install less dependent on source transpilation and TypeScript loader behavior.

Required validation: install from a local packed tarball using Pi before publishing.

### Should first release be `0.1.0` or `0.0.1`?

Recommendation: `0.1.0`. The Pi extension is already functional and public, but the package ecosystem is pre-1.0.

### Should `@parle/agent-client` be published together with `@parle/pi-extension`?

Recommendation: no. Until client extraction happens, publishing it would advertise an API that does not exist.

## Acceptance criteria for issue #1

- `@parle/pi-extension` has npm-ready metadata, README, license metadata, exports, types, and `files` allowlist.
- `@parle/pi-extension` loads built JS from `dist/index.js` in its Pi manifest.
- `@parle/agent-client` and `@parle/mcp-server` remain private or otherwise unpublishable while placeholder-only.
- No published package depends on an unpublished private `workspace:*` package.
- `packages/claude-plugin` is not documented as npm-installed.
- Changesets is configured without accidentally releasing placeholders.
- CI validates test, typecheck, build, and package dry-run.
- Release checklist includes clean tree, frozen install, secret scan, lifecycle script review, pack review, and local packed Pi install smoke test.
- First release process is documented.
- README distinguishes current Git install from npm install after publish.
- First npm publish is manual or explicitly approval-gated.

## Evidence from external research

- npm publish docs say `npm pack dry run` shows what will be included and that all files are included by default except excluded files.
- npm package.json docs describe `files` as an allowlist for package tarballs and `exports` as a modern public interface boundary.
- npm package.json docs recommend `private: true` to prevent accidental publication of packages that should not publish.
- pnpm publish docs note that the root workspace LICENSE is packed with workspace packages unless a package has its own license, and support provenance publishing from supported CI systems.
- Changesets is designed for monorepo versioning and changelogs, including dependency bumps between changed packages.
- Changesets Action supports GitHub Actions release workflows with `NPM_TOKEN`, but this should come after manual release confidence.

## Research note

Research used Tavily Search and Tavily Extract on 2026-07-04. Jina was not used because Tavily succeeded with normal quality.
