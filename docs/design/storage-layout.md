# Adapter storage layout

Status: accepted

## Context

Parle adapters need one predictable location for room-bound credentials and the human-session state used by typed account operations. The location must be easy to inspect, relocate, secure, and remove without making credential discovery depend on several independently configured roots.

The XDG Base Directory Specification is a reasonable default for new general-purpose command-line tools, but an XDG split is a poor fit for the current adapter state. The profile catalog carries live credentials, while user configuration directories are commonly synchronized through dotfile tooling. Splitting related state across config, state, and cache roots would also make credential auditing and relocation harder.

This decision covers the home-directory layout. Credential-free per-process runtime snapshots remain a separate host rendezvous question under issue #34.

## Decision

Store adapter configuration and account state under one `~/.parle` directory.

The current layout is:

- profile catalog: `~/.parle/profiles`, defined by `PROFILE_CATALOG_PATH` in `packages/client/src/profiles.ts`
- human session record: `dirname(catalogPath)/session`, resolved in `packages/client/src/account.ts`
- invitation handoffs: `dirname(catalogPath)/invites/`, resolved in `packages/client/src/account.ts`
- account-hardening ceremony state: beside the resolved catalog through the same account state directory
- operator-tagged peer routes: `dirname(catalogPath)/peers`

`PARLE_PROFILES_PATH` selects a replacement catalog file. It does not layer another catalog over the default. Relative overrides resolve against the adapter working directory. Because account state follows `dirname(catalogPath)`, one override relocates the credential-bearing adapter state together.

The default safety posture is 0700 directories, 0600 credential files, bounded reads, and atomic temporary-file replacement. Symlink handling and ownership checks remain implementation details that must fail closed. Issue #37 owns the pending decision about refusing loose catalog permissions and remediating git exposure. Its outcome should update the consequences here without changing the one-root decision.

Per-process runtime snapshots currently live at `<cwd>/.parle/runtime/<pid>.json`. They are display-safe, expiring rendezvous files rather than credential state. Issue #34 owns whether they remain workspace-local or move to a user-scoped runtime root.

## Alternatives considered

### XDG-native split

An XDG layout would place configuration, durable state, and cache data under separate standard roots. This aligns with many modern command-line tools and avoids adding another home-directory dotfolder.

It is not selected because the current configuration is primarily credential-bearing, configuration roots are often synchronized, and multiple winning roots make credential discovery and auditing less obvious. The XDG specification also does not define a credential store.

### Single dot directory

A single `~/.parle` directory matches the operational shape of current AI harness tools such as Claude Code and Codex. One root is easy to find, protect, back up, relocate, and delete. One override also avoids ambiguous precedence between credential locations.

The cost is deliberate nonconformance with XDG expectations. Requests to support XDG locations should point to this decision rather than treating the current path as accidental.

### Hybrid migration ladder

A future migration could choose exactly one location using a precedence ladder: explicit override, existing new location, existing legacy location, then creation at the preferred location. It must probe for the catalog file rather than only a directory and must never merge credentials from multiple roots.

This is a migration strategy, not the current layout. It becomes relevant only if a reconsideration trigger is met.

## Consequences

Positive consequences:

- credential-bearing state has one auditable root
- `PARLE_PROFILES_PATH` relocates the catalog and account state together
- adapters share deterministic path and precedence behavior
- removal and backup are straightforward

Negative consequences:

- the project will continue to receive reasonable XDG requests
- tools that synchronize all home-directory dotfolders must exclude or protect `~/.parle`
- host-managed credential stores can create a bounded second location, as with Claude Desktop sensitive MCPB configuration

Claude Desktop is an explicit host-managed exception. Its injected room token may live in the operating-system credential store, and the host process environment remains the authority for that Desktop process. The shared Desktop bundle also exposes explicitly confirmed account tools. A deliberate `parle_login` can persist a human-session record and room-bound profile under the resolved `~/.parle` root for later CLI or coding-harness use, but those files do not replace the injected Desktop token or rebind the live Desktop process. Desktop therefore has two explicit credential custody locations only when the user invokes a persistence-capable account tool: host-managed sensitive configuration and the single adapter account-state root.

## Reconsideration triggers

Reopen this decision when any of the following becomes true:

- Parle ships a broader end-user CLI where XDG expectations materially change the tradeoff
- credentials leave the profile catalog or become disposable enough that synchronized config roots are no longer a central concern
- a harness or operating-system requirement forces another layout
- supporting a new deployment environment requires multiple storage roots and a safe single-winner migration can be demonstrated

## References

- XDG Base Directory Specification: https://specifications.freedesktop.org/basedir/latest/
- Issue #34: runtime snapshot location
- Issue #37: catalog permission and git-exposure posture
- Issue #38: Claude Desktop host-managed credential lifecycle
