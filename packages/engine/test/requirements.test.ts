import { Duration, Effect, Fiber, Layer, PubSub, Schema } from 'effect'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  Edge,
  Requires,
  type RunEvent,
  type TicketId,
} from '@fabrica/contracts'

import { layer as gitLayer } from '../src/git'
import { layer as runnerLayer } from '../src/process'
import {
  RequirementsList,
  RequirementsPlatform,
  checkRequirements,
  foundWords,
  missingItems,
  requirementLogPath,
  requirementWords,
  requirementsAt,
  requirementsMarkdown,
  requirementsSectionEnd,
  requirementsSectionStart,
  sameRequirements,
} from '../src/requirements'
import { makeRunControl, runProject } from '../src/run'
import { RunLog } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  type Project,
  commit,
  configOf,
  eventsOf,
  file,
  git,
  gitConfig,
  liveDeadlines,
  ofKind,
  options,
  project,
  runOf,
  runnerConfig,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// The requires list (spec §17): each entry's check run in the project's checkout, an install run where
// it fails and the check run again; a run stops before its first ticket for what is still missing, with
// one list, `REQUIREMENTS_MISSING`, exit 2, and takes a merge's change of the list before its next
// ticket. The engine runs Base's list alone: a branch's entry is never run. Commands are real shell
// commands whose work a test sees in a marker file.

beforeAll(setUpRuns)

const decodeList = Schema.decodeUnknownSync(Requires)

/** The list in a project's settings file: each entry as it is written there. */
const listed = (...entries: ReadonlyArray<object>) => decodeList(entries)

const withSettings = (requires: ReadonlyArray<object>) => ({
  ...settings,
  requires,
})

const services = Layer.provideMerge(
  gitLayer(gitConfig),
  Layer.provideMerge(
    Layer.suspend(() => runnerLayer(runnerConfig())),
    liveDeadlines,
  ),
)

/** A check that passes once `marker` is there. */
const hasMarker = (marker: string) => `test -f ${marker}`

const checkIn = (
  fixture: Project,
  list: ReadonlyArray<object>,
  installLimit = Duration.minutes(1),
) =>
  checkRequirements({
    list: listed(...list),
    checkout: fixture.checkout,
    installLimit,
  }).pipe(Effect.provide(services))

describe('checkRequirements', () => {
  it.effect('says a met entry met, its install not run', () =>
    Effect.gen(function* () {
      const fixture = project()
      const found = yield* checkIn(fixture, [
        { name: 'sh', check: 'true', install: 'touch installed' },
      ])
      expect(found.map(({ name, state }) => [name, state._tag])).toEqual([
        ['sh', 'met'],
      ])
      expect(existsSync(join(fixture.checkout, 'installed'))).toBe(false)
    }),
  )

  it.effect(
    'runs a failing check’s install, and the check again: its output kept in its log',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const found = yield* checkIn(fixture, [
          {
            name: 'tool',
            check: hasMarker('tool'),
            install: 'echo putting it there; echo to stderr >&2; touch tool',
          },
        ])
        expect(found[0]?.state).toMatchObject({
          _tag: 'installed',
          command: 'echo putting it there; echo to stderr >&2; touch tool',
        })
        expect(
          readFileSync(
            join(fixture.checkout, requirementLogPath('tool')),
            'utf8',
          ),
        ).toBe('putting it there\nto stderr\n')
      }),
  )

  it.effect(
    'says an install that fails, and one that leaves the check failing, each with where its output is',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const found = yield* checkIn(fixture, [
          { name: 'broken', check: 'false', install: 'exit 3' },
          { name: 'useless', check: 'false', install: 'true' },
        ])
        const log = join(fixture.checkout, requirementLogPath('broken'))
        expect(missingItems(found)).toEqual([
          `broken (\`exit 3\` exited 3; its output is in ${log})`,
          `useless (\`true\` ran, but \`false\` still fails; its output is in ${log.replace('broken', 'useless')})`,
        ])
      }),
  )

  it.effect(
    'gives a manual entry’s instruction, and runs no command for it',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const found = yield* checkIn(fixture, [
          { name: 'docker', check: 'false', manual: 'start Docker Desktop' },
        ])
        expect(missingItems(found)).toEqual(['docker (start Docker Desktop)'])
      }),
  )

  it.effect('checks an entry only on the platforms it names', () =>
    Effect.gen(function* () {
      const fixture = project()
      const found = yield* checkIn(fixture, [
        {
          name: 'here',
          check: 'true',
          manual: 'nothing to do',
          platforms: ['linux'],
        },
        {
          name: 'elsewhere',
          check: 'touch checked; false',
          install: 'touch installed',
          platforms: ['darwin', 'win32'],
        },
      ]).pipe(Effect.provideService(RequirementsPlatform, 'linux'))
      expect(found.map(({ name, state }) => [name, state._tag])).toEqual([
        ['here', 'met'],
        ['elsewhere', 'other_platform'],
      ])
      expect(existsSync(join(fixture.checkout, 'checked'))).toBe(false)
      expect(existsSync(join(fixture.checkout, 'installed'))).toBe(false)
      expect(foundWords(found)).toBe(
        'here met; elsewhere not for this platform',
      )
    }),
  )
})

describe('requirementsAt', () => {
  it.effect(
    'reads the list committed at a revision, never the checkout’s file',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          withSettings([{ name: 'on-main', check: 'true', manual: 'do it' }]),
        )
        git(fixture.checkout, 'checkout', '--quiet', '-b', 'feature')
        commit(fixture.checkout, 'a branch’s entry', {
          '.fabrica/settings.json': JSON.stringify(
            withSettings([
              { name: 'on-branch', check: 'true', manual: 'do it' },
            ]),
          ),
        })
        writeFileSync(
          join(fixture.checkout, '.fabrica/settings.json'),
          JSON.stringify(
            withSettings([
              { name: 'uncommitted', check: 'true', manual: 'do it' },
            ]),
          ),
        )
        const namesAt = (revision: string) =>
          requirementsAt({ repo: fixture.checkout, revision }).pipe(
            Effect.map(read =>
              RequirementsList.$is('Listed')(read)
                ? read.list.map(({ name }) => name)
                : [read.reason],
            ),
            Effect.provide(services),
          )
        expect(yield* namesAt('refs/heads/main')).toEqual(['on-main'])
        expect(yield* namesAt('refs/heads/feature')).toEqual(['on-branch'])
      }),
  )

  it.effect(
    'takes a commit without a settings file for an empty list, and says what it can’t read',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const readAt = (revision: string) =>
          requirementsAt({ repo: fixture.checkout, revision }).pipe(
            Effect.provide(services),
          )
        git(fixture.checkout, 'rm', '--quiet', '.fabrica/settings.json')
        git(fixture.checkout, 'commit', '--quiet', '--message', 'none')
        expect(yield* readAt('HEAD')).toEqual(
          RequirementsList.Listed({ list: [] }),
        )
        commit(fixture.checkout, 'broken', {
          '.fabrica/settings.json': 'not json',
        })
        expect(RequirementsList.$is('Unreadable')(yield* readAt('HEAD'))).toBe(
          true,
        )
        commit(fixture.checkout, 'with sudo', {
          '.fabrica/settings.json': JSON.stringify({
            requires: [{ name: 'tool', check: 'false', install: 'sudo make' }],
          }),
        })
        const refused = yield* readAt('HEAD')
        expect(
          RequirementsList.$is('Unreadable')(refused) && refused.reason,
        ).toContain('sudo')
      }),
  )
})

describe('the list’s words', () => {
  const entry = {
    name: 'jq',
    check: 'command -v jq',
    install: 'brew install jq',
  }

  it('tells a list that changed from one that didn’t', () => {
    const list = listed(entry, { name: 'b', check: 'true', manual: 'do' })
    expect(sameRequirements(list, list.toReversed())).toBe(true)
    expect(sameRequirements(list, list.slice(1))).toBe(false)
    expect(
      sameRequirements(
        listed(entry),
        listed({ ...entry, install: 'apt-get install jq' }),
      ),
    ).toBe(false)
    expect(
      sameRequirements(
        listed(entry),
        listed({ ...entry, platforms: ['linux'] }),
      ),
    ).toBe(false)
  })

  it('writes the README’s section between its markers', () => {
    const list = listed(
      { ...entry, platforms: ['darwin', 'linux'] },
      { name: 'docker', check: 'docker ps', manual: 'start\n  Docker Desktop' },
      { name: 'ticks', check: 'echo `date`', install: 'true' },
    )
    expect(requirementWords(list[0]!)).toBe(
      'command -v jq; install: brew install jq; on darwin, linux',
    )
    expect(requirementsMarkdown(list).split('\n')).toEqual([
      requirementsSectionStart,
      '<!-- Generated from "requires" in .fabrica/settings.json: change the list, then run fabrica requires --markdown. -->',
      '## What to install',
      '',
      'What this project needs of the machine, from `"requires"` in `.fabrica/settings.json`. `fabrica requires` checks each one and installs what it can.',
      '',
      '- **jq** (only on macOS, Linux)',
      '  - check: `command -v jq`',
      '  - install: `brew install jq`',
      '- **docker**',
      '  - check: `docker ps`',
      '  - by hand: start Docker Desktop',
      '- **ticks**',
      '  - check: `` echo `date` ``',
      '  - install: `true`',
      requirementsSectionEnd,
    ])
    expect(requirementsMarkdown([])).toContain('Nothing yet')
  })
})

describe('a run’s start', () => {
  it.effect(
    'runs its tickets once an install meets the list, saying so',
    () => {
      const fixture = project(
        withSettings([
          { name: 'met', check: 'true', manual: 'never asked' },
          { name: 'tool', check: hasMarker('tool'), install: 'touch tool' },
        ]),
      )
      return Effect.gen(function* () {
        const { end, events } = yield* runOf(fixture, file('One', 'finish'))
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        const said = ofKind(events, 'info').map(({ text }) => text)
        expect(said).toContain(
          'start: the requirements check: installing tool: touch tool',
        )
        expect(said).toContain(
          'start: the requirements check: met met; tool installed',
        )
      })
    },
  )

  it.effect(
    'stops before its first ticket with exit 2 and one list, each entry with its instruction',
    () => {
      const fixture = project(
        withSettings([
          { name: 'docker', check: 'false', manual: 'start Docker Desktop' },
          { name: 'met', check: 'true', manual: 'never asked' },
          { name: 'license', check: 'false', manual: 'accept the licence' },
        ]),
      )
      return Effect.gen(function* () {
        const { end, events } = yield* runOf(fixture, file('One', 'finish'))
        expect(end).toEqual({ kind: 'REQUIREMENTS_MISSING', code: 2 })
        expect(ofKind(events, 'dispatch')).toEqual([])
        expect(
          ofKind(events, 'stop').map(({ detail, text }) => [detail, text]),
        ).toEqual([
          [
            'REQUIREMENTS_MISSING',
            'REQUIREMENTS_MISSING: docker (start Docker Desktop); license (accept the licence); meet them (each entry of `requires` in .fabrica/settings.json says how), then run again',
          ],
        ])
        expect(ofKind(events, 'end').map(({ code }) => code)).toEqual([2])
      })
    },
  )

  it.effect(
    'lists a missing entry with the other problems as a setup problem, exit 2',
    () => {
      const fixture = project({
        ...withSettings([
          { name: 'docker', check: 'false', manual: 'start Docker Desktop' },
        ]),
        model: undefined,
      })
      return Effect.gen(function* () {
        const control = yield* makeRunControl
        const end = yield* runProject(configOf(fixture, options()), control)
        expect(end).toEqual({ kind: 'SETUP', code: 2 })
        const warned = ofKind(yield* eventsOf(fixture), 'warn').map(
          ({ text }) => text,
        )
        expect(warned).toContain(
          'SETUP: a requirement is missing: docker (start Docker Desktop)',
        )
        expect(warned.some(text => text.includes('no model is set'))).toBe(true)
      }).pipe(self => withRuns(fixture, self))
    },
  )

  it.effect('runs no command of a list on a checkout it refuses', () => {
    const fixture = project(
      withSettings([
        {
          name: 'tool',
          check: 'touch checked; false',
          install: 'touch installed',
        },
      ]),
    )
    writeFileSync(join(fixture.checkout, 'README.md'), 'changed\n')
    return Effect.gen(function* () {
      const { end } = yield* runOf(fixture, Effect.void)
      expect(end).toEqual({ kind: 'SETUP', code: 2 })
      expect(existsSync(join(fixture.checkout, 'checked'))).toBe(false)
      expect(existsSync(join(fixture.checkout, 'installed'))).toBe(false)
    })
  })

  it.effect(
    'refuses a flag or a variable that would name other commands',
    () => {
      const fixture = project()
      return Effect.gen(function* () {
        const control = yield* makeRunControl
        const end = yield* runProject(
          {
            ...configOf(fixture, options()),
            settings: {
              flags: {},
              environment: {
                FABRICA_REQUIRES: JSON.stringify([
                  { name: 'tool', check: 'touch checked', manual: 'do it' },
                ]),
              },
              engineSettings: {},
            },
          },
          control,
        )
        expect(end).toEqual({ kind: 'SETUP', code: 2 })
        expect(existsSync(join(fixture.checkout, 'checked'))).toBe(false)
        const warned = ofKind(yield* eventsOf(fixture), 'warn').map(
          ({ text }) => text,
        )
        expect(warned.join('\n')).toContain(
          'requires is read from the settings on Base alone',
        )
      }).pipe(self => withRuns(fixture, self))
    },
  )
})

/** The first record `found` takes, from those `records` follows. */
const until = (
  records: PubSub.Subscription<RunEvent>,
  found: (event: RunEvent) => boolean,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(records)
      if (found(event)) return event
    }
  })

const isDispatchOf = (ticket: TicketId) => (event: RunEvent) =>
  event.kind === 'dispatch' && event.ticket === ticket

/** Starts a run in a fiber of its own, its records followed from before its start. */
const startRun = (fixture: Project) =>
  Effect.gen(function* () {
    const control = yield* makeRunControl
    const records = yield* (yield* RunLog).subscribe
    const running = yield* Effect.forkChild(
      runProject(configOf(fixture, options()), control),
    )
    return { control, records, running }
  })

/** Whether a record says an install of `name` starts. */
const isInstallOf = (name: string) => (event: RunEvent) =>
  event.kind === 'info' && event.text.includes(`: installing ${name}:`)

/** Two tickets' whole merges on a busy machine. */
const WHOLE_RUNS = 60_000

describe('a stop', () => {
  it.effect(
    'cuts a start’s install short, its command ended, and starts no further one',
    () => {
      const fixture = project(
        withSettings([
          {
            name: 'slow',
            check: 'false',
            install: 'sleep 60; touch slow-done',
          },
          { name: 'next', check: 'false', install: 'touch next-done' },
        ]),
      )
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const made = yield* file('One', 'finish')
          const { control, records, running } = yield* startRun(fixture)
          yield* until(records, isInstallOf('slow'))
          yield* control.stop
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'INTERRUPTED',
            code: 130,
          })
          expect(existsSync(join(fixture.checkout, 'slow-done'))).toBe(false)
          expect(existsSync(join(fixture.checkout, 'next-done'))).toBe(false)
          const events = yield* eventsOf(fixture)
          expect(events.some(isInstallOf('next'))).toBe(false)
          expect(events.some(isDispatchOf(made.id))).toBe(false)
        }),
      )
    },
    WHOLE_RUNS,
  )

  it.effect(
    'ends an install a merge’s list started, with the run',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const { first } = yield* chained(`wait ${go}`)
          const { control, records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first.id))
          commit(fixture.checkout, 'a slow tool', {
            '.fabrica/settings.json': JSON.stringify({
              ...settings,
              concurrent: 1,
              requires: [
                {
                  name: 'slow',
                  check: 'false',
                  install: 'sleep 60; touch slow-done',
                },
              ],
            }),
          })
          writeFileSync(go, '')
          yield* until(records, isInstallOf('slow'))
          yield* control.stop
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'INTERRUPTED',
            code: 130,
          })
          expect(existsSync(join(fixture.checkout, 'slow-done'))).toBe(false)
        }),
      )
    },
    WHOLE_RUNS,
  )
})

/** A first ticket whose stub does `script`, and a second only ready once the first has merged. */
const chained = (script: string) =>
  Effect.gen(function* () {
    const graph = yield* WorkGraph
    const first = yield* file('First', script)
    const second = yield* file('Second', 'finish')
    yield* graph.addDependency({
      edge: new Edge({ from: first.id, to: second.id, kind: 'blocks' }),
      actor: { _tag: 'maintainer' },
    })
    return { first, second }
  })

describe('a merge that changes the list on Base', () => {
  it.effect(
    'has it checked before the next ticket starts, and the run goes on once it is met',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const { first, second } = yield* chained(`wait ${go}`)
          const { records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first.id))
          // Base moves under the worker, as a merge that changed the list leaves it.
          commit(fixture.checkout, 'a new tool', {
            '.fabrica/settings.json': JSON.stringify({
              ...settings,
              concurrent: 1,
              requires: [
                {
                  name: 'tool',
                  check: hasMarker('tool'),
                  install: 'touch tool',
                },
              ],
            }),
          })
          writeFileSync(go, '')
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'READY_EMPTY',
            code: 0,
          })
          const events = yield* eventsOf(fixture)
          expect(existsSync(join(fixture.checkout, 'tool'))).toBe(true)
          // The change, the install and how it was found, and then the second ticket's dispatch.
          const lines = events.flatMap(event =>
            event.kind === 'info' && event.text.startsWith('requirements')
              ? [event.text]
              : isDispatchOf(second.id)(event)
                ? ['the second ticket']
                : [],
          )
          expect(lines).toEqual([
            'requirements: the list changed on main: checking it before the next ticket starts',
            'requirements: installing tool: touch tool',
            'requirements: tool installed',
            'the second ticket',
          ])
        }),
      )
    },
    WHOLE_RUNS,
  )

  it.effect(
    'stops the run REQUIREMENTS_MISSING, exit 2, once the running tickets finish, for what is still missing',
    () => {
      const fixture = project({ ...settings, concurrent: 1 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const { first } = yield* chained(`wait ${go}`)
          const { records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first.id))
          commit(fixture.checkout, 'a tool nobody has', {
            '.fabrica/settings.json': JSON.stringify({
              ...settings,
              concurrent: 1,
              requires: [
                {
                  name: 'docker',
                  check: 'false',
                  manual: 'start Docker Desktop',
                },
              ],
            }),
          })
          writeFileSync(go, '')
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'REQUIREMENTS_MISSING',
            code: 2,
          })
          const events = yield* eventsOf(fixture)
          expect(
            ofKind(events, 'dispatch').map(({ ticket }) => ticket),
          ).toEqual([first.id])
          expect(ofKind(events, 'closed').map(({ ticket }) => ticket)).toEqual([
            first.id,
          ])
          expect(ofKind(events, 'stop')[0]?.text).toBe(
            'REQUIREMENTS_MISSING: docker (start Docker Desktop); meet it (each entry of `requires` in .fabrica/settings.json says how), then run again',
          )
        }),
      )
    },
  )

  it.effect(
    'takes a list a merge the run didn’t make changed, before its next ticket starts',
    () => {
      const fixture = project({ ...settings, concurrent: 2 })
      const go = `${fixture.data}-go`
      return withRuns(
        fixture,
        Effect.gen(function* () {
          const first = yield* file('First', `wait ${go}`)
          const { records, running } = yield* startRun(fixture)
          yield* until(records, isDispatchOf(first.id))
          // The maintainer's merge: Base moves with no ticket of the run's in it.
          commit(fixture.checkout, 'a new tool', {
            '.fabrica/settings.json': JSON.stringify({
              ...settings,
              concurrent: 2,
              requires: [
                {
                  name: 'tool',
                  check: hasMarker('tool'),
                  install: 'touch tool',
                },
              ],
            }),
          })
          const second = yield* file('Second', 'finish')
          yield* until(records, isDispatchOf(second.id))
          expect(existsSync(join(fixture.checkout, 'tool'))).toBe(true)
          writeFileSync(go, '')
          expect(yield* Fiber.join(running)).toEqual({
            kind: 'READY_EMPTY',
            code: 0,
          })
        }),
      )
    },
    WHOLE_RUNS,
  )

  it.effect('runs none of a list a branch changed until it merges', () => {
    const fixture = project({ ...settings, concurrent: 1 })
    const go = `${fixture.data}-go`
    return withRuns(
      fixture,
      Effect.gen(function* () {
        git(fixture.checkout, 'branch', 'side')
        const first = yield* file('First', `wait ${go}`)
        const { records, running } = yield* startRun(fixture)
        yield* until(records, isDispatchOf(first.id))
        // A branch beside the run's changes the list; Base doesn't.
        const side = `${fixture.data}-side`
        git(fixture.checkout, 'worktree', 'add', '--quiet', side, 'side')
        commit(side, 'a branch’s entry', {
          '.fabrica/settings.json': JSON.stringify({
            ...settings,
            concurrent: 1,
            requires: [
              {
                name: 'tool',
                check: 'touch checked; false',
                install: 'touch installed',
              },
            ],
          }),
        })
        writeFileSync(go, '')
        expect(yield* Fiber.join(running)).toEqual({
          kind: 'READY_EMPTY',
          code: 0,
        })
        expect(existsSync(join(fixture.checkout, 'checked'))).toBe(false)
        expect(existsSync(join(fixture.checkout, 'installed'))).toBe(false)
        expect(existsSync(join(side, 'checked'))).toBe(false)
      }),
    )
  })
})
