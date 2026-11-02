import { Effect, Option } from 'effect'
import { readFile } from 'node:fs/promises'

// A fixture process a test starts detached, which notes its PID in a file for the test to stop it by
// (the desktop app's fixture engine). The one rule for both ends: the fixture writes the file whole,
// renamed into place, so it is never read half-written; and the test signals only a PID it read, a
// whole number above 1. A file read empty gave `Number('')`, 0, which `process.kill` takes for the
// caller's own process group: the test runner's, and with it every suite of the check it ran in.

/**
 * The fixture's source that notes its PID at the path in the variable `file`: written beside it,
 * then renamed over it. It needs `fs`, `node:fs`, in scope.
 */
export const notePid = (file: string): string =>
  `fs.writeFileSync(${file} + '.tmp', String(process.pid)); fs.renameSync(${file} + '.tmp', ${file})`

/** The PID noted in `text`, where it is one: a whole number above 1. */
export const notedPid = (text: string): Option.Option<number> => {
  const noted = text.trim()
  return /^\d+$/.test(noted) && Number(noted) > 1
    ? Option.some(Number(noted))
    : Option.none()
}

/**
 * Terminates the process whose PID a fixture noted at `path`; nothing where it noted none, or the
 * process is gone.
 */
export const stopNotedProcess = (path: string): Effect.Effect<void> =>
  Effect.promise(() => readFile(path, 'utf8').catch(() => '')).pipe(
    Effect.map(notedPid),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: pid =>
          Effect.sync(() => {
            try {
              process.kill(pid, 'SIGTERM')
            } catch {
              // The process has gone already.
            }
          }),
      }),
    ),
  )
