import { Effect, Option, Queue, Stream } from 'effect'

// The engine ports main hands the page (spec §8.2): one at each load, and a new one each time the
// connection process is started again, the old one dead with it. The newest is held: each acquire of
// the connection takes it, waiting for the first, and a port that comes after one was taken replaces
// it, so the connection is acquired again over the new port.

/** The engine ports, as the connection takes them. */
export interface EnginePorts<Port> {
  /** The newest port, once the first has come. */
  readonly take: Effect.Effect<Port>
  /** Once for each port that comes after the connection took one, and at once for one come already. */
  readonly replaced: Stream.Stream<void>
}

/** The ports `subscribe` calls its listener with, held from now on. */
export const holdEnginePorts = <Port>(
  subscribe: (listener: (port: Port) => void) => void,
): EnginePorts<Port> => {
  // The newest port with its count among those received, and the count of the one last taken.
  let newest: Option.Option<{ readonly port: Port; readonly count: number }> =
    Option.none()
  let taken = 0
  const takers = new Set<(port: Port) => void>()
  const watchers = new Set<() => void>()

  const isReplaced = (): boolean =>
    taken > 0 && Option.exists(newest, held => held.count > taken)

  subscribe(port => {
    const count = Option.match(newest, {
      onNone: () => 1,
      onSome: held => held.count + 1,
    })
    newest = Option.some({ port, count })
    if (takers.size > 0) {
      taken = count
      for (const give of takers) {
        give(port)
      }
      takers.clear()
    } else if (isReplaced()) {
      for (const watch of watchers) {
        watch()
      }
    }
  })

  return {
    take: Effect.callback<Port>(resume => {
      const give = (port: Port) => resume(Effect.succeed(port))
      Option.match(newest, {
        onNone: () => takers.add(give),
        onSome: held => {
          taken = held.count
          give(held.port)
        },
      })
      return Effect.sync(() => takers.delete(give))
    }),
    replaced: Stream.callback<void>(queue =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const watch = () => Queue.offerUnsafe(queue, undefined)
          watchers.add(watch)
          if (isReplaced()) {
            watch()
          }
          return watch
        }),
        watch => Effect.sync(() => watchers.delete(watch)),
      ),
    ),
  }
}
