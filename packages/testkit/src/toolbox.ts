import { Context, Effect, Layer, Option, type Scope } from 'effect'
import {
  access,
  chmod,
  constants,
  mkdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { airtightEnv } from './env'
import { KitFailed, ToolNotFound } from './errors'
import { tempFolder } from './temp'

// A test's PATH (spec §24): a folder holding only the real tools the test names, linked from the
// host's PATH, and stub scripts standing in for the rest. A command the test runs finds nothing else.
// macOS scans a newly written executable for 0.2–0.8 s the first time it runs, so a test file makes its
// toolbox once, for all its tests (`layerToolbox` under `layer` of `@effect/vitest`), never per test
// (tutti-6ns2). Stubs are shell scripts: the kit runs on macOS and Linux.

export interface ToolboxSpec {
  /** Real tools, by name, linked into the toolbox from the host's PATH. */
  readonly tools?: ReadonlyArray<string>
  /** Stub scripts by name: each one's whole text, `#!` line included (`shStub`). */
  readonly stubs?: Readonly<Record<string, string>>
}

/** A made toolbox. */
export interface Tools {
  /** The folder holding the tools and stubs: a whole PATH. */
  readonly bin: string
  /** An empty home folder for the test's commands. */
  readonly home: string
  /** An airtight environment with the toolbox as its PATH, its home, and `vars`. */
  readonly env: (
    vars?: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>>
}

/** A stub script running `body` in `/bin/sh`. */
export const shStub = (body: string): string => `#!/bin/sh\n${body}\n`

/** The PATH of the process running the tests: read only here, to find the real tools a toolbox links. */
export const hostPathOfProcess = (): string => process.env['PATH'] ?? ''

const isExecutableFile = (path: string): Promise<boolean> =>
  stat(path)
    .then(info => info.isFile())
    .then(file =>
      file ? access(path, constants.X_OK).then(() => true) : false,
    )
    .catch(() => false)

/** Where `tool` is on `path`: the first of its folders holding an executable file by that name. */
export const findTool = (
  tool: string,
  path: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.promise(async () => {
    for (const folder of path.split(NodePath.delimiter)) {
      if (folder === '') continue
      const candidate = NodePath.join(folder, tool)
      if (await isExecutableFile(candidate)) return Option.some(candidate)
    }
    return Option.none<string>()
  })

const fileStep = (operation: string, path: string, run: () => Promise<void>) =>
  Effect.tryPromise({
    try: run,
    catch: cause => new KitFailed({ operation, path, cause }),
  })

/** Makes a toolbox in a temp folder removed as the scope closes; tools are looked for on `hostPath`. */
export const makeToolbox = (
  options: ToolboxSpec & { readonly hostPath: string },
): Effect.Effect<Tools, ToolNotFound | KitFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* tempFolder('toolbox')
    const bin = NodePath.join(root, 'bin')
    const home = NodePath.join(root, 'home')
    yield* fileStep('make the toolbox', root, async () => {
      await Promise.all([mkdir(bin), mkdir(home)])
    })
    const found = yield* Effect.forEach(
      options.tools ?? [],
      tool =>
        findTool(tool, options.hostPath).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolNotFound({ tool, path: options.hostPath })),
              onSome: path => Effect.succeed({ tool, path }),
            }),
          ),
        ),
      { concurrency: 'unbounded' },
    )
    yield* Effect.forEach(
      found,
      ({ tool, path }) =>
        fileStep('link a tool', path, () =>
          symlink(path, NodePath.join(bin, tool)),
        ),
      { concurrency: 'unbounded' },
    )
    yield* Effect.forEach(
      Object.entries(options.stubs ?? {}),
      ([name, text]) => {
        const path = NodePath.join(bin, name)
        return fileStep('write a stub', path, async () => {
          await writeFile(path, text)
          await chmod(path, 0o755)
        })
      },
      { concurrency: 'unbounded' },
    )
    return {
      bin,
      home,
      env: vars =>
        airtightEnv({
          path: bin,
          home,
          ...(vars === undefined ? {} : { vars }),
        }),
    }
  })

/** A test file's toolbox. */
export class Toolbox extends Context.Service<Toolbox, Tools>()('Toolbox') {}

/** The toolbox, made once for the tests the layer serves, its tools found on the host's PATH. */
export const layerToolbox = (
  spec: ToolboxSpec,
): Layer.Layer<Toolbox, ToolNotFound | KitFailed> =>
  Layer.effect(Toolbox, makeToolbox({ ...spec, hostPath: hostPathOfProcess() }))
