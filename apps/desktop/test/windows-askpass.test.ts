import { Effect, Option, Redacted } from 'effect'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { inject } from 'vitest'

import { describe, expect, it } from '@effect/vitest'
import { AskpassHelper, SshDestination } from '@fabrica/client'
import {
  SshPrompting,
  type SshPrompts,
  sshFailed,
  sshSocket,
} from '@fabrica/client/node'
import { tempFolder } from '@fabrica/testkit'

import { windowsAskpass } from '../src/main/windows-askpass'

// The Windows app's `SSH_ASKPASS` helper (spec §9.1, build/askpass.c), as the installer put it, against a
// stub ssh, on Windows CI (.github/workflows/app.yml). It is run by vitest.windows-askpass.config.ts, never
// by the unit suite.
//
// The stub stands in for ssh: OpenSSH 9.6 to `-V`, else it runs `SSH_ASKPASS` as ssh does, its prompt the one
// argument and its hint in `SSH_ASKPASS_PROMPT`, then reports what the helper did and refuses the sign-in.
// Its stdin is a file: whatever the helper read of it would be gone from under the stub, which reads it
// after, so what is left says the helper never touched its stdin, without a race on a pipe. It writes
// stderr with writeSync: a pipe's stream writes are asynchronous on Windows, and process.exit would lose them.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The installed app's resources folder. */
    askpassResources: string
    /** The stub ssh, built from test/stub-ssh.c. */
    askpassStubSsh: string
    /** The host's variables a Windows process can't start without. */
    askpassHost: Record<string, string>
  }
}

const helper = windowsAskpass(inject('askpassResources'))
const host = inject('askpassHost')
const stubSsh = inject('askpassStubSsh')

const stubScript = `import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs'
import * as NodePath from 'node:path'
if (process.argv[2] === '-V') {
  writeSync(2, 'OpenSSH_9.6p1, OpenSSL 3.0.13\\n')
  process.exit(0)
}
const dir = process.env.STUB_DIR
const stdinFile = NodePath.join(dir, 'stdin')
const stdin = openSync(stdinFile, 'r')
const env = { ...process.env, SSH_ASKPASS_PROMPT: process.env.STUB_HINT }
const finish = result => {
  const left = Buffer.alloc(64)
  const read = readSync(stdin, left, 0, left.length, null)
  writeFileSync(
    NodePath.join(dir, 'asked.json'),
    JSON.stringify({ ...result, left: left.subarray(0, read).toString('utf8') }),
  )
  writeSync(2, 'Permission denied (publickey).\\n')
  process.exit(255)
}
if (process.env.STUB_HINT === 'none') {
  const notice = spawn(process.env.SSH_ASKPASS, [process.env.STUB_PROMPT], {
    env,
    stdio: [stdin, 'ignore', 'inherit'],
  })
  notice.once('exit', () => finish({ status: null, stdout: '' }))
  const told = NodePath.join(dir, 'told')
  const wait = setInterval(() => {
    if (existsSync(told)) {
      clearInterval(wait)
      notice.kill()
    }
  }, 20)
} else {
  const asked = spawnSync(process.env.SSH_ASKPASS, [process.env.STUB_PROMPT], {
    env,
    encoding: 'utf8',
    stdio: [stdin, 'pipe', 'inherit'],
  })
  finish({ status: asked.status, stdout: asked.stdout })
}
`

const stdinHeld = "the bridge's line\n"

interface Asked {
  readonly status: number | null
  readonly stdout: string
  readonly left: string
}

/** Nothing else is expected to be asked: a call fails the test. */
const unexpected = (what: string) => Effect.die(new Error(`${what} was asked`))

const prompts = (overrides: Partial<SshPrompts>): SshPrompts => ({
  hostKey: () => unexpected('a host key'),
  secret: () => unexpected('a secret'),
  confirm: () => unexpected('a confirmation'),
  notice: () => unexpected('a notice'),
  ...overrides,
})

/** One connection the stub refuses after asking `prompt`: what the helper did, and why ssh ended. */
const askedOf = ({
  prompt,
  hint = '',
  answers,
}: {
  readonly prompt: string
  readonly hint?: string
  readonly answers: (dir: string) => SshPrompts
}) =>
  Effect.gen(function* () {
    const dir = yield* tempFolder('ask')
    const script = NodePath.join(dir, 'stub.mjs')
    yield* Effect.promise(async () => {
      await writeFile(script, stubScript)
      await writeFile(NodePath.join(dir, 'stdin'), stdinHeld)
    })
    const socket = yield* sshSocket({
      destination: SshDestination.make('u@server-1'),
      ssh: stubSsh,
      env: {
        ...host,
        STUB_NODE: process.execPath,
        STUB_SCRIPT: script,
        STUB_DIR: dir,
        STUB_PROMPT: prompt,
        STUB_HINT: hint,
      },
      prompting: SshPrompting.Relay({
        helper: AskpassHelper.Executable({ path: helper }),
        folder: dir,
        prompts: answers(dir),
      }),
    })
    const failed = yield* Effect.flip(Effect.scoped(socket.reader))
    const asked: Asked = yield* Effect.promise(() =>
      readFile(NodePath.join(dir, 'asked.json'), 'utf8').then(JSON.parse),
    )
    return {
      asked,
      failure: Option.map(sshFailed(failed), ({ failure }) => failure._tag),
    }
  })

const passphrasePrompt =
  "Enter passphrase for key 'C:\\Users\\Zoë Ω\\.ssh\\id_ed25519': "

const hostKeyPrompt = [
  "The authenticity of host 'server-1 (192.0.2.7)' can't be established.",
  'ED25519 key fingerprint is SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU.',
  'This key is not known by any other names.',
  'Are you sure you want to continue connecting (yes/no/[fingerprint])? ',
].join('\n')

describe('the Windows askpass helper', () => {
  it.live('prints the answer, whatever it holds, and leaves stdin alone', () =>
    Effect.gen(function* () {
      const answer = 'pä"ss\\wörd 🔑\ttab'
      const texts: Array<string> = []
      const { asked, failure } = yield* askedOf({
        prompt: passphrasePrompt,
        answers: () =>
          prompts({
            secret: ({ text }) =>
              Effect.sync(() => {
                texts.push(text)
                return Option.some(Redacted.make(answer))
              }),
          }),
      })
      expect(texts).toEqual([passphrasePrompt])
      expect(asked).toEqual({
        status: 0,
        stdout: `${answer}\n`,
        left: stdinHeld,
      })
      expect(failure).toEqual(Option.some('AuthenticationFailed'))
    }),
  )

  it.live('prints nothing and exits 1 for a cancel', () =>
    Effect.gen(function* () {
      const { asked } = yield* askedOf({
        prompt: passphrasePrompt,
        answers: () => prompts({ secret: () => Effect.succeed(Option.none()) }),
      })
      expect(asked).toEqual({ status: 1, stdout: '', left: stdinHeld })
    }),
  )

  it.live.each([
    { accepted: true, printed: 'yes\n' },
    { accepted: false, printed: 'no\n' },
  ])(
    "sends an unknown host's whole question, and prints $printed",
    ({ accepted, printed }) =>
      Effect.gen(function* () {
        const hosts: Array<string> = []
        const texts: Array<string> = []
        const { asked } = yield* askedOf({
          prompt: hostKeyPrompt,
          answers: () =>
            prompts({
              hostKey: ({ host: named, text }) =>
                Effect.sync(() => {
                  hosts.push(named)
                  texts.push(text)
                  return accepted
                }),
            }),
        })
        expect(hosts).toEqual(['server-1 (192.0.2.7)'])
        expect(texts).toEqual([hostKeyPrompt])
        expect(asked).toEqual({ status: 0, stdout: printed, left: stdinHeld })
      }),
  )

  it.live('sends the hint of a confirmation', () =>
    Effect.gen(function* () {
      const { asked } = yield* askedOf({
        prompt: 'Allow use of key id_ed25519?',
        hint: 'confirm',
        answers: () => prompts({ confirm: () => Effect.succeed(true) }),
      })
      expect(asked).toEqual({ status: 0, stdout: 'yes\n', left: stdinHeld })
    }),
  )

  it.live('waits on a notice until ssh stops it', () =>
    Effect.gen(function* () {
      const texts: Array<string> = []
      const { asked } = yield* askedOf({
        prompt: 'Confirm user presence for key ED25519-SK',
        hint: 'none',
        answers: dir =>
          prompts({
            notice: ({ text }) =>
              Effect.promise(async () => {
                texts.push(text)
                await writeFile(NodePath.join(dir, 'told'), '')
              }),
          }),
      })
      expect(texts).toEqual(['Confirm user presence for key ED25519-SK'])
      expect(asked.left).toBe(stdinHeld)
    }),
  )

  it.live('exits 1 with nothing printed where nothing listens', () =>
    Effect.gen(function* () {
      const dir = yield* tempFolder('ask')
      const ran = spawnSync(helper, ['a prompt'], {
        env: { ...host, FABRICA_ASKPASS: NodePath.join(dir, 'nothing') },
        encoding: 'utf8',
      })
      expect(ran.status).toBe(1)
      expect(ran.stdout).toBe('')
    }),
  )
})
