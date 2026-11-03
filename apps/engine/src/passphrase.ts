import { Effect, Option } from 'effect'
import { Prompt } from 'effect/cli'
import * as NodePath from 'node:path'

import { Secrets } from '@fabrica/engine'

// The secret store's passphrase for `fabrica serve` (spec §20.3): where no keyring answers, the engine
// keeps its credentials in an encrypted file, whose passphrase is read from the file `--passphrase-file`
// names (the login service's way, run with no terminal), or else typed at a prompt where the engine
// runs on a terminal, asked only once the engine finds no keyring. With neither, the engine has none,
// and refuses its runs, saying it needs one.

/** Where the engine's passphrase comes from: the file given, else the terminal's prompt, else nowhere. */
export const passphraseSource = ({
  file,
  prompt,
}: {
  /** `--passphrase-file`, its path taken from where the engine starts. */
  readonly file: Option.Option<string>
  /** The terminal's prompt, where the engine runs on one. */
  readonly prompt: Option.Option<Secrets.PassphraseAsk>
}): Option.Option<Secrets.PassphraseSource> =>
  Option.match(file, {
    onSome: path =>
      Option.some(
        Secrets.PassphraseSource.File({ path: NodePath.resolve(path) }),
      ),
    onNone: () =>
      Option.map(prompt, ask => Secrets.PassphraseSource.Prompted({ ask })),
  })

/** Asks at the terminal, its typing not shown; none where its input ends (Ctrl-C, Ctrl-D). */
export const terminalAsk = Effect.gen(function* () {
  const services = yield* Effect.context<Prompt.Environment>()
  const ask: Secrets.PassphraseAsk = message =>
    Prompt.Hidden({ message }).pipe(
      Effect.map(Option.some),
      Effect.catchTag('QuitError', () => Effect.succeedNone),
      Effect.provideContext(services),
    )
  return ask
})
