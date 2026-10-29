- Checks after every agent write (spec §23): `scripts/check-write.ts` runs the type check of the written file's
  package (each tsconfig its typecheck script names) and oxlint on the file, side by side, and hands their
  problems in that file back to the agent: a Claude Code `PostToolUse` hook in `.claude/settings.json` after
  Write, Edit and MultiEdit, and a `tool_result` handler in the development-only Pi package
  `scripts/pi-checks`, which `.pi/settings.json` loads.
