import { Effect, Option } from 'effect'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

// Finding a command (spec §24, tutti-xj3t): the one rule for which file a command name runs. It is
// looked up on the PATH the command will run with, from its own environment, never on the PATH the
// engine started with.

const executableFile = (file: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      const info = await stat(file)
      if (!info.isFile()) return false
      await access(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  })

/**
 * The file `command` runs: a name holding a `/` is that file, against `cwd`; any other name is the
 * first executable regular file of that name in `path`'s folders, in order. Relative and empty
 * entries of `path` are skipped, so a worktree's own files never shadow a tool.
 */
export const findOnPath = Effect.fn('ProcessPath.find')(function* ({
  command,
  path,
  cwd,
}: {
  readonly command: string
  readonly path: string
  readonly cwd: string
}) {
  if (command.includes('/')) {
    const file = resolve(cwd, command)
    return (yield* executableFile(file))
      ? Option.some(file)
      : Option.none<string>()
  }
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder)) continue
    const file = join(folder, command)
    if (yield* executableFile(file)) return Option.some(file)
  }
  return Option.none<string>()
})
