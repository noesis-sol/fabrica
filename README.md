# Fabrica

Fabrica works through a backlog of tickets with several coding agents side by side, each in its own git
worktree, and merges each finished ticket, checked, into the branch the run started on. It is a port of
[orchestra](https://github.com/noesis-sol/orchestra) to a desktop app with a headless engine: the engine runs
on your machine or on a server and keeps runs going with no client attached, and the Electron app and the
`fabrica` command line attach to it. Workers are [Pi](https://github.com/earendil-works/pi) agents, so any
model Pi reaches will do. The spec is [`docs/spec/fabrica-spec.md`](docs/spec/fabrica-spec.md).

## Installing the engine

```sh
curl -fsSL https://github.com/noesis-sol/fabrica/releases/latest/download/install.sh | sh
```

The install script checks the host (macOS 13.5 or later; on Linux glibc 2.28 or later and `libatomic.so.1`; the
CPU), verifies the release's signed checksums, unpacks the engine into `~/.local/share/fabrica/engine/<version>/`
and links `~/.local/bin/fabrica` to it, saying how to put that folder on the PATH. `FABRICA_VERSION` names
another release, and `FABRICA_INSTALL_DIR` another folder for the link. How a release is made is in
`.github/workflows/release.yml`.

<!-- tutti:requires -->
<!-- Generated from "requires" in .tutti/settings.json: change the list, then run tutti requires --readme. -->
## What to install

What this project needs of the machine, from `"requires"` in `.tutti/settings.json`. `tutti requires` checks each one and installs what it can.

- **mise-macos** (only on macOS)
  - check: `command -v mise >/dev/null`
  - install: `HOMEBREW_NO_AUTO_UPDATE=1 brew install mise`
- **mise-linux** (only on Linux)
  - check: `command -v mise >/dev/null`
  - install: `curl -fsSL https://mise.run | sh`
- **node**
  - check: `[ "$(MISE_EXEC_AUTO_INSTALL=0 mise exec node@26.13.0 -- node -e 'require("node:sqlite"); process.stdout.write(process.version)' 2>/dev/null)" = v26.13.0 ]`
  - install: `mise install node@26.13.0`
- **pnpm**
  - check: `[ "$(MISE_EXEC_AUTO_INSTALL=0 mise exec pnpm@12.16.1 -- pnpm --version 2>/dev/null)" = 12.16.1 ]`
  - install: `mise install pnpm@12.16.1`
- **electron**
  - check: `MISE_EXEC_AUTO_INSTALL=0 mise exec -- pnpm --filter @fabrica/ui exec node -e "const fs = require('node:fs'); const path = require('node:path'); const dir = path.dirname(require.resolve('electron/package.json')); const file = path.join(dir, 'path.txt'); process.exit(fs.existsSync(file) && fs.existsSync(path.join(dir, 'dist', fs.readFileSync(file, 'utf8'))) ? 0 : 1)" >/dev/null 2>&1`
  - install: `mise exec -- pnpm --filter @fabrica/ui exec node -e "require('electron')"`
- **xvfb-linux** (only on Linux)
  - check: `[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || command -v xvfb-run >/dev/null`
  - by hand: Install Xvfb (Ubuntu: sudo apt-get install xvfb): on a machine without a display, scripts/check-fast.sh runs its suites under xvfb-run for the UI look test's Electron window.
- **git-macos** (only on macOS)
  - check: `git --version | awk '{ split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && v[2] >= 38)) }'`
  - install: `HOMEBREW_NO_AUTO_UPDATE=1 brew install git`
- **git-linux** (only on Linux)
  - check: `git --version | awk '{ split($3, v, "."); exit !(v[1] > 2 || (v[1] == 2 && v[2] >= 38)) }'`
  - by hand: Install git 2.38 or later (Ubuntu 22.04's git 2.34 is too old: use the git-core PPA, ppa:git-core/ppa).
- **actionlint**
  - check: `[ "$(MISE_EXEC_AUTO_INSTALL=0 mise exec aqua:rhysd/actionlint@1.7.12 -- actionlint --version 2>/dev/null | head -n 1)" = 1.7.12 ]`
  - install: `mise install aqua:rhysd/actionlint@1.7.12`
- **shellcheck**
  - check: `MISE_EXEC_AUTO_INSTALL=0 mise exec aqua:koalaman/shellcheck@0.11.0 -- shellcheck --version 2>/dev/null | grep -qx 'version: 0.11.0'`
  - install: `mise install aqua:koalaman/shellcheck@0.11.0`
<!-- /tutti:requires -->

## Commands

With git 2.38 or later and [mise](https://mise.jdx.dev) installed (the list above):

```bash
mise install                    # Node 26.13.0 and pnpm 12.16.1, as mise.toml pins them
pnpm install --frozen-lockfile  # dependencies, exactly as pnpm-lock.yaml has them
scripts/check-fast.sh           # type check (tsgo), lint (oxlint), format check (oxfmt), unit tests (Vitest)
scripts/check-full.sh           # the fast check, then every package's build, the app's included
pnpm test                       # the unit tests alone
pnpm build                      # every package's build
pnpm --filter @fabrica/desktop dev  # the app, in development
mise exec aqua:rhysd/actionlint@1.7.12 aqua:koalaman/shellcheck@0.11.0 -- actionlint  # the CI workflows
```

CI (`.github/workflows/ci.yml`) runs the full check on every engine target, and the fast check on 2 cores.

`CLAUDE.md` (and `AGENTS.md`, its copy for other agents) has the rest: one package's tests, the layout, and
the project's code rules.

## Licence

MIT: see [LICENSE](LICENSE).
