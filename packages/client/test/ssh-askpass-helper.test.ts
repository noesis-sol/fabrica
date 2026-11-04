import { Effect, Option, Redacted } from 'effect'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { AskpassHelper, SshDestination } from '../src'
import { SshPrompting, askpassAddress, sshFailed, sshSocket } from '../src/node'

// The relay with a helper program of the caller's (spec §9.1, fab-mgi.96): ssh runs that program itself, none
// written beside it, and the relay's protocol reaches it at the address in `FABRICA_ASKPASS`. Windows' own
// program and named pipe are run on Windows CI (apps/desktop/test/windows-askpass.test.ts); here the program
// is a script speaking the same protocol over this platform's socket.

/** A stub ssh: OpenSSH 9.6 to `-V`; else keeps its relay's variables and what the helper printed, and refuses. */
const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'if [ "$1" = "-V" ]; then echo "OpenSSH_9.6p1, OpenSSL 3.0.13" >&2; exit 0; fi',
        'printf "%s" "$SSH_ASKPASS" > "$STUB_DIR/askpass"',
        'printf "%s" "$FABRICA_ASKPASS" > "$STUB_DIR/address"',
        `answer=$("$SSH_ASKPASS" "Enter passphrase for key 'id': ")`,
        'printf "%s" "$answer" > "$STUB_DIR/answer"',
        'echo "Permission denied (publickey)." >&2',
        'exit 255',
      ].join('\n'),
    ),
  },
})

/** A program speaking the relay's protocol, as the Windows app's does. */
const programScript = `const net = process.getBuiltinModule('node:net')
const socket = net.connect(process.env.FABRICA_ASKPASS)
let reply = ''
socket.on('connect', () =>
  socket.write(JSON.stringify({ prompt: process.argv[2], hint: process.env.SSH_ASKPASS_PROMPT ?? '' }) + '\\n'),
)
socket.on('data', chunk => (reply += chunk))
socket.on('end', () => process.stdout.write(JSON.parse(reply).text + '\\n'))
`

describe('a relay with a helper program', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect('has ssh run that program, and answers it', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const dir = yield* tempFolder('ask')
        const script = NodePath.join(dir, 'program.mjs')
        const program = NodePath.join(dir, 'program')
        yield* Effect.promise(async () => {
          await writeFile(script, programScript)
          await writeFile(
            program,
            `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
          )
          await chmod(program, 0o700)
        })
        const asked: Array<string> = []
        const socket = yield* sshSocket({
          destination: SshDestination.make('u@server-1'),
          env: tools.env({ STUB_DIR: dir }),
          prompting: SshPrompting.Relay({
            helper: AskpassHelper.Executable({ path: program }),
            folder: dir,
            prompts: {
              hostKey: () => Effect.succeed(false),
              secret: ({ text }) =>
                Effect.sync(() => {
                  asked.push(text)
                  return Option.some(Redacted.make('open sesame'))
                }),
              confirm: () => Effect.succeed(false),
              notice: () => Effect.void,
            },
          }),
        })
        const failed = yield* Effect.flip(Effect.scoped(socket.reader))
        const kept = (name: string) =>
          Effect.promise(() => readFile(NodePath.join(dir, name), 'utf8'))
        expect(Option.isSome(sshFailed(failed))).toBe(true)
        expect(asked).toEqual(["Enter passphrase for key 'id': "])
        expect(yield* kept('answer')).toBe('open sesame')
        expect(yield* kept('askpass')).toBe(program)
        const address = yield* kept('address')
        expect(NodePath.basename(address)).toBe('ask.sock')
        expect(NodePath.dirname(NodePath.dirname(address))).toBe(dir)
      }),
    )
  })
})

describe("the relay's address", () => {
  it('is a socket in the private folder on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        askpassAddress({ platform, folder: '/tmp/ssh-1', nonce: 'abc' }),
      ).toBe(NodePath.join('/tmp/ssh-1', 'ask.sock'))
    }
  })

  it('is a named pipe of its own on Windows', () => {
    expect(
      askpassAddress({ platform: 'win32', folder: 'C:\\tmp', nonce: 'abc' }),
    ).toBe('\\\\.\\pipe\\fabrica-askpass-abc')
  })
})
