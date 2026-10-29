import { Effect, Exit, Layer, Option } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, layer } from '@effect/vitest'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { CheckAnswer, SshDestination } from '../src'
import {
  DistributionSource,
  HostShell,
  ShellInput,
  answerCheck,
  checkHost,
  sshShell,
} from '../src/install'

// The ssh the app runs, checked at Add engine (fab-mgi.13): OpenSSH 8.4 or later, since the app relays
// ssh's prompts through `SSH_ASKPASS`. An older one is refused at the host's first command, saying how
// to get a newer, and nothing runs on the host; a recent one runs the host's commands, checked once.
// Against a stub ssh that says the version in `STUB_VERSION` and logs every run.

const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'echo "$*" >> "$STUB_DIR/runs"',
        'if [ "$1" = "-V" ]; then echo "$STUB_VERSION" >&2; exit 0; fi',
        'echo ran',
      ].join('\n'),
    ),
  },
})

const destination = SshDestination.make('u@server-1')

/** A shell over the stub ssh saying `version`, and its runs so far. */
const setUp = (version: string) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const dir = yield* tempFolder('ssh-version')
    return {
      shell: sshShell({
        destination,
        env: tools.env({ STUB_DIR: dir, STUB_VERSION: version }),
      }),
      runs: Effect.promise(() =>
        readFile(NodePath.join(dir, 'runs'), 'utf8').then(text =>
          text.split('\n').filter(line => line !== ''),
        ),
      ),
    }
  })

const echo = {
  argv: ['echo', 'hi'],
  input: ShellInput.Text({ text: '' }),
  timeLimit: '10 seconds',
} as const

describe("the app's ssh", () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      "refuses Windows 10's 8.1 at the host's first command, saying how to get a newer",
      () =>
        Effect.gen(function* () {
          const { shell, runs } = yield* setUp(
            'OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2',
          )
          const exit = yield* Effect.exit(shell.exec(echo))
          const said = Exit.match(exit, {
            onSuccess: () => '',
            onFailure: cause => String(cause),
          })
          expect(said).toContain('OpenSSH_for_Windows_8.1p1')
          expect(said).toContain('OpenSSH 8.4 or later')
          expect(said).toContain('winget install Microsoft.OpenSSH.Preview')
          expect(yield* runs).toEqual(['-V'])
        }).pipe(Effect.scoped),
    )

    it.effect('refuses at the check of Add engine, in its words', () =>
      Effect.gen(function* () {
        const { shell, runs } = yield* setUp(
          'OpenSSH_8.2p1 Ubuntu-4ubuntu0.13, OpenSSL 1.1.1f',
        )
        const answer = yield* answerCheck(
          checkHost(
            DistributionSource.Folder({ folder: '/nowhere', keys: [] }),
          ),
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostShell, shell),
              FetchHttpClient.layer,
            ),
          ),
        )
        expect(
          Option.map(
            Option.liftPredicate(answer, CheckAnswer.guards.Failed),
            ({ reason }) => reason,
          ),
        ).toEqual(
          Option.some(
            "couldn't run the install's commands on u@server-1: this ssh is OpenSSH_8.2p1 Ubuntu-4ubuntu0.13: the app relays ssh's prompts, which takes OpenSSH 8.4 or later; install a newer OpenSSH, and put it first on the PATH",
          ),
        )
        expect(yield* runs).toEqual(['-V'])
      }).pipe(Effect.scoped),
    )

    it.effect(
      "runs the host's commands through 8.4 or later, checked once",
      () =>
        Effect.gen(function* () {
          const { shell, runs } = yield* setUp(
            'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13',
          )
          const first = yield* shell.exec(echo)
          yield* shell.exec(echo)
          expect(first.stdout).toBe('ran\n')
          const ran = yield* runs
          expect(ran.filter(line => line === '-V')).toEqual(['-V'])
          expect(ran).toHaveLength(3)
        }).pipe(Effect.scoped),
    )
  })
})
