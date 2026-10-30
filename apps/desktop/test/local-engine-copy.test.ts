import { Effect, Option, Schema } from 'effect'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, layer, test } from '@effect/vitest'
import { ReleaseVersion } from '@fabrica/contracts'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'

import {
  bundledEngine,
  ensureLocalEngine,
  installLoginService,
  installedLauncher,
} from '../src/main/local-engine'

// The local engine runs from a copy of the distribution the app bundles (spec §7.1, fab-09t), never
// from the app's own folder, which goes as an AppImage or a dmg is unmounted and is replaced by an
// update: the copy is installed as on any host (§9.2), into ~/.local/share/fabrica/engine/<version>/
// with ~/.local/bin/fabrica linked to it, and both the detached engine and the login service run from
// there. The bundled distribution is a fixture: a launcher that says its version and notes each other
// run, by the path it ran from, a relative link inside it, as pnpm's node_modules have, and a file.

const version = Schema.decodeUnknownSync(ReleaseVersion)('1.2.3')

/** The fixture engine: it takes connections on the socket it is given and closes them, noting its PID first. */
const fixtureEngine = `
const net = require('node:net')
const fs = require('node:fs')
const [socket, pidFile] = process.argv.slice(2)
fs.writeFileSync(pidFile, String(process.pid))
net.createServer(connection => connection.end()).listen(socket)
// Never outlives a test that failed to stop it.
setTimeout(() => process.exit(0), 60_000).unref()
`

/**
 * The fixture launcher: it says `said` for its version, else notes where it ran from and with what,
 * then serves, or answers `service install`.
 */
const launcherScript = (said: string) =>
  shStub(
    [
      `[ "$1" = --version ] && { echo '${said}'; exit 0; }`,
      'echo "$0 $*" >> "$FIXTURE_RUNS"',
      '[ "$1" = serve ] && exec node "$FIXTURE_ENGINE" "$FIXTURE_SOCKET" "$FIXTURE_PID"',
      'exit 0',
    ].join('\n'),
  )

/** A packaged app's resources with a fixture distribution, a home folder, and where the runs are noted. */
const app = (said = `fabrica v${version}`) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    // A short folder: a socket's path has a length limit (104 bytes on macOS).
    const root = yield* tempFolder('lc')
    const resources = NodePath.join(root, 'resources')
    const home = NodePath.join(root, 'home')
    const bundled = bundledEngine({ resources, version, home })
    const runs = NodePath.join(root, 'runs')
    const engine = NodePath.join(root, 'engine.cjs')
    const socket = NodePath.join(root, 'engine.sock')
    const pid = NodePath.join(root, 'engine.pid')
    yield* Effect.promise(async () => {
      await writeFile(engine, fixtureEngine)
      await mkdir(NodePath.join(bundled.folder, 'bin'), { recursive: true })
      await mkdir(NodePath.join(bundled.folder, 'lib', 'pkg'), {
        recursive: true,
      })
      const launcher = NodePath.join(bundled.folder, 'bin', 'fabrica')
      await writeFile(launcher, launcherScript(said))
      await chmod(launcher, 0o755)
      await writeFile(
        NodePath.join(bundled.folder, 'lib', 'pkg', 'main.js'),
        'bundled',
      )
      await symlink('pkg', NodePath.join(bundled.folder, 'lib', 'linked'))
    })
    // The fixture engine was started here, detached: the test stops it by the PID it noted.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        readFile(pid, 'utf8')
          .then(text => process.kill(Number(text), 'SIGTERM'))
          .catch(() => undefined),
      ),
    )
    return {
      root,
      resources,
      home,
      bundled,
      runs,
      socket,
      env: tools.env({
        FIXTURE_RUNS: runs,
        FIXTURE_ENGINE: engine,
        FIXTURE_SOCKET: socket,
        FIXTURE_PID: pid,
      }),
    }
  })

const runsIn = (path: string) =>
  Effect.promise(() =>
    readFile(path, 'utf8')
      .then(text => text.split('\n').filter(line => line !== ''))
      .catch(() => []),
  )

const read = (path: string) => Effect.promise(() => readFile(path, 'utf8'))

const linkOf = (path: string) =>
  Effect.promise(() => readlink(path).catch(() => ''))

/** What the engines' folder holds: no stage of an install is left behind. */
const enginesIn = (folder: string) => Effect.promise(() => readdir(folder))

// The engine's start and its connections run on the live clock.
layer(layerToolbox({ tools: ['node'] }), { excludeTestServices: true })(
  "the local engine's copy",
  it => {
    it.effect(
      'installs a copy under the home folder, links fabrica to it, and starts the engine from it',
      () =>
        Effect.gen(function* () {
          const fixture = yield* app()
          const launcher = installedLauncher(fixture.bundled)
          expect(launcher).toBe(
            NodePath.join(
              fixture.home,
              '.local/share/fabrica/engine/1.2.3/bin/fabrica',
            ),
          )
          const reached = yield* ensureLocalEngine({
            socket: fixture.socket,
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          })
          expect(reached._tag).toBe('Started')
          expect(yield* runsIn(fixture.runs)).toEqual([`${launcher} serve`])
          expect(yield* linkOf(fixture.bundled.places.link)).toBe(launcher)
          const copy = NodePath.dirname(NodePath.dirname(launcher))
          expect(
            yield* read(NodePath.join(copy, 'lib', 'linked', 'main.js')),
          ).toBe('bundled')
          expect(yield* linkOf(NodePath.join(copy, 'lib', 'linked'))).toBe(
            'pkg',
          )
          expect(yield* enginesIn(fixture.bundled.places.engines)).toEqual([
            '1.2.3',
          ])

          // The app's folder goes (its mount, an update): the copy runs on.
          yield* Effect.promise(() =>
            rm(fixture.resources, { recursive: true, force: true }),
          )
          yield* installLoginService({
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          })
          expect(yield* runsIn(fixture.runs)).toEqual([
            `${launcher} serve`,
            `${launcher} service install`,
          ])
        }).pipe(Effect.scoped),
    )

    it.effect(
      'keeps a version installed already as it is, since its engine may be running',
      () =>
        Effect.gen(function* () {
          const fixture = yield* app()
          const launcher = installedLauncher(fixture.bundled)
          yield* installLoginService({
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          })
          const copied = NodePath.join(
            NodePath.dirname(NodePath.dirname(launcher)),
            'lib',
            'pkg',
            'main.js',
          )
          const before = yield* Effect.promise(() => lstat(copied))
          yield* Effect.promise(() =>
            writeFile(
              NodePath.join(fixture.bundled.folder, 'lib', 'pkg', 'main.js'),
              'changed',
            ),
          )
          yield* installLoginService({
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          })
          expect(yield* read(copied)).toBe('bundled')
          expect((yield* Effect.promise(() => lstat(copied))).ino).toBe(
            before.ino,
          )
        }).pipe(Effect.scoped),
    )

    it.effect(
      'links fabrica to an installed version only where the link names no engine',
      () =>
        Effect.gen(function* () {
          const fixture = yield* app()
          const launcher = installedLauncher(fixture.bundled)
          const { link } = fixture.bundled.places
          const install = installLoginService({
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          })
          yield* install

          // Gone: linked again.
          yield* Effect.promise(() => rm(link))
          yield* install
          expect(yield* linkOf(link)).toBe(launcher)

          // Naming nothing: linked again.
          yield* Effect.promise(async () => {
            await rm(link)
            await symlink(NodePath.join(fixture.root, 'nothing'), link)
          })
          yield* install
          expect(yield* linkOf(link)).toBe(launcher)

          // Naming another engine, one the user installed: left to it.
          const other = NodePath.join(fixture.root, 'other-fabrica')
          yield* Effect.promise(async () => {
            await writeFile(other, shStub('exit 0'))
            await rm(link)
            await symlink(other, link)
          })
          yield* install
          expect(yield* linkOf(link)).toBe(other)
        }).pipe(Effect.scoped),
    )

    it.effect(
      'installs nothing, and starts nothing, where the bundled launcher says another version',
      () =>
        Effect.gen(function* () {
          const fixture = yield* app('fabrica v9.9.9')
          const failure = yield* ensureLocalEngine({
            socket: fixture.socket,
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          }).pipe(Effect.flip)
          expect(failure._tag).toBe('EngineCopyFailed')
          expect(failure.message).toContain('fabrica v9.9.9')
          expect(yield* runsIn(fixture.runs)).toEqual([])
          expect(yield* enginesIn(fixture.bundled.places.engines)).toEqual([])
          expect(yield* linkOf(fixture.bundled.places.link)).toBe('')

          const refused = yield* installLoginService({
            bundled: Option.some(fixture.bundled),
            env: fixture.env,
          }).pipe(Effect.flip)
          expect(refused.reason).toContain('fabrica v9.9.9')
          expect(yield* runsIn(fixture.runs)).toEqual([])
        }).pipe(Effect.scoped),
    )
  },
)

describe('the bundled engine', () => {
  test('lies under the resources, its copy under the home folder, by its version', () => {
    const bundled = bundledEngine({
      resources: '/Applications/Fabrica.app/Contents/Resources',
      version,
      home: '/Users/someone',
    })
    expect(bundled.folder).toBe(
      '/Applications/Fabrica.app/Contents/Resources/engine',
    )
    expect(installedLauncher(bundled)).toBe(
      '/Users/someone/.local/share/fabrica/engine/1.2.3/bin/fabrica',
    )
    expect(bundled.places.link).toBe('/Users/someone/.local/bin/fabrica')
  })
})
