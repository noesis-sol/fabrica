import { Schema } from 'effect'

import { SshPrompt } from '@fabrica/client'

// What ssh asks as the app connects, and the user's answers (spec §9.1).

/** How the user answers what ssh asked: yes, no (a cancel, a dismissal), or the secret typed. */
export const SshReply = Schema.Literals(['Accepted', 'Declined', 'Entered'])
export type SshReply = typeof SshReply.Type

export const messages = {
  /** ssh asked something, numbered `id`, as the app connects (§9.1). */
  AskedSsh: { id: Schema.Int, prompt: SshPrompt },
  /** ssh went on, or ended, without the answer to prompt `id`. */
  WithdrewSsh: { id: Schema.Int },
  /** The secret typed for the prompt shown. */
  ChangedSshSecret: { secret: Schema.Redacted(Schema.String) },
  /** The user answered prompt `id`. */
  RepliedToSsh: { id: Schema.Int, reply: SshReply },
  CompletedAnswerSsh: {},
}
