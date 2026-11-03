import { Console, Effect, Exit, Layer, Option, Redacted } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it } from '@effect/vitest'
import { Secrets } from '@fabrica/engine'
import { layerHost } from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { passphraseSource } from '../src/passphrase'

// `fabrica serve`'s passphrase for the secret store (spec §20.3): read from `--passphrase-file`, its path
// absolute, or else typed at the terminal's prompt, or else none; and the flag in `serve`'s and
// `service install`'s help.

const ask: Secrets.PassphraseAsk = () =>
  Effect.succeed(Option.some(Redacted.make('typed')))

describe('the passphrase source', () => {
  it('is the file given, its path absolute, over the prompt', () => {
    expect(
      passphraseSource({
        file: Option.some('secrets/passphrase'),
        prompt: Option.some(ask),
      }),
    ).toStrictEqual(
      Option.some(
        Secrets.PassphraseSource.File({
          path: NodePath.resolve('secrets/passphrase'),
        }),
      ),
    )
  })

  it('is the prompt where no file is given and the engine runs on a terminal', () => {
    const source = passphraseSource({
      file: Option.none(),
      prompt: Option.some(ask),
    })
    expect(
      Option.map(source, Secrets.PassphraseSource.$is('Prompted')),
    ).toStrictEqual(Option.some(true))
  })

  it('is none with neither', () => {
    expect(
      passphraseSource({ file: Option.none(), prompt: Option.none() }),
    ).toStrictEqual(Option.none())
  })
})

describe('--passphrase-file', () => {
  const help = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const out: Array<string> = []
      const console: Console.Console = Object.assign(
        Object.create(globalThis.console),
        { log: (...line: ReadonlyArray<unknown>) => out.push(line.join(' ')) },
      )
      const exit = yield* runCli(args).pipe(
        Effect.provideService(Console.Console, console),
        Effect.provide([
          NodeServices.layer,
          Layer.succeed(LocalEngine)({ socket: Effect.succeed('/nowhere') }),
          layerHost(),
        ]),
        Effect.exit,
      )
      expect(exit).toStrictEqual(Exit.void)
      return out.join('\n')
    })

  it.effect('is in serve’s help and service install’s', () =>
    Effect.gen(function* () {
      expect(yield* help(['serve', '--help'])).toContain('--passphrase-file')
      expect(yield* help(['service', 'install', '--help'])).toContain(
        '--passphrase-file',
      )
    }),
  )
})
