- Every Vitest project's tests run at the 15 s time limit spec §24 gives a loaded machine, set once in
  the test kit (`packages/testkit/src/limits.ts`) and spread into each project's config: a project's
  config file inherits nothing of the root config's, so they had run at Vitest's own 5 s.
