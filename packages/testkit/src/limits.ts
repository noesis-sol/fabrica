// A test's default time limit (spec §24, H55): one that allows for a loaded machine, where Vitest's own
// (5 s) timed out a test that passed on its rerun in 2.2 s (fab-mgi.93). A project's config file
// inherits nothing of the root config's, so every project's config spreads `testLimits` into its test
// options, and the limit is set here alone.
//
// This module is loaded by Vite with each project's config: it imports nothing.

/** The time limits every Vitest project's tests run with, in milliseconds. */
export const testLimits = {
  testTimeout: 15_000,
} as const
