import { Effect, Option } from 'effect'
import { access, readFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'
import { AskpassHelper } from '@fabrica/client'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import { stageAskpass } from '../build/askpass'
import { askpassArguments, askpassHelperOf } from '../src/connection/askpass'
import { askpassHelper } from '../src/main/ssh-prompts'

// What ssh runs as `SSH_ASKPASS` (spec §9.1): the helper main names on each platform, handed to the
// connection process in its arguments, and how packing the Windows app builds the program it names there. The
// program itself runs on Windows CI (windows-askpass.test.ts).

const resources = '/Applications/Fabrica.app/Contents/Resources'

describe('the helper main names', () => {
  it('is the relay script on the Node the app has, on macOS and Linux', () => {
    expect(
      askpassHelper({ platform: 'darwin', packaged: true, resources }),
    ).toEqual(
      Option.some(
        AskpassHelper.Node({ node: `${resources}/engine/node/bin/node` }),
      ),
    )
    expect(
      askpassHelper({ platform: 'linux', packaged: false, resources }),
    ).toEqual(Option.some(AskpassHelper.Node({ node: 'node' })))
  })

  it("is the app's own program on Windows, and none in a development build", () => {
    expect(
      askpassHelper({ platform: 'win32', packaged: true, resources }),
    ).toEqual(
      Option.some(
        AskpassHelper.Executable({
          path: NodePath.join(resources, 'askpass', 'fabrica-askpass.exe'),
        }),
      ),
    )
    expect(
      askpassHelper({ platform: 'win32', packaged: false, resources }),
    ).toEqual(Option.none())
  })
})

describe("the connection process's arguments", () => {
  it.each([
    AskpassHelper.Node({ node: '/opt/my node/bin/node' }),
    AskpassHelper.Executable({
      path: 'C:\\Program Files\\Fabrica\\resources\\askpass\\fabrica-askpass.exe',
    }),
  ])('hand on $_tag', helper => {
    const named = Option.some(helper)
    expect(
      askpassHelperOf(['electron', ...askpassArguments(named), '--other']),
    ).toEqual(named)
  })

  it('name none where ssh is to ask nothing', () => {
    expect(askpassArguments(Option.none())).toEqual([])
    expect(askpassHelperOf(['electron', '--askpass-node='])).toEqual(
      Option.none(),
    )
    expect(askpassHelperOf(['electron', '--askpass-executable='])).toEqual(
      Option.none(),
    )
  })
})

const clang = shStub(
  [
    'printf "%s\\n" "$@" > "$CLANG_ARGUMENTS"',
    'while [ "$#" -gt 1 ]; do shift; done',
    'printf "built" > "$1"',
  ].join('\n'),
)

describe("packing the Windows app's helper", () => {
  layer(layerToolbox({ stubs: { clang } }))(it => {
    it.effect(
      'builds it with no runtime to install, in place of what was staged',
      () =>
        Effect.gen(function* () {
          const tools = yield* Toolbox
          const root = yield* tempFolder('stage-askpass')
          const stage = NodePath.join(root, 'stage')
          const recorded = NodePath.join(root, 'arguments')
          const build = () =>
            stageAskpass({
              source: 'askpass.c',
              stage,
              env: tools.env({ CLANG_ARGUMENTS: recorded }),
            })
          yield* Effect.promise(build)
          yield* Effect.promise(build)
          const program = NodePath.join(stage, 'fabrica-askpass.exe')
          expect(yield* Effect.promise(() => readFile(program, 'utf8'))).toBe(
            'built',
          )
          const said = yield* Effect.promise(() => readFile(recorded, 'utf8'))
          expect(said.trim().split('\n')).toEqual(
            expect.arrayContaining([
              '-fms-runtime-lib=static',
              'askpass.c',
              '-o',
              program,
            ]),
          )
        }),
    )
  })

  layer(layerToolbox({}))(it => {
    it.effect('says what it takes where there is no clang', () =>
      Effect.gen(function* () {
        const tools = yield* Toolbox
        const root = yield* tempFolder('stage-askpass')
        const stage = NodePath.join(root, 'stage')
        const failed = yield* Effect.promise(() =>
          stageAskpass({ source: 'askpass.c', stage, env: tools.env() }).then(
            () => '',
            (error: Error) => error.message,
          ),
        )
        expect(failed).toMatch(/takes clang on the PATH/u)
        // Emptied first, so no earlier build is packed in its place.
        yield* Effect.promise(() => access(stage))
      }),
    )
  })
})
