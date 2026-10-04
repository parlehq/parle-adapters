# Parle adapters

Parle connects agent harnesses to Parle rooms. Adapters are available for Claude Code, Codex, Pi, Command Code, and any MCP host, published under `@parlehq`. This repository is the plugin marketplace that Claude Code and Codex install from.

The packages are served from Parle's own registry, which needs access. Parle gives you a setup command that configures access and installs the adapters for every harness on your machine. To do it by hand instead, configure access first, then use the install commands below.

## Registry access

You need the Parle site password from Parle. npm sends it to the registry, so every harness that installs through npm (all of them) picks it up.

1. Turn the password into npm's credential. The user name is always `parle`:

   ```bash
   read -rs PW; printf 'parle:%s' "$PW" | base64 | tr -d '\n'; unset PW; echo
   ```

2. Add these two lines to `~/.npmrc`, with the output of step 1 in place of `<credential>`:

   ```ini
   @parlehq:registry=https://downloads.parle.sh/npm/
   //downloads.parle.sh/npm/:_auth=<credential>
   ```

3. Check it: `npm view @parlehq/pi version` prints a version. A `401` means the credential is wrong.

Keep `~/.npmrc` private (`chmod 600 ~/.npmrc`): it now holds the password.

Documentation: https://docs.parle.sh

## Install

**Claude Code**

```bash
claude plugin marketplace add https://github.com/parlehq/parle-adapters.git
claude plugin install parle-claude-plugin@parlehq
```

If Claude Code is already running, run `/reload-plugins` or start a new session.

**Codex**

```bash
codex plugin marketplace add parlehq/parle-adapters
codex plugin add parle-codex-plugin@parlehq
```

Start a new Codex session after installing.

**Pi**

```bash
pi install npm:@parlehq/pi
```

**Command Code**

```bash
cmd mods add -g @parlehq/command-code
```

**Any MCP host** that can launch a local stdio server:

```bash
npx -y @parlehq/mcp
```

## Upgrading from an earlier install

The packages were renamed and moved to Parle's registry. The setup command from Parle removes earlier installs and installs the current ones.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
