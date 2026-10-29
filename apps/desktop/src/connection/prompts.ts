import { Effect, Option, Redacted, Schema } from 'effect'

import {
  SshAnswer,
  SshPrompt,
  type SshPromptAnswer,
  SshPromptEvent,
} from '@fabrica/client'
import type { SshPrompts } from '@fabrica/client/node'

// The connection process's end of ssh's prompts (spec §9.1): what ssh asks through `SSH_ASKPASS` as it
// connects is asked of main, which asks the page, each prompt numbered and waited on until its answer
// comes back, or withdrawn (to main, and so to the page) where ssh goes on or ends without it. A notice
// waits for nothing: it is told, and the page dismisses it.

const encodeEvent = Schema.encodeSync(SshPromptEvent)

/** Whether an answer says yes. */
const isYes = SshAnswer.match({
  Accepted: () => true,
  Declined: () => false,
  Entered: () => false,
})

/** The secret an answer entered: none for a cancel. */
const secretOf = SshAnswer.match({
  Accepted: () => Option.none<Redacted.Redacted<string>>(),
  Declined: () => Option.none<Redacted.Redacted<string>>(),
  Entered: ({ secret }) => Option.some(Redacted.make(secret)),
})

/** The prompts, asked through `post` (main's port), and where main's answers to them come in. */
export const makeAskedPrompts = (post: (event: unknown) => void) => {
  let asked = 0
  const waiting = new Map<number, (answer: SshAnswer) => void>()

  const tell = (id: number, prompt: SshPrompt): void =>
    post(encodeEvent(SshPromptEvent.cases.Asked.make({ id, prompt })))

  const ask = (prompt: SshPrompt): Effect.Effect<SshAnswer> =>
    Effect.callback<SshAnswer>(resume => {
      asked += 1
      const id = asked
      // Waited on before it is told, so an answer that comes at once finds it.
      waiting.set(id, answer => resume(Effect.succeed(answer)))
      tell(id, prompt)
      return Effect.sync(() => {
        if (waiting.delete(id)) {
          post(encodeEvent(SshPromptEvent.cases.Withdrawn.make({ id })))
        }
      })
    })

  const prompts: SshPrompts = {
    hostKey: ({ destination, host, fingerprint, text }) =>
      Effect.map(
        ask(
          SshPrompt.cases.HostKey.make({
            destination,
            host,
            fingerprint,
            text,
          }),
        ),
        isYes,
      ),
    secret: ({ destination, text }) =>
      Effect.map(
        ask(SshPrompt.cases.Secret.make({ destination, text })),
        secretOf,
      ),
    confirm: ({ destination, text }) =>
      Effect.map(
        ask(SshPrompt.cases.Confirm.make({ destination, text })),
        isYes,
      ),
    notice: ({ destination, text }) =>
      Effect.sync(() => {
        asked += 1
        tell(asked, SshPrompt.cases.Notice.make({ destination, text }))
      }),
  }

  return {
    prompts,
    /** Hands a prompt still waited on its answer; one answered or withdrawn already is dropped. */
    answered: ({ id, answer }: SshPromptAnswer): void => {
      const give = waiting.get(id)
      if (give !== undefined) {
        waiting.delete(id)
        give(answer)
      }
    },
  }
}
