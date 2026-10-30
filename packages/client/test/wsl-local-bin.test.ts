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

import { WslDistro } from '../src'
import { wslBridgeArguments, wslEnded } from '../src/node'

// The command wsl.exe runs in the distribution (fab-mgi.85): `fabrica bridge`, or the engine's link
// `~/.local/bin/fabrica` where the distribution's PATH lacks it, as the PATH wsl.exe gives a command does
// on Ubuntu. A stub wsl.exe runs an `--exec` command as it is given, over a PATH holding only sh; a stub
// `fabrica` says which one ran and with what.

const toolbox = layerToolbox({
  tools: ['sh'],
  stubs: {
    'wsl.exe': shStub(
      ['[ "$1 $3" = "-d --exec" ] || exit 2', 'shift 3', 'exec "$@"'].join(
        '\n',
      ),
    ),
  },
})

const distro = WslDistro.make('Ubuntu')

/** A stub `fabrica` at `path`, printing the path it ran as and its arguments. */
const writeFabrica = (path: string) =>
  Effect.promise(async () => {
    await mkdir(NodePath.dirname(path), { recursive: true })
    await writeFile(path, shStub('echo "$0 $*"'))
    await chmod(path, 0o755)
  })

/** A distribution whose home folder and PATH folder are new; wsl.exe's bridge run over it. */
const setUp = Effect.gen(function* () {
  const tools = yield* Toolbox
  const home = yield* tempFolder('wsl-home')
  const onPath = yield* tempFolder('wsl-path')
  const linked = NodePath.join(home, '.local', 'bin', 'fabrica')
  const found = NodePath.join(onPath, 'fabrica')
  const wsl = (path: string) =>
    runCommandExit({
      command: 'wsl.exe',
      args: wslBridgeArguments({ distro }),
      cwd: home,
      env: tools.env({ HOME: home, PATH: path }),
    })
  return {
    bare: wsl(tools.bin),
    withFabrica: wsl(`${onPath}${NodePath.delimiter}${tools.bin}`),
    linked,
    found,
    link: writeFabrica(linked),
    install: writeFabrica(found),
  }
})

describe("wsl.exe's command in the distribution", () => {
  layer(toolbox, { excludeTestServices: true })(it => {
    it.effect('runs ~/.local/bin/fabrica over a PATH without fabrica', () =>
      Effect.gen(function* () {
        const host = yield* setUp
        yield* host.link
        expect(yield* host.bare).toEqual({
          code: 0,
          stdout: `${host.linked} bridge\n`,
          stderr: '',
        })
      }).pipe(Effect.scoped),
    )

    it.effect('runs the fabrica on the PATH first', () =>
      Effect.gen(function* () {
        const host = yield* setUp
        yield* host.link
        yield* host.install
        expect((yield* host.withFabrica).stdout).toBe(`${host.found} bridge\n`)
      }).pipe(Effect.scoped),
    )

    it.effect('says the bridge is missing where neither is', () =>
      Effect.gen(function* () {
        const host = yield* setUp
        const ran = yield* host.bare
        expect(ran.code).toBe(127)
        expect(
          Option.map(
            wslEnded({ code: ran.code, signal: null, stderr: ran.stderr }),
            failure => failure._tag,
          ),
        ).toEqual(Option.some('BridgeMissing'))
      }).pipe(Effect.scoped),
    )
  })
})
