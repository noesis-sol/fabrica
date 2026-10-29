import { Duration, Effect, Option, Ref } from 'effect'
import { getPriority, setPriority } from 'node:os'

// A command's CPU priority (spec §7.3, H73): the one rule for the nice value a worker's command runs
// at. It is set as the command starts, never raising a priority the engine itself runs lower than,
// read back at once and again 100 ms later, and set again where something raised it back, which the
// log says once: on GitHub's macOS runners a lowered process was back at nice -10 within 100 ms.

/** Reading and setting a process's nice value; a process that has gone can't be read or set. */
export interface PriorityControl {
  readonly get: (pid: number) => Effect.Effect<Option.Option<number>>
  readonly set: (pid: number, nice: number) => Effect.Effect<boolean>
}

/** The host's own nice values, through `getpriority` and `setpriority`. */
export const hostPriority: PriorityControl = {
  get: pid =>
    Effect.sync(() => {
      try {
        return Option.some(getPriority(pid))
      } catch {
        return Option.none()
      }
    }),
  set: (pid, nice) =>
    Effect.sync(() => {
      try {
        setPriority(pid, nice)
        return true
      } catch {
        return false
      }
    }),
}

/** How long after the start a command's priority is read again. */
const RECHECK = Duration.millis(100)

/**
 * The nice value a command is set to: `nice` where it is lower in priority than the engine's own
 * (`engine`, read once where the engine starts), or none, leaving the command the engine's.
 */
export const effectiveNice = ({
  nice,
  engine,
}: {
  readonly nice: Option.Option<number>
  readonly engine: number
}): Option.Option<number> => Option.filter(nice, value => value > engine)

/**
 * Sets the process `pid` to `nice`, reads it back at once and again 100 ms later (in a fiber of the
 * caller's scope), and sets it again wherever it reads higher in priority; `warned` says whether the
 * log has said so yet.
 */
export const applyNice = Effect.fn('ProcessPriority.apply')(function* ({
  control,
  pid,
  nice,
  warned,
}: {
  readonly control: PriorityControl
  readonly pid: number
  readonly nice: number
  readonly warned: Ref.Ref<boolean>
}) {
  const holdAt = Effect.fnUntraced(function* (when: string) {
    const read = yield* control.get(pid)
    if (Option.isNone(read) || read.value >= nice) return
    yield* control.set(pid, nice)
    if (!(yield* Ref.getAndSet(warned, true))) {
      yield* Effect.logWarning(
        `PRIORITY: process ${pid} read nice ${read.value} ${when}, set again to ${nice}; later raises are set again unsaid`,
      )
    }
  })
  yield* control.set(pid, nice)
  yield* holdAt('as it was set')
  yield* Effect.forkScoped(
    Effect.andThen(Effect.sleep(RECHECK), holdAt('100 ms after it was set')),
  )
})
