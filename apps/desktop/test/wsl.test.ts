import { Effect, Option, Result, Schema } from 'effect'
import { readFile, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { UbuntuInstall } from '@fabrica/client'
import { bridgeScript, holdScript, wslFailed } from '@fabrica/client/node'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { ConnectionTarget } from '../src/connection/target'
import { engineSocket } from '../src/connection/transports'
import { installUbuntu, reachWslEngine } from '../src/main/wsl'

// Main's WSL2 host and the connection process's WSL2 target (spec §7.6, H31) against a stub `wsl.exe`
// that records each run's arguments: `--install -d Ubuntu` ends with its folder's `install-code`, and
// leaves Ubuntu listed where its `installs` file says so; `--list --verbose` prints the list; the
// keep-alive (the `--exec` with arguments after its script) ends at once; and the bridge finds no fabrica
// in the distribution.

const toolbox = layerToolbox({
  tools: ['sh', 'cat', 'cp'],
  stubs: {
    'wsl.exe': shStub(
      [
        'dir="$STUB_DIR"',
        `printf '%s\\n' "$*" >> "$dir/runs.log"`,
        'case "$1" in',
        '--install)',
        '  [ "$(cat "$dir/installs")" != yes ] || cp "$dir/installed" "$dir/list"',
        '  exit "$(cat "$dir/install-code")" ;;',
        '--list) cat "$dir/list"; exit 0 ;;',
        '-d) [ "$#" -le 6 ] || exit 0',
        "  echo '/bin/bash: line 1: fabrica: command not found' >&2",
        '  exit 127 ;;',
        'esac',
        'exit 2',
      ].join('\n'),
    ),
  },
})

const setUp = (options: {
  readonly installs: boolean
  readonly installCode?: number
}) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    const dir = yield* tempFolder('desktop-wsl')
    yield* Effect.promise(() =>
      Promise.all([
        writeFile(NodePath.join(dir, 'list'), ''),
        writeFile(
          NodePath.join(dir, 'installed'),
          '  NAME      STATE           VERSION\n* Ubuntu    Running         2\n',
        ),
        writeFile(
          NodePath.join(dir, 'installs'),
          options.installs ? 'yes' : 'no',
        ),
        writeFile(
          NodePath.join(dir, 'install-code'),
          String(options.installCode ?? 0),
        ),
        writeFile(NodePath.join(dir, 'runs.log'), ''),
      ]),
    )
    return {
      env: tools.env({ STUB_DIR: dir }),
      runs: Effect.map(
        Effect.promise(() => readFile(NodePath.join(dir, 'runs.log'), 'utf8')),
        text => text.split('\n').filter(line => line !== ''),
      ),
    }
  })

describe('the WSL2 host in main', () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect(
      'installs Ubuntu where there is no distribution, and finds it after',
      () =>
        Effect.gen(function* () {
          const { env, runs } = yield* setUp({ installs: true })
          expect(yield* installUbuntu({ env })).toEqual(
            UbuntuInstall.cases.Ready.make({ distro: 'Ubuntu' }),
          )
          expect(yield* runs).toEqual([
            '--install -d Ubuntu',
            '--list --verbose',
          ])
        }),
    )

    it.effect(
      'says what is left where Ubuntu is not there after the install',
      () =>
        Effect.gen(function* () {
          const unready = yield* installUbuntu({
            env: (yield* setUp({ installs: false })).env,
          })
          expect(UbuntuInstall.guards.Unfinished(unready)).toBe(true)
          const failed = yield* installUbuntu({
            env: (yield* setUp({ installs: false, installCode: 1 })).env,
          })
          expect(failed).toEqual(
            UbuntuInstall.cases.Unfinished.make({
              reason: 'wsl.exe --install -d Ubuntu ended with 1',
            }),
          )
        }),
    )

    it.effect(
      'reaches the engine in a distribution through its bridge, keeping the distribution running',
      () =>
        Effect.gen(function* () {
          const { env, runs } = yield* setUp({ installs: false })
          const { target, held } = yield* reachWslEngine({
            env,
            distro: 'Ubuntu',
          })
          expect(target).toEqual(
            ConnectionTarget.cases.Wsl.make({ distro: 'Ubuntu' }),
          )
          yield* Option.match(held, {
            onNone: () => Effect.die('the keep-alive was not started'),
            onSome: ({ ended }) => ended,
          })
          expect(yield* runs).toEqual([
            `-d Ubuntu --exec sh -c ${holdScript} sh 30 60`,
          ])
          // The connection process runs the bridge, failing the connection with why it ended.
          const socket = yield* engineSocket(target, {
            env,
            askpass: Option.none(),
          })
          const failed = yield* Effect.flip(
            Effect.flatMap(socket.reader, reader => reader.pull),
          )
          expect(
            Option.map(wslFailed(failed), ({ failure }) => failure._tag),
          ).toEqual(Option.some('BridgeMissing'))
          expect((yield* runs).at(-1)).toBe(
            `-d Ubuntu --exec sh -c ${bridgeScript}`,
          )
        }).pipe(Effect.scoped),
    )
  })

  it('takes no distribution that wsl.exe would read as an option', () => {
    const decode = Schema.decodeUnknownResult(ConnectionTarget)
    expect(
      Result.isSuccess(decode({ _tag: 'Wsl', distro: 'Ubuntu-24.04' })),
    ).toBe(true)
    expect(Result.isSuccess(decode({ _tag: 'Wsl', distro: '--exec' }))).toBe(
      false,
    )
    expect(
      Result.isSuccess(decode({ _tag: 'Wsl', distro: 'Ubuntu; rm' })),
    ).toBe(false)
  })
})
