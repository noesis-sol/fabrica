import { Effect, Option, Schema } from 'effect'

// The connection process's ask for the local engine (spec §7.1): before each connection to the local
// socket it asks main, numbered, to make sure the engine answers there, which starts it where none
// does (crashed, stopped, restarted after an update) as at launch, and waits for main's answer: the
// engine answers, or why it couldn't be started, which the relay says to the page. A connection
// process asks only while it runs; main answers those it asked.

/** Main's answer: the local engine answers, or couldn't be started, in words. */
export const LocalEngineReach = Schema.TaggedUnion({
  Reached: {},
  Failed: { reason: Schema.String },
})
export type LocalEngineReach = typeof LocalEngineReach.Type

/** The connection process's request, a message without a port: make sure the local engine answers. */
export const LocalEngineRequest = Schema.TaggedStruct('LocalEngineRequest', {
  id: Schema.Int,
})
export type LocalEngineRequest = typeof LocalEngineRequest.Type

/** Main's answer to the request numbered `id`. */
export const LocalEngineAnswer = Schema.TaggedStruct('LocalEngineAnswer', {
  id: Schema.Int,
  answer: LocalEngineReach,
})
export type LocalEngineAnswer = typeof LocalEngineAnswer.Type

const encodeRequest = Schema.encodeSync(LocalEngineRequest)

/** The asks, made through `post` (main's port), and where main's answers to them come in. */
export const makeLocalEngineAsks = (post: (request: unknown) => void) => {
  let asked = 0
  const waiting = new Map<number, (answer: LocalEngineReach) => void>()

  return {
    /** Asks main to make sure the local engine answers, and waits for its answer. */
    reach: Effect.callback<LocalEngineReach>(resume => {
      asked += 1
      const id = asked
      // Waited on before it is asked, so an answer that comes at once finds it.
      waiting.set(id, answer => resume(Effect.succeed(answer)))
      post(encodeRequest(LocalEngineRequest.make({ id })))
      return Effect.sync(() => {
        waiting.delete(id)
      })
    }),
    /** Hands an ask still waited on its answer; one answered or given up already is dropped. */
    answered: ({ id, answer }: LocalEngineAnswer): void => {
      Option.map(Option.fromUndefinedOr(waiting.get(id)), give => {
        waiting.delete(id)
        give(answer)
      })
    },
  }
}
