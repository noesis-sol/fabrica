import { Effect, Option, Result, Schema } from 'effect'
import { readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { bridgeRemote, sshFailed } from '@fabrica/client/node'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { LocalEngineReach } from '../src/connection/local-engine'
import { ConnectionTarget } from '../src/connection/target'
import { engineSocket } from '../src/connection/transports'

/** The local engine answers: main's answer to every ask. */
const engineAnswers = Effect.succeed(LocalEngineReach.cases.Reached.make({}))

// The connection process's SSH target (spec §8.2, §9.1): a page's connection to an engine an SSH
// destination names runs ssh, through a stub that records its arguments and answers as OpenSSH does for
// a host `known_hosts` doesn't know. Where main names no Node for the askpass helper, ssh asks nothing.

const toolbox = layerToolbox({
  stubs: {
    ssh: shStub(
      [
        'printf "%s\\n" "$@" > "$STUB_DIR/args"',
        'echo "Host key verification failed." >&2',
        'exit 255',
      ].join('\n'),
    ),
  },
})

describe('the SSH target', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect('runs ssh in batch mode, and fails the connection with why', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const dir = yield* tempFolder('connection-ssh')
        const target = ConnectionTarget.cases.Ssh.make({
          destination: 'u@server-1',
        })
        const socket = yield* engineSocket(target, {
          env: { ...tools.env({ STUB_DIR: dir }), UNSET: undefined },
          localEngine: engineAnswers,
          askpass: Option.none(),
        })
        const failed = yield* Effect.flip(
          Effect.flatMap(socket.reader, reader => reader.pull),
        )
        expect(
          Option.map(sshFailed(failed), ({ failure }) => failure._tag),
        ).toEqual(Option.some('HostKeyUnknown'))
        const args = yield* Effect.promise(() =>
          readFile(NodePath.join(dir, 'args'), 'utf8'),
        )
        expect(args.split('\n').slice(-7)).toEqual([
          'BatchMode=yes',
          '--',
          'u@server-1',
          ...bridgeRemote,
          '',
        ])
      }).pipe(Effect.scoped),
    )
  })

  it('takes no destination that ssh would read as an option', () => {
    const decode = Schema.decodeUnknownResult(ConnectionTarget)
    expect(
      Result.isSuccess(decode({ _tag: 'Ssh', destination: 'u@server-1' })),
    ).toBe(true)
    expect(
      Result.isSuccess(
        decode({ _tag: 'Ssh', destination: '-oProxyCommand=sh' }),
      ),
    ).toBe(false)
  })
})
