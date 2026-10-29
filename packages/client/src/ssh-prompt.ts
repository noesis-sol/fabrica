import { Schema } from 'effect'

// What ssh asks while it connects, relayed through `SSH_ASKPASS` to the user in the app (spec §9.1),
// and their answers: the connection process asks them of main, main of the page, and the answers come
// back the same way. Each crosses a process boundary and is decoded there, so this module has no Node in
// it; `transports/ssh.ts` asks them of `SshPrompts`.

/** One thing ssh asks or says, about the connection to `destination`. */
export const SshPrompt = Schema.TaggedUnion({
  /** An unknown host's key, to accept (ssh adds it to `known_hosts`) or refuse. */
  HostKey: {
    destination: Schema.String,
    /** The host as ssh names it, its address included. */
    host: Schema.String,
    /** The key's fingerprint, `SHA256:…`, where ssh gave it. */
    fingerprint: Schema.OptionFromNullOr(Schema.String),
    text: Schema.String,
  },
  /** A key's passphrase, a password or a keyboard-interactive answer. */
  Secret: { destination: Schema.String, text: Schema.String },
  /** A yes or no, as ssh-agent's confirmation of a key's use asks. */
  Confirm: { destination: Schema.String, text: Schema.String },
  /** Something to show while ssh waits, such as a security key's touch: it waits for no answer. */
  Notice: { destination: Schema.String, text: Schema.String },
})
export type SshPrompt = typeof SshPrompt.Type

/** The user's answer to a prompt: yes, no (a secret's cancel, a notice's dismissal), or a secret. */
export const SshAnswer = Schema.TaggedUnion({
  Accepted: {},
  Declined: {},
  Entered: { secret: Schema.String },
})
export type SshAnswer = typeof SshAnswer.Type

/** The prompt numbered `id`, asked or withdrawn (ssh went on, or ended, without its answer). */
export const SshPromptEvent = Schema.TaggedUnion({
  Asked: { id: Schema.Int, prompt: SshPrompt },
  Withdrawn: { id: Schema.Int },
})
export type SshPromptEvent = typeof SshPromptEvent.Type

/** The answer to the prompt numbered `id`. */
export const SshPromptAnswer = Schema.Struct({
  id: Schema.Int,
  answer: SshAnswer,
})
export type SshPromptAnswer = typeof SshPromptAnswer.Type
