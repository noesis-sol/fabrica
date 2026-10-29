- The repository's own lints, an oxlint plugin in `scripts/lint-source.ts` that `pnpm lint` runs: raw bidi
  controls, C1 controls and line separators are refused in the source (`fabrica/no-raw-controls`), a test
  reading the process environment is refused (`fabrica/no-env-in-tests`), and so is `String.replace` or
  `replaceAll` given a replacement that isn't a literal or a function (`fabrica/no-built-replacement`).
  The settings editor's indented values and two raw U+2028 in the Pi records test are fixed by them.
