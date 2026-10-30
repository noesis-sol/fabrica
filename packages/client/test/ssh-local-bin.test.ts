import { Effect, Option } from 'effect'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, layer } from '@effect/vitest'
import {
  Toolbox,
  layerToolbox,
  runCommandExit,
  shStub,
  tempFolder,
} from '@fabrica/testkit'

import { SshDestination } from '../src'
import { SshPrompting, sshArguments, sshEnded } from '../src/node'

// The command ssh runs on the host (fab-mgi.72): `fabrica bridge`, or the engine's link
// `~/.local/bin/fabrica` where the host's PATH lacks it, as the bare PATH of a non-interactive ssh command
// often does. A stub ssh joins its remote words with spaces, as OpenSSH does, and hands them to the login
// shell `STUB_SHELL` names with `-c`, over a PATH holding only the shells; a stub `fabrica` says which one
// ran and with what.

const toolbox = layerToolbox({
  tools: ['sh', 'bash'],
  stubs: {
    ssh: shStub(
      [
        'while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done',
        'shift 2',
        'exec "$STUB_SHELL" -c "$*"',
      ].join('\n'),
    ),
  },
})

const destination = SshDestination.make('u@server-1')

/** A stub `fabrica` at `path`, printing the path it ran as and its arguments. */
const writeFabrica = (path: string) =>
  Effect.promise(async () => {
    await mkdir(NodePath.dirname(path), { recursive: true })
    await writeFile(path, shStub('echo "$0 $*"'))
    await chmod(path, 0o755)
  })

/** A host whose home folder and PATH folder are new; ssh's run over it, with `shell` as its login shell. */
const setUp = Effect.gen(function* () {
  const tools = yield* Toolbox
  const home = yield* tempFolder('ssh-home')
  const onPath = yield* tempFolder('ssh-path')
  const linked = NodePath.join(home, '.local', 'bin', 'fabrica')
  const found = NodePath.join(onPath, 'fabrica')
  const ssh = (shell: string, path: string) =>
    runCommandExit({
      command: 'ssh',
      args: sshArguments({
        destination,
        env: {},
        prompting: SshPrompting.None(),
      }),
      cwd: home,
      env: tools.env({ HOME: home, PATH: path, STUB_SHELL: shell }),
    })
  return {
    bare: (shell: string) => ssh(shell, tools.bin),
    withFabrica: (shell: string) =>
      ssh(shell, `${onPath}${NodePath.delimiter}${tools.bin}`),
    linked,
    found,
    link: writeFabrica(linked),
    install: writeFabrica(found),
  }
})

const shells = ['sh', 'bash'] as const

describe("ssh's command on the host", () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    for (const shell of shells) {
      it.effect(
        `runs ~/.local/bin/fabrica over a PATH without fabrica, in ${shell}`,
        () =>
          Effect.gen(function* () {
            const host = yield* setUp
            yield* host.link
            const ran = yield* host.bare(shell)
            expect(ran).toEqual({
              code: 0,
              stdout: `${host.linked} bridge\n`,
              stderr: '',
            })
          }).pipe(Effect.scoped),
      )

      it.effect(`runs the fabrica on the PATH first, in ${shell}`, () =>
        Effect.gen(function* () {
          const host = yield* setUp
          yield* host.link
          yield* host.install
          const ran = yield* host.withFabrica(shell)
          expect(ran.stdout).toBe(`${host.found} bridge\n`)
        }).pipe(Effect.scoped),
      )

      it.effect(
        `says the bridge is missing where neither is, in ${shell}`,
        () =>
          Effect.gen(function* () {
            const host = yield* setUp
            const ran = yield* host.bare(shell)
            expect(ran.code).toBe(127)
            expect(
              Option.map(
                sshEnded({ code: ran.code, signal: null, stderr: ran.stderr }),
                failure => failure._tag,
              ),
            ).toEqual(Option.some('BridgeMissing'))
          }).pipe(Effect.scoped),
      )
    }
  })
})
