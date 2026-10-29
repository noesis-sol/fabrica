# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

The toolchain is pinned: Node 26.13.0 and pnpm 12.16.1 in `mise.toml` (and `packageManager`/`engines` in
`package.json`), git 2.38 or later. The requires list in `.tutti/settings.json` checks and installs them.

```bash
mise install                    # Node and pnpm, as mise.toml pins them
pnpm install --frozen-lockfile  # dependencies, exactly as pnpm-lock.yaml has them
scripts/check-fast.sh           # type check (tsgo), lint (oxlint), format check (oxfmt), unit tests (Vitest)
scripts/check-full.sh           # the fast check, then every package's build, electron-vite's included
pnpm check:own                  # your change's check: its packages' type checks, lint and format on the
                                # changed files, the tests its import graph reaches; a pass kept by tree
```

Both check scripts run under mise's toolchain when mise is installed, run every suite, and fail when any
suite fails. One step at a time, from the root:

```bash
pnpm typecheck        # tsgo --noEmit in every package (pnpm typecheck:tsc runs tsc instead)
pnpm lint             # oxlint, with @foldkit/oxlint-plugin
pnpm format           # oxfmt, writing; pnpm format:check only checks
pnpm test             # every package's tests (Vitest projects), failed ones rerun (scripts/test-rerun.ts)
pnpm build            # every package's build
```

One package:

```bash
pnpm vitest run --project contracts                # its tests: contracts, engine, pi-extension, client, ui, engine-app
pnpm vitest run packages/contracts/src/ids.test.ts # one test file
pnpm --filter @fabrica/contracts typecheck         # its type check (or build)
pnpm --filter @fabrica/desktop dev                 # the app, with the renderer's dev server
pnpm --filter @fabrica/ui dev                      # the renderer alone, in a browser
```

Test files run side by side in `FABRICA_CORES` workers (the check scripts set it from `TUTTI_CORES`), every
core on CI, or half the machine's cores elsewhere. `pnpm test` reruns each file's failed tests together in one
process and prints `FLAKY: <file> > <test>` for a test that passes on its rerun. Shared test helpers live in
`@fabrica/testkit`.

Dependencies are pinned to exact versions (`saveExact` in `pnpm-workspace.yaml`): add one with
`pnpm add --filter <package> <name>@<version>`. `effect` and every `@effect/*` package stay on one version,
the Effect peer Foldkit pins (4.0.0 at Foldkit 0.169.0), held by `overrides` in `pnpm-workspace.yaml`; they
are upgraded with Foldkit, never alone.

## Architecture Overview

One TypeScript monorepo, pnpm workspaces (spec §6):

- `apps/desktop`: the Electron app (main, preload, renderer), built by electron-vite.
- `apps/engine`: the engine's entry points, the daemon and the CLI, bundled by Vite into one Node file.
- `packages/contracts`: Effect Schema contracts every package imports; it imports nothing but `effect`.
- `packages/engine`: the engine's Effect services.
- `packages/pi-extension`: the first-party Pi package loaded into every agent.
- `packages/client`: the RPC client and connection management, shared by the app and the CLI.
- `packages/ui`: the renderer, a Foldkit program.
- `packages/testkit`: the shared test kit (temp git repositories, an airtight PATH and environment, injected
  host facts) and the test runner's worker count and reruns.

The spec is `docs/spec/fabrica-spec.md`; the console's design handoff is under `design/console/`.

## Conventions & Patterns

Code rules (spec §6):

- **One rule, one module.** How a git status is read, whether a process is alive, finding a command on the
  PATH it will run with, a command's environment, the keys a screen binds: each lives in one module, and
  everything else calls it. Never restate a rule.
- **Each value read once** per decision and passed on; independent reads run side by side.
- **Tagged unions for outcomes**, made by their constructors (`Data.TaggedEnum`, `Schema.TaggedUnion`) and
  matched exhaustively (`Match.exhaustive`, `$match`): never object literals told apart by their fields, never
  sentinel values (`""` for a commit git couldn't give, `-1` for a count it couldn't make).
- **Branded IDs** (`packages/contracts/src/ids.ts`: `TicketId`, `CommitHash`, `SessionId`, `MessageId`,
  `ProjectId`, `RunId`, `EngineId`) are made only through their constructors (`TicketId.make`, `.makeOption`,
  `.makeEffect`, or decoding with the schema), where they are read or drawn; never by a type assertion (lint
  refuses `as`). A function taking several of them takes them by name, in one object.
- **Named spans**: services at process and I/O boundaries are `Effect.fn("Service.method")`.
- `packages/contracts` imports nothing but `effect`. TypeScript is strict, ESM, with extensionless relative
  imports; oxfmt sets the style.
- **Order of work**: in the engine, Schema contracts in `contracts` first, then the service interface, then
  tests against in-memory layers, then the implementation. In the UI, the Model and Messages, then story
  tests, then `update`, then `view`.
- **Tests**: Vitest with `@effect/vitest` (`it.effect` for effects), next to the module as
  `<module>.test.ts`. No test reads facts about its host (cores, clock, home folder, PATH, environment): they
  are injected. No real sleeps: wait on events or `TestClock`.

Working beside other agents (spec §23, from building tutti):

- **New tests go in a new test file named after the feature**, not at the end of an existing one.
- **Changelog entries are one file per ticket**, `changes/<ticket>.md`; never edit another ticket's.
- A ticket's text names a file only where the ticket will change it, since footprints read every path a
  ticket names; a description opens with the detail, not a restatement of its title.
- An agent's write tools turn `\u` escapes of printable controls into the raw characters: write such escapes
  with a script.
