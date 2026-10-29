- The monorepo is set up: pnpm workspaces (`apps/desktop`, `apps/engine`, `packages/contracts`,
  `packages/engine`, `packages/pi-extension`, `packages/client`, `packages/ui`), Node 26.13.0 and pnpm 12.16.1
  pinned in `mise.toml`, Effect 4.0.0 everywhere, type checks with tsgo, oxlint and oxfmt, Vitest with
  `@effect/vitest`, and `scripts/check-fast.sh` and `scripts/check-full.sh`. `packages/contracts` has the
  branded IDs.
