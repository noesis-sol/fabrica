import { existsSync, writeFileSync } from 'node:fs'
import * as NodePath from 'node:path'

// Whether a fixture has run before in this test: a mark in the folder FABRICA_FIXTURE_MARKS names, which
// testkit.test.ts makes empty for each run of the rerun script.

/** True the first time it is called with `name`, false after. */
export const firstTime = (name: string): boolean => {
  const mark = NodePath.join(process.env['FABRICA_FIXTURE_MARKS'] ?? '', name)
  const first = !existsSync(mark)
  writeFileSync(mark, '')
  return first
}
