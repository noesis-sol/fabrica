import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
} from 'effect'
import { RpcTest } from 'effect/rpc'
import { SqlClient } from 'effect/sql'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  CommitHash,
  EngineId,
  LocalTime,
  NoBranch,
  NoReport,
  NoRun,
  ProjectId,
  ProjectNotFound,
  ReviewRpcs,
  RunEvent,
  RunId,
  RunNotFound,
  TicketId,
  encodeEventLine,
} from '@fabrica/contracts'

import { engineDatabaseLayer } from '../src/engine'
import { type GitConfig, layer as gitLayer, ticketBranch } from '../src/git'
import {
  type RunnerConfig,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'
import { reviewHandlersOn } from '../src/rpc/review'
import { eventsPath, logPath, reportPath } from '../src/runlog'

// The Review group over RPC (spec §8.1, §18.4, §20.2): a ticket's branch diff, a run's merged diff, its
// report and the human log's tail, against real git in temp folders and a project in an in-memory
// engine.db; a link planted where the engine reads is refused.

let root = ''
let home = ''
let gitFolder = ''
let counter = 0

const fixtureEnv = () => ({
  PATH: `${gitFolder}:/usr/bin:/bin`,
  HOME: home,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
})

/** Runs git for a test's fixture, its output trimmed. */
const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

const hash = (cwd: string, revision: string): CommitHash =>
  CommitHash.make(git(cwd, 'rev-parse', '--verify', `${revision}^{commit}`))

/** Writes `files` in `cwd` and commits them as `message`, returning the commit. */
const commit = (
  cwd: string,
  message: string,
  files: Readonly<Record<string, string>>,
): CommitHash => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true })
    writeFileSync(join(cwd, name), content)
  }
  git(cwd, 'add', '--all')
  git(cwd, 'commit', '--quiet', '--message', message)
  return hash(cwd, 'HEAD')
}

/** A new checkout on `main` with one commit, in a folder of its own. */
const repository = () => {
  counter += 1
  const checkout = join(root, `repo-${counter}`)
  mkdirSync(checkout)
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  const first = commit(checkout, 'one', {
    'README.md': 'one\n',
    'src/a.ts': 'export const a = 1\n',
    'src/old.ts':
      'export const moved = "a file long enough to be found again"\n',
    'gone.txt': 'gone\n',
  })
  return { checkout, first }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-review-')))
  home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n[init]\n\tdefaultBranch = main\n',
  )
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

const runnerConfig = (): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const gitConfig: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 1, spacing: Duration.zero },
}

const project = ProjectId.make('app')
const ticket = TicketId.make('fa-a1b2')

/** A client of the Review group's handlers, the project `app` at `checkout` with Base `main`. */
const clientFor = (checkout: string) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      reviewHandlersOn.pipe(
        Layer.provide(
          gitLayer(gitConfig).pipe(
            Layer.provide(runnerLayer(runnerConfig())),
            Layer.provide(layerClock),
          ),
        ),
        Layer.provideMerge(engineDatabaseLayer(':memory:')),
      ),
    )
    const sql = Context.get(services, SqlClient.SqlClient)
    yield* sql`INSERT INTO projects (id, name, path, origin, base, added_at)
      VALUES (${project}, 'app', ${checkout}, 'registered', 'main', 0)`
    return yield* RpcTest.makeClient(ReviewRpcs).pipe(Effect.provide(services))
  })

/** Whether `exit` is the safe reader's refusal, as a defect: kept to its request, the file never read. */
const isRefused = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    reason =>
      Cause.isDieReason(reason) &&
      typeof reason.defect === 'object' &&
      reason.defect !== null &&
      '_tag' in reason.defect &&
      reason.defect._tag === 'FileRefused',
  )

const time = LocalTime.make('2026-10-29T10:15:00.000+02:00')

/** The records of a run that started at `start` on main and merged `merged`, in order. */
const runRecords = (
  run: RunId,
  start: CommitHash,
  merged: ReadonlyArray<CommitHash>,
): ReadonlyArray<RunEvent> => [
  RunEvent.cases.start.make({
    time,
    run,
    version: '0.1.0',
    engine: EngineId.make('laptop'),
    repo: '/repo',
    branch: 'main',
    commit: start,
    concurrency: 2,
  }),
  ...merged.flatMap((commit, index) => [
    RunEvent.cases.closed.make({
      time,
      run,
      ticket: TicketId.make(`fa-m${index}`),
      title: 'A change',
      commit,
      detail: `${commit.slice(0, 7)} merged into main`,
      text: 'closed',
    }),
    RunEvent.cases.closed.make({
      time,
      run,
      ticket: TicketId.make(`fa-n${index}`),
      title: 'No change',
      detail: 'no change to merge',
      text: 'closed',
    }),
  ]),
]

/** Writes `records` as the checkout's event stream. */
const writeEvents = (checkout: string, records: ReadonlyArray<RunEvent>) => {
  mkdirSync(dirname(join(checkout, eventsPath)), { recursive: true })
  writeFileSync(
    join(checkout, eventsPath),
    records.map(record => `${encodeEventLine(record)}\n`).join(''),
  )
}

describe('diff.ticket', () => {
  it.effect(
    "diffs the ticket's branch against its merge base with Base, file by file",
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const branch = ticketBranch(ticket)
        git(checkout, 'switch', '--quiet', '--create', branch)
        commit(checkout, 'change', {
          'src/a.ts': 'export const a = 2\n',
          'src/b.ts': 'export const b = 1\n',
        })
        git(checkout, 'rm', '--quiet', 'gone.txt')
        git(checkout, 'mv', 'src/old.ts', 'src/new.ts')
        git(checkout, 'commit', '--quiet', '--message', 'move')
        const head = hash(checkout, 'HEAD')
        // Base moves on after the branch left it: its commit is no part of the ticket's diff.
        git(checkout, 'switch', '--quiet', 'main')
        commit(checkout, 'on main', { 'README.md': 'two\n' })
        // A tag named as the branch never stands for it.
        git(checkout, 'tag', branch, 'main')

        const client = yield* clientFor(checkout)
        const diff = yield* client['diff.ticket']({ project, ticket })

        expect(diff.base).toBe(first)
        expect(diff.head).toBe(head)
        const byPath = new Map(diff.files.map(file => [file.path, file]))
        expect([...byPath.keys()].sort()).toEqual([
          'gone.txt',
          'src/a.ts',
          'src/b.ts',
          'src/new.ts',
        ])
        expect(byPath.get('src/a.ts')?.change).toBe('modified')
        expect(byPath.get('src/a.ts')?.patch).toContain(
          '-export const a = 1\n+export const a = 2\n',
        )
        expect(byPath.get('src/a.ts')?.patch).toMatch(
          /^diff --git a\/src\/a\.ts b\/src\/a\.ts\n/u,
        )
        expect(byPath.get('src/b.ts')?.change).toBe('added')
        expect(byPath.get('gone.txt')?.change).toBe('deleted')
        expect(byPath.get('gone.txt')?.patch).toContain('-gone\n')
        expect(byPath.get('src/new.ts')?.change).toBe('renamed')
        expect(byPath.get('src/new.ts')?.from).toEqual(
          Option.some('src/old.ts'),
        )
        expect(byPath.get('src/a.ts')?.from).toEqual(Option.none())
        // Each patch is its own file's alone.
        for (const file of diff.files) {
          expect(file.patch.match(/^diff --git /gmu)).toHaveLength(1)
        }
      }),
  )

  it.effect(
    "never runs the repository's external diff or text conversion",
    () =>
      Effect.gen(function* () {
        const { checkout } = repository()
        const marker = join(checkout, '..', `ran-${counter}`)
        const script = join(root, `external-${counter}.sh`)
        writeFileSync(script, `#!/bin/sh\n: > '${marker}'\ncat "$1"\n`, {
          mode: 0o755,
        })
        git(checkout, 'config', 'diff.external', script)
        git(checkout, 'config', 'diff.conv.textconv', script)
        commit(checkout, 'attributes', { '.gitattributes': '*.ts diff=conv\n' })
        git(checkout, 'switch', '--quiet', '--create', ticketBranch(ticket))
        commit(checkout, 'change', { 'src/a.ts': 'export const a = 3\n' })

        const client = yield* clientFor(checkout)
        const diff = yield* client['diff.ticket']({ project, ticket })

        expect(diff.files.map(file => file.path)).toEqual(['src/a.ts'])
        expect(diff.files[0]?.patch).toContain('+export const a = 3\n')
        expect(existsSync(marker)).toBe(false)
      }),
  )

  it.effect('answers NoBranch for a ticket with no branch', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const client = yield* clientFor(checkout)
      const error = yield* Effect.flip(
        client['diff.ticket']({ project, ticket }),
      )
      expect(error).toEqual(new NoBranch({ project, ticket }))
    }),
  )

  it.effect('answers ProjectNotFound for a project the engine lacks', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const client = yield* clientFor(checkout)
      const other = ProjectId.make('other')
      const error = yield* Effect.flip(
        client['diff.ticket']({ project: other, ticket }),
      )
      expect(error).toEqual(new ProjectNotFound({ project: other }))
    }),
  )
})

describe('diff.run', () => {
  it.effect(
    "diffs Base from the run's start to its last merge, its records alone",
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const one = commit(checkout, 'first merge', { 'src/a.ts': 'one\n' })
        const two = commit(checkout, 'second merge', { 'src/c.ts': 'c\n' })
        const later = commit(checkout, 'after the run', { 'late.txt': 'x\n' })
        const run = RunId.make('run-1')
        const other = RunId.make('run-2')
        writeEvents(checkout, [
          ...runRecords(run, first, [one, two]),
          ...runRecords(other, two, [later]),
        ])

        const client = yield* clientFor(checkout)
        const diff = yield* client['diff.run']({ project, run })

        expect(diff.base).toBe(first)
        expect(diff.head).toBe(two)
        expect(diff.files.map(file => [file.path, file.change])).toEqual([
          ['src/a.ts', 'modified'],
          ['src/c.ts', 'added'],
        ])
      }),
  )

  it.effect(
    'gives an empty diff at its start for a run that merged nothing',
    () =>
      Effect.gen(function* () {
        const { checkout, first } = repository()
        const run = RunId.make('run-1')
        writeEvents(checkout, runRecords(run, first, []))
        const client = yield* clientFor(checkout)
        const diff = yield* client['diff.run']({ project, run })
        expect(diff.base).toBe(first)
        expect(diff.head).toBe(first)
        expect(diff.files).toEqual([])
      }),
  )

  it.effect('answers RunNotFound for a run with no start record', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      writeEvents(checkout, runRecords(RunId.make('run-1'), first, []))
      const client = yield* clientFor(checkout)
      const run = RunId.make('run-9')
      const error = yield* Effect.flip(client['diff.run']({ project, run }))
      expect(error).toEqual(new RunNotFound({ project, run }))
    }),
  )
})

describe('report.get', () => {
  /** A checkout whose stream has runs `run-1` then `run-2`, and `run-1`'s report. */
  const withReports = () => {
    const { checkout, first } = repository()
    writeEvents(checkout, [
      ...runRecords(RunId.make('run-1'), first, []),
      ...runRecords(RunId.make('run-2'), first, []),
    ])
    const report = join(checkout, reportPath(RunId.make('run-1')))
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, '# Run 1\n\nAll merged.\n')
    return { checkout, report }
  }

  it.effect("reads a named run's report, with when it was written", () =>
    Effect.gen(function* () {
      const { checkout, report } = withReports()
      const client = yield* clientFor(checkout)
      const run = RunId.make('run-1')
      const got = yield* client['report.get']({
        project,
        run: Option.some(run),
      })
      expect(got.run).toBe(run)
      expect(got.markdown).toBe('# Run 1\n\nAll merged.\n')
      expect(DateTime.toEpochMillis(got.writtenAt)).toBe(
        Math.floor(statSync(report).mtimeMs),
      )
    }),
  )

  it.effect("reads the last run's report when none is named", () =>
    Effect.gen(function* () {
      const { checkout } = withReports()
      const last = join(checkout, reportPath(RunId.make('run-2')))
      writeFileSync(last, '# Run 2\n')
      const client = yield* clientFor(checkout)
      const got = yield* client['report.get']({ project, run: Option.none() })
      expect(got.run).toBe(RunId.make('run-2'))
      expect(got.markdown).toBe('# Run 2\n')
    }),
  )

  it.effect(
    'answers NoReport for a run with none yet, the last run included',
    () =>
      Effect.gen(function* () {
        const { checkout } = withReports()
        const client = yield* clientFor(checkout)
        const run = RunId.make('run-2')
        expect(
          yield* Effect.flip(
            client['report.get']({ project, run: Option.none() }),
          ),
        ).toEqual(new NoReport({ project, run }))
        expect(
          yield* Effect.flip(
            client['report.get']({ project, run: Option.some(run) }),
          ),
        ).toEqual(new NoReport({ project, run }))
      }),
  )

  it.effect('answers RunNotFound for a run the stream never started', () =>
    Effect.gen(function* () {
      const { checkout } = withReports()
      const client = yield* clientFor(checkout)
      const run = RunId.make('run-9')
      expect(
        yield* Effect.flip(
          client['report.get']({ project, run: Option.some(run) }),
        ),
      ).toEqual(new RunNotFound({ project, run }))
    }),
  )

  it.effect('answers NoRun for a project that has never run', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const client = yield* clientFor(checkout)
      expect(
        yield* Effect.flip(
          client['report.get']({ project, run: Option.none() }),
        ),
      ).toEqual(new NoRun({ project }))
    }),
  )

  it.effect('refuses a report that is a symbolic link', () =>
    Effect.gen(function* () {
      const { checkout } = withReports()
      const secret = join(root, `secret-${counter}.md`)
      writeFileSync(secret, 'a secret\n')
      symlinkSync(secret, join(checkout, reportPath(RunId.make('run-2'))))
      const client = yield* clientFor(checkout)
      const exit = yield* Effect.exit(
        client['report.get']({
          project,
          run: Option.some(RunId.make('run-2')),
        }),
      )
      expect(isRefused(exit)).toBe(true)
      expect(JSON.stringify(exit)).not.toContain('a secret')
    }),
  )

  it.effect('refuses a reports folder that is a symbolic link', () =>
    Effect.gen(function* () {
      const { checkout, first } = repository()
      writeEvents(checkout, runRecords(RunId.make('run-1'), first, []))
      const elsewhere = join(root, `elsewhere-${counter}`)
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'run-1.md'), 'a secret\n')
      symlinkSync(elsewhere, join(checkout, '.fabrica', 'reports'))
      const client = yield* clientFor(checkout)
      const exit = yield* Effect.exit(
        client['report.get']({ project, run: Option.none() }),
      )
      expect(isRefused(exit)).toBe(true)
    }),
  )
})

describe('log.tail', () => {
  /** A checkout whose human log holds `text`. */
  const withLog = (text: string) => {
    const { checkout } = repository()
    mkdirSync(dirname(join(checkout, logPath)), { recursive: true })
    writeFileSync(join(checkout, logPath), text)
    return checkout
  }

  it.effect("gives the log's last lines, oldest first", () =>
    Effect.gen(function* () {
      const client = yield* clientFor(withLog('one\ntwo\nthree\nfour\n'))
      expect(yield* client['log.tail']({ project, lines: 2 })).toEqual({
        lines: ['three', 'four'],
      })
      expect(yield* client['log.tail']({ project, lines: 10 })).toEqual({
        lines: ['one', 'two', 'three', 'four'],
      })
    }),
  )

  it.effect('counts a last line still being written', () =>
    Effect.gen(function* () {
      const client = yield* clientFor(withLog('one\ntwo\nthr'))
      expect(yield* client['log.tail']({ project, lines: 2 })).toEqual({
        lines: ['two', 'thr'],
      })
    }),
  )

  it.effect('reads a long log from its end, across its blocks', () =>
    Effect.gen(function* () {
      const lines = Array.from(
        { length: 20_000 },
        (_, index) => `10:15:00 line ${index} ${'é'.repeat(index % 7)}`,
      )
      const client = yield* clientFor(withLog(`${lines.join('\n')}\n`))
      expect(
        (yield* client['log.tail']({ project, lines: 5000 })).lines,
      ).toEqual(lines.slice(-5000))
      expect(
        (yield* client['log.tail']({ project, lines: 30_000 })).lines,
      ).toEqual(lines)
    }),
  )

  it.effect('gives no lines for a project with no log', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const client = yield* clientFor(checkout)
      expect(yield* client['log.tail']({ project, lines: 5 })).toEqual({
        lines: [],
      })
    }),
  )

  it.effect('refuses a log that is a symbolic link', () =>
    Effect.gen(function* () {
      const { checkout } = repository()
      const secret = join(root, `secret-log-${counter}`)
      writeFileSync(secret, 'a secret\n')
      mkdirSync(join(checkout, '.fabrica'))
      symlinkSync(secret, join(checkout, logPath))
      const client = yield* clientFor(checkout)
      const exit = yield* Effect.exit(client['log.tail']({ project, lines: 5 }))
      expect(isRefused(exit)).toBe(true)
    }),
  )
})
