import { Effect, Option } from 'effect'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import * as Net from 'node:net'
import * as NodePath from 'node:path'

import { describe, expect, layer, test } from '@effect/vitest'
import { Toolbox, layerToolbox, shStub, tempFolder } from '@fabrica/testkit'
import { ServiceInstall, appHostOf } from '@fabrica/ui/host'

import { type MainActions, registerIpc } from '../src/main/ipc'
import {
  bundledLauncher,
  ensureLocalEngine,
  installLoginService,
} from '../src/main/local-engine'
import { type PreloadIpc, channels, makeApi } from '../src/preload/api'

// The local engine (spec §7.1): the app starts the engine from the distribution it bundles when none
// answers at the socket, and not when one does; and installs the login service through the bundled
// `fabrica service install` when the user chooses. The bundled distribution is a fixture: its
// launcher notes each run's arguments, and `serve` runs a fixture engine that takes connections on
// the socket and notes its process, which the test then stops. Then the user's choice, from the page
// through the preload to main and back.

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

/** The bundled distribution's launcher: it notes its arguments, then serves, or answers `service install`. */
const launcherScript = shStub(
  [
    'echo "$*" >> "$FIXTURE_RUNS"',
    'case "$1" in',
    '  serve) exec node "$FIXTURE_ENGINE" "$FIXTURE_SOCKET" "$FIXTURE_PID" ;;',
    '  service) [ -n "$FIXTURE_SERVICE_FAILS" ] && { echo "$FIXTURE_SERVICE_FAILS" >&2; exit 1; }; exit 0 ;;',
    'esac',
    'exit 2',
  ].join('\n'),
)

/** The lines the launcher noted, one per run. */
const runsIn = (path: string) =>
  Effect.promise(() =>
    readFile(path, 'utf8')
      .then(text => text.split('\n').filter(line => line !== ''))
      .catch(() => []),
  )

/** A bundled distribution in the app's resources, with the paths its launcher writes to. */
const bundle = (vars: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const tools = yield* Toolbox
    // A short folder: a socket's path has a length limit (104 bytes on macOS).
    const root = yield* tempFolder('le')
    const resources = NodePath.join(root, 'resources')
    const launcher = bundledLauncher(resources)
    const engine = NodePath.join(root, 'engine.cjs')
    const socket = NodePath.join(root, 'engine.sock')
    const runs = NodePath.join(root, 'runs')
    const pid = NodePath.join(root, 'engine.pid')
    yield* Effect.promise(async () => {
      await mkdir(NodePath.dirname(launcher), { recursive: true })
      await writeFile(launcher, launcherScript)
      await chmod(launcher, 0o755)
      await writeFile(engine, fixtureEngine)
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
      launcher,
      socket,
      runs,
      env: tools.env({
        FIXTURE_RUNS: runs,
        FIXTURE_ENGINE: engine,
        FIXTURE_SOCKET: socket,
        FIXTURE_PID: pid,
        ...vars,
      }),
    }
  })

/** An engine already listening on `socket`, for the scope. */
const listening = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server>(resume => {
      const server = Net.createServer(connection => connection.end())
      server.listen(socket, () => resume(Effect.succeed(server)))
    }),
    server =>
      Effect.callback<void>(resume => {
        server.close(() => resume(Effect.void))
      }),
  )

/** Whether something takes a connection on `socket`. */
const answers = (socket: string) =>
  Effect.callback<boolean>(resume => {
    const connection = Net.createConnection({ path: socket })
    connection.once('connect', () => {
      connection.destroy()
      resume(Effect.succeed(true))
    })
    connection.once('error', () => resume(Effect.succeed(false)))
  })

// The engine's start and its connections run on the live clock.
layer(layerToolbox({ tools: ['node'] }), { excludeTestServices: true })(
  'the local engine',
  it => {
    it.effect(
      'starts the bundled engine when none answers, detached, and it then answers',
      () =>
        Effect.gen(function* () {
          const fixture = yield* bundle()
          expect(yield* answers(fixture.socket)).toBe(false)
          const reached = yield* ensureLocalEngine({
            socket: fixture.socket,
            launcher: Option.some(fixture.launcher),
            env: fixture.env,
          })
          expect(reached._tag).toBe('Started')
          expect(yield* runsIn(fixture.runs)).toEqual(['serve'])
          expect(yield* answers(fixture.socket)).toBe(true)

          // Once it runs, the next start of the app finds it and starts no other.
          const again = yield* ensureLocalEngine({
            socket: fixture.socket,
            launcher: Option.some(fixture.launcher),
            env: fixture.env,
          })
          expect(again._tag).toBe('Answered')
          expect(yield* runsIn(fixture.runs)).toEqual(['serve'])
        }).pipe(Effect.scoped),
    )

    it.effect('starts none when an engine answers', () =>
      Effect.gen(function* () {
        const fixture = yield* bundle()
        yield* listening(fixture.socket)
        const reached = yield* ensureLocalEngine({
          socket: fixture.socket,
          launcher: Option.some(fixture.launcher),
          env: fixture.env,
        })
        expect(reached._tag).toBe('Answered')
        expect(yield* runsIn(fixture.runs)).toEqual([])
      }).pipe(Effect.scoped),
    )

    it.effect(
      'a build that bundles no engine reaches a running one, and starts none',
      () =>
        Effect.gen(function* () {
          const fixture = yield* bundle()
          const failure = yield* ensureLocalEngine({
            socket: fixture.socket,
            launcher: Option.none(),
            env: fixture.env,
          }).pipe(Effect.flip)
          expect(failure._tag).toBe('NoBundledEngine')

          yield* listening(fixture.socket)
          const reached = yield* ensureLocalEngine({
            socket: fixture.socket,
            launcher: Option.none(),
            env: fixture.env,
          })
          expect(reached._tag).toBe('Answered')
        }).pipe(Effect.scoped),
    )

    it.effect(
      'installs the login service through fabrica service install',
      () =>
        Effect.gen(function* () {
          const fixture = yield* bundle()
          yield* installLoginService({
            launcher: Option.some(fixture.launcher),
            env: fixture.env,
          })
          expect(yield* runsIn(fixture.runs)).toEqual(['service install'])
        }).pipe(Effect.scoped),
    )

    it.effect('says why the login service could not be installed', () =>
      Effect.gen(function* () {
        const fixture = yield* bundle({
          FIXTURE_SERVICE_FAILS: 'systemd has no user instance here',
        })
        const failure = yield* installLoginService({
          launcher: Option.some(fixture.launcher),
          env: fixture.env,
        }).pipe(Effect.flip)
        expect(failure.reason).toBe('systemd has no user instance here')

        const unbundled = yield* installLoginService({
          launcher: Option.none(),
          env: fixture.env,
        }).pipe(Effect.flip)
        expect(unbundled.reason).toBe('this build bundles no engine to install')
      }).pipe(Effect.scoped),
    )
  },
)

describe('the bundled distribution', () => {
  test('lies under the resources, as the distribution lays its launcher out', () => {
    expect(
      bundledLauncher('/Applications/Fabrica.app/Contents/Resources'),
    ).toBe('/Applications/Fabrica.app/Contents/Resources/engine/bin/fabrica')
  })
})

describe("the user's choice of the login service", () => {
  const app = 'file:///app/index.html'

  /** Main's end, as `registerIpc` sets it up, answering `installLoginService` with `answer`. */
  const mainAnswering = (answer: () => Promise<ServiceInstall>) => {
    const handlers = new Map<
      string,
      (
        sender: string | undefined,
        values: ReadonlyArray<unknown>,
      ) => Promise<unknown>
    >()
    const unused = () => Promise.reject(new Error('not this test’s'))
    const actions: MainActions = {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      setTheme: () => undefined,
      notify: () => undefined,
      pickFolder: unused,
      version: '1.0.0',
      updateStatus: () => ({ _tag: 'Unavailable' }),
      installLoginService: answer,
      checkEngine: unused,
      installEngine: unused,
      answerSshPrompt: () => undefined,
    }
    registerIpc({
      ipc: {
        on: () => undefined,
        handle: (channel, handler) => handlers.set(channel, handler),
      },
      trusted: url => url === app,
      actions,
    })
    return (sender: string, channel: string, values: ReadonlyArray<unknown>) =>
      handlers.get(channel)?.(sender, values) ??
      Promise.reject(new Error(`no handler for ${channel}`))
  }

  /** The preload over main's end, as the app's page reaches it: `window.fabrica`. */
  const pageWindow = (
    invoke: (
      sender: string,
      channel: string,
      values: ReadonlyArray<unknown>,
    ) => Promise<unknown>,
    sender = app,
  ) => {
    const ipc: PreloadIpc = {
      send: () => undefined,
      invoke: (channel, ...values) => invoke(sender, channel, values),
      on: () => () => undefined,
    }
    return { fabrica: makeApi(ipc) }
  }

  test('reaches main from the page, and its answer comes back decoded', async () => {
    let asked = 0
    const invoke = mainAnswering(() => {
      asked += 1
      return Promise.resolve(ServiceInstall.cases.Installed.make({}))
    })
    const host = appHostOf(pageWindow(invoke))
    const install = Option.getOrThrow(host.installLoginService)
    expect(await Effect.runPromise(install)).toEqual(
      ServiceInstall.cases.Installed.make({}),
    )
    expect(asked).toBe(1)
  })

  test('a refused request, or an answer that does not decode, is a failure in words', async () => {
    const refused = appHostOf(
      pageWindow(
        mainAnswering(() =>
          Promise.resolve(ServiceInstall.cases.Installed.make({})),
        ),
        'https://example.com/',
      ),
    )
    const outcome = await Effect.runPromise(
      Option.getOrThrow(refused.installLoginService),
    )
    expect(outcome._tag).toBe('Failed')
    expect(outcome._tag === 'Failed' && outcome.reason).toMatch(/refused/u)

    const garbled = appHostOf(
      pageWindow(async (_sender, channel) =>
        channel === channels.installLoginService
          ? { _tag: 'Exploded' }
          : undefined,
      ),
    )
    const said = await Effect.runPromise(
      Option.getOrThrow(garbled.installLoginService),
    )
    expect(said._tag).toBe('Failed')
  })

  test('the renderer alone in a browser has no app to ask', () => {
    expect(Option.isNone(appHostOf({}).installLoginService)).toBe(true)
  })
})
