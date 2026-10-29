import { Console, Effect, Schema } from 'effect'

import { Json } from './flags'

// How a command prints its answer (spec §19): with `--json`, the answer's schema encoding as one line of
// JSON; otherwise its text. Both go through the CLI's console, which sanitises them for the terminal.

/** Prints `value`: as JSON with `--json`, else as `text` gives it. */
export const printAnswer = Effect.fn('Cli.printAnswer')(function* <
  A,
  I,
>(options: {
  readonly schema: Schema.Codec<A, I>
  readonly value: A
  readonly text: (value: A) => string
}) {
  if (yield* Json) {
    const encoded = yield* Schema.encodeEffect(options.schema)(
      options.value,
    ).pipe(Effect.orDie)
    yield* Console.log(JSON.stringify(encoded))
  } else {
    yield* Console.log(options.text(options.value))
  }
})
