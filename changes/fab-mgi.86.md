- The type checks gate on Effect's diagnostics: every package's typecheck script, `pnpm check:own` and the
  check after every write run `effect-tsgo tsc` instead of `tsgo`, and `tsconfig.base.json` no longer
  ignores the Effect Language Service's errors and warnings in its exit code (its suggestions stay in
  editors). The errors and warnings it reported are fixed: a missing `return yield*` in the desktop's
  connection relay and the engine's Pi agent, untyped `catch` results in the engine's file opening and
  work-graph rows, and chained `Effect.provide`, schema object literals and global `Error`s in tests.
