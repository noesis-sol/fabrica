import { Console, Duration, Effect, Exit, Layer, Option, Schema } from 'effect'
import * as NodePath from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, expect, it, layer } from '@effect/vitest'
import {
  EngineHost,
  ProjectId,
  ProjectInfo,
  Ticket,
  TicketDetail,
  Why,
} from '@fabrica/contracts'
import { Daemon, Git, Process } from '@fabrica/engine'
import {
  Toolbox,
  type Tools,
  layerHost,
  layerToolbox,
  makeGitRepo,
  tempFolder,
} from '@fabrica/testkit'

import { LocalEngine } from '../src/cli/connect'
import { runCli } from '../src/cli/main'
import { projectHolding } from '../src/cli/tickets'
import { versionLine } from '../src/version'

// `fabrica tickets list|show|create|update|close|reopen|defer|dep|label|note|ready|why|rebuild` (spec
// §19, §11): run as the CLI's entry runs it, against an engine started in a temporary data folder with
// one project, a checkout of the test's; each command with its text and with `--json`.

const host = new EngineHost({
  platform: 'linux',
  arch: 'x64',
  hostname: 'test',
  cores: 4,
})

/** The engine's git, run with the toolbox's PATH and home. */
const gitOf = (tools: Tools) =>
  Git.layer({
    timeLimit: Duration.minutes(1),
    readRetries: { times: 0, spacing: Duration.zero },
  }).pipe(
    Layer.provide(
      Process.layer({
        hostEnvironment: tools.env(),
        enginePriority: 0,
        priority: Process.hostPriority,
        listProcesses: Process.listProcesses,
        pipeHolders: Process.hostHolders({
          platform: process.platform,
          self: process.pid,
        }),
        self: process.pid,
        killGrace: Duration.seconds(2),
        outputGrace: Duration.millis(200),
      }),
    ),
    Layer.provide(Process.layerClock),
  )

/** `fabrica <args>` with the local engine at `socket`: its exit and what it printed. */
const fabrica = (socket: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const out: Array<string> = []
    const err: Array<string> = []
    const console: Console.Console = Object.assign(
      Object.create(globalThis.console),
      {
        log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(' ')),
        error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(' ')),
      },
    )
    const exit = yield* runCli(args).pipe(
      Effect.provideService(Console.Console, console),
      Effect.provide([
        NodeServices.layer,
        Layer.succeed(LocalEngine)({ socket: Effect.succeed(socket) }),
        layerHost(),
      ]),
      Effect.exit,
    )
    return { exit, out, err }
  })

/** An engine started in a temporary data folder with one project, `work`, for the test's scope. */
const testEngine = Effect.gen(function* () {
  const tools = yield* Toolbox
  const root = yield* tempFolder('tickets-cli')
  const paths = Daemon.pathsIn({
    data: NodePath.join(root, 'd'),
    socketFolder: NodePath.join(root, 'd'),
  })
  yield* Daemon.startEngine({
    paths,
    host,
    release: '1.2.3',
    git: gitOf(tools),
  })
  const repo = yield* makeGitRepo(tools)
  const added = yield* fabrica(paths.socket, 'project', 'add', repo.work)
  expect(added.exit).toStrictEqual(Exit.void)
  /** `fabrica tickets <args> --project work`. */
  const tickets = (...args: ReadonlyArray<string>) =>
    fabrica(paths.socket, 'tickets', ...args, '--project', 'work')
  return { socket: paths.socket, tickets }
})

/** The one line of JSON a command printed. */
const onlyJson = (out: ReadonlyArray<string>): unknown => {
  expect(out).toHaveLength(1)
  return JSON.parse(out[0] ?? '')
}

/** The ID a `create --json` printed. */
const createdId = (out: ReadonlyArray<string>): string =>
  Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(onlyJson(out))
    .id

const decodeTickets = Schema.decodeUnknownSync(Schema.Array(Ticket))
const decodeDetail = Schema.decodeUnknownSync(TicketDetail)
const decodeWhy = Schema.decodeUnknownSync(Why)

describe('projectHolding', () => {
  const info = (id: string, path: string) =>
    new ProjectInfo({
      id: ProjectId.make(id),
      name: id,
      path,
      origin: 'registered',
      url: Option.none(),
      base: 'main',
      setUp: false,
    })
  const projects = [info('app', '/src/app'), info('lib', '/src/app/vendor/lib')]

  it('finds the innermost checkout holding the folder', () => {
    const holding = (folder: string) =>
      Option.map(projectHolding(projects, folder), ({ id }) => id)
    expect(holding('/src/app')).toStrictEqual(Option.some('app'))
    expect(holding('/src/app/src')).toStrictEqual(Option.some('app'))
    expect(holding('/src/app/vendor/lib/x')).toStrictEqual(Option.some('lib'))
    expect(holding('/src/apple')).toStrictEqual(Option.none())
    expect(holding('/elsewhere')).toStrictEqual(Option.none())
  })
})

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica tickets',
  it => {
    it.effect(
      'files, reads, changes and closes tickets, in text and JSON',
      () =>
        Effect.gen(function* () {
          const { tickets } = yield* testEngine

          const created = yield* tickets(
            'create',
            'Log in',
            '--type',
            'feature',
            '--priority',
            '1',
            '--label',
            'auth',
            '--files',
            'src/login.ts,src/session.ts',
            '--files',
            'README.md',
            '--description',
            'With a password',
            '--json',
          )
          expect(created.exit).toStrictEqual(Exit.void)
          const login = createdId(created.out)
          const blockerText = yield* tickets('create', 'Store')
          expect(blockerText.out).toHaveLength(1)
          const blocker = (blockerText.out[0] ?? '').replace('created ', '')
          expect(blockerText.out).toStrictEqual([`created ${blocker}`])

          const linked = yield* tickets('dep', 'add', blocker, login)
          expect(linked.out).toStrictEqual([
            `linked: ${blocker} blocks ${login}`,
          ])

          const listed = yield* tickets('list', '--json')
          expect(
            decodeTickets(onlyJson(listed.out)).map(({ id }) => id),
          ).toStrictEqual([login, blocker])
          const listText = yield* tickets('list')
          const width = Math.max(login.length, blocker.length)
          expect(listText.out.join('\n')).toBe(
            [
              `${login.padEnd(width)}  open  P1  feature  Log in`,
              `${blocker.padEnd(width)}  open  P2  task     Store`,
            ].join('\n'),
          )
          const features = yield* tickets('list', '--type', 'feature', '--json')
          expect(
            decodeTickets(onlyJson(features.out)).map(({ id }) => id),
          ).toStrictEqual([login])

          const showJson = yield* tickets('show', login, '--json')
          expect(showJson.err).toStrictEqual([])
          expect(showJson.exit).toStrictEqual(Exit.void)
          const shown = decodeDetail(onlyJson(showJson.out))
          expect(shown.ticket.metadata.files).toStrictEqual(
            Option.some(['src/login.ts', 'src/session.ts', 'README.md']),
          )
          expect(shown.labels).toStrictEqual(['auth'])

          const updated = yield* tickets(
            'update',
            login,
            '--title',
            'Log in with a password',
            '--clear',
            'description',
          )
          expect(updated.out).toStrictEqual([`updated ${login}`])
          const labelled = yield* tickets(
            'label',
            login,
            '--add',
            'ui',
            '--remove',
            'auth',
          )
          expect(labelled.out).toStrictEqual([`labels of ${login}: +ui -auth`])
          const noted = yield* tickets(
            'note',
            login,
            'Tried a token first.',
            '--json',
          )
          expect(onlyJson(noted.out)).toMatchObject({ id: login })

          const showText = (yield* tickets('show', login)).out.join('\n')
          expect(showText).toContain(`${login}  Log in with a password`)
          expect(showText).toContain('type      feature')
          expect(showText).toContain('status    open')
          expect(showText).toContain('priority  1')
          expect(showText).toContain('labels    ui')
          expect(showText).toContain(
            'files     src/login.ts, src/session.ts, README.md',
          )
          expect(showText).toContain(`link      ${blocker} blocks ${login}`)
          expect(showText).not.toContain('With a password')
          expect(showText).toMatch(/maintainer: Tried a token first\.$/mu)

          // What is ready, and why the rest isn't, in words.
          const ready = yield* tickets('ready')
          expect(ready.out).toStrictEqual([`${blocker}  open  P2  task  Store`])
          const readyJson = yield* tickets('ready', '--json')
          expect(
            decodeTickets(onlyJson(readyJson.out)).map(({ id }) => id),
          ).toStrictEqual([blocker])
          const why = yield* tickets('why', login)
          expect(why.out.join('\n')).toBe(
            [
              `${login} isn't ready:`,
              `- waits for ${blocker} to merge: it is open`,
            ].join('\n'),
          )
          expect((yield* tickets('why', blocker)).out).toStrictEqual([
            `${blocker} is ready`,
          ])

          const closed = yield* tickets('close', blocker, '--reason', 'Built')
          expect(closed.out).toStrictEqual([`closed ${blocker}`])
          const whyJson = decodeWhy(
            onlyJson((yield* tickets('why', login, '--json')).out),
          )
          if (whyJson._tag !== 'not_ready') return expect.fail('ready')
          expect(
            whyJson.reasons.map(({ reason, words }) => [reason._tag, words]),
          ).toStrictEqual([
            [
              'closed_unmerged',
              `waits for ${blocker} to merge: it is closed but not merged`,
            ],
          ])

          const deferred = yield* tickets(
            'defer',
            login,
            '--until',
            '2030-01-01T00:00:00Z',
          )
          expect(deferred.out).toStrictEqual([
            `deferred ${login} until 2030-01-01T00:00:00.000Z`,
          ])
          expect((yield* tickets('reopen', login)).out).toStrictEqual([
            `reopened ${login}`,
          ])
          const reopened = yield* tickets('reopen', blocker, '--json')
          expect(onlyJson(reopened.out)).toStrictEqual({ id: blocker })
          const unlinked = yield* tickets('dep', 'remove', blocker, login)
          expect(unlinked.out).toStrictEqual([
            `unlinked: ${blocker} blocks ${login}`,
          ])
          const statuses = decodeTickets(
            onlyJson((yield* tickets('list', '--json')).out),
          ).map(({ status }) => status)
          expect(statuses).toStrictEqual(['open', 'open'])
        }).pipe(Effect.scoped),
    )

    it.effect('says what it couldn’t do, in words', () =>
      Effect.gen(function* () {
        const { socket, tickets } = yield* testEngine
        const missing = yield* tickets('show', 'work-zzzz')
        expect(Exit.isFailure(missing.exit)).toBe(true)
        expect(missing.err).toStrictEqual([
          'fabrica: the project work has no ticket work-zzzz',
        ])

        const a = createdId((yield* tickets('create', 'A', '--json')).out)
        const b = createdId((yield* tickets('create', 'B', '--json')).out)
        yield* tickets('dep', 'add', a, b)
        const cycle = yield* tickets('dep', 'add', b, a)
        expect(cycle.err).toStrictEqual([
          `fabrica: ${b} blocks ${a} would close a cycle; refused`,
        ])
        const priority = yield* tickets('create', 'C', '--priority', '7')
        expect(priority.err).toStrictEqual([
          "fabrica: 7 isn't a priority from 0 to 4",
        ])
        const nothing = yield* tickets('update', a)
        expect(nothing.err).toStrictEqual([
          'fabrica: nothing to change: give a field to set or --clear',
        ])

        const nowhere = yield* fabrica(
          socket,
          'tickets',
          'list',
          '--project',
          'nowhere',
        )
        expect(nowhere.err).toStrictEqual([
          'fabrica: the engine has no project nowhere',
        ])
        // The tests run in a folder no project's checkout holds.
        const unnamed = yield* fabrica(socket, 'tickets', 'ready')
        expect(Exit.isFailure(unnamed.exit)).toBe(true)
        expect(unnamed.err.join('\n')).toContain("no project's checkout holds")

        const rebuild = yield* fabrica(socket, 'tickets', 'rebuild', '--json')
        expect(Exit.isFailure(rebuild.exit)).toBe(true)
        expect(rebuild.err).toStrictEqual([
          `fabrica: \`fabrica tickets rebuild\` is not in ${versionLine} yet: it rebuilds the backlog from the tickets ref, which comes with sync (M4)`,
        ])
      }).pipe(Effect.scoped),
    )
  },
)
