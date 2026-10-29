import { Effect, Exit, Schema } from 'effect'
import { writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { expect, layer } from '@effect/vitest'
import { Imported, TicketDetail } from '@fabrica/contracts'
import { layerToolbox, tempFolder } from '@fabrica/testkit'

import { onlyJson, testEngine } from './tickets-engine'

// `fabrica tickets import --beads <file>` (spec §11.6, §19): a `bd export` file brought into the test
// engine's project, in text and with `--json`; imported again, it changes nothing.

const record = (
  id: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _type: 'issue',
  id,
  title: `Ticket ${id}`,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  created_at: '2026-10-20T09:00:00Z',
  updated_at: '2026-10-20T10:00:00Z',
  ...fields,
})

const beads = [
  record('bd-epic', { issue_type: 'epic' }),
  record('bd-epic.1', {
    dependencies: [
      { issue_id: 'bd-epic.1', depends_on_id: 'bd-epic', type: 'parent-child' },
      { issue_id: 'bd-epic.1', depends_on_id: 'bd-ask', type: 'blocks' },
      { issue_id: 'bd-epic.1', depends_on_id: 'bd-epic', type: 'waits-for' },
    ],
  }),
  record('bd-ask', {
    title: 'Which store?',
    labels: ['human'],
    metadata: {
      options: [
        { label: 'SQLite', description: 'In process; one writer.' },
        { label: 'Postgres', description: 'A server to run.' },
      ],
      recommended: 0,
    },
  }),
  { _type: 'memory', key: 'build', value: 'pnpm build' },
]
  .map(each => JSON.stringify(each))
  .join('\n')

/** A file in a temporary folder of the test's scope, holding `text`. */
const fileHolding = (text: string) =>
  Effect.gen(function* () {
    const folder = yield* tempFolder('tickets-import')
    const path = NodePath.join(folder, 'issues.jsonl')
    yield* Effect.promise(() => writeFile(path, text))
    return path
  })

// The engine runs on the live clock: its sockets and its git's time limits are real.
layer(layerToolbox({ tools: ['git'] }), { excludeTestServices: true })(
  'fabrica tickets import',
  it => {
    it.effect(
      'imports a Beads file, a human ticket as a question; again, it changes nothing',
      () =>
        Effect.gen(function* () {
          const { tickets } = yield* testEngine
          const file = yield* fileHolding(beads)

          const imported = yield* tickets('import', '--beads', file)
          expect(imported.exit).toStrictEqual(Exit.void)
          expect(imported.out).toStrictEqual([
            [
              '3 created, 0 merged',
              "left out: bd-epic.1's waits-for link to bd-epic: the work graph has no such link",
            ].join('\n'),
          ])

          const question = Schema.decodeUnknownSync(TicketDetail)(
            onlyJson((yield* tickets('show', 'bd-ask', '--json')).out),
          )
          expect(question.ticket.type).toBe('question')
          const child = Schema.decodeUnknownSync(TicketDetail)(
            onlyJson((yield* tickets('show', 'bd-epic.1', '--json')).out),
          )
          expect(
            child.edges.map(({ from, to, kind }) => [from, kind, to]),
          ).toStrictEqual([
            ['bd-ask', 'blocks', 'bd-epic.1'],
            ['bd-epic', 'parent', 'bd-epic.1'],
          ])

          const again = yield* tickets('import', '--beads', file, '--json')
          expect(again.exit).toStrictEqual(Exit.void)
          const answer = Schema.decodeUnknownSync(Imported)(onlyJson(again.out))
          expect(answer.created).toBe(0)
          expect(answer.merged).toBe(3)
          expect(answer.changed).toStrictEqual([])
        }).pipe(Effect.scoped),
    )

    it.effect('refuses a file it can’t read, with every problem', () =>
      Effect.gen(function* () {
        const { tickets } = yield* testEngine
        const file = yield* fileHolding(
          ['{not json', JSON.stringify(record('BD_1'))].join('\n'),
        )
        const refused = yield* tickets('import', '--beads', file)
        expect(Exit.isFailure(refused.exit)).toBe(true)
        expect(refused.err.join('\n')).toMatch(
          /^fabrica: the Beads file was refused:\n- line 1: not JSON\n- line 2: BD_1: its ID isn't a ticket ID/u,
        )
        const listed = yield* tickets('list', '--json')
        expect(onlyJson(listed.out)).toStrictEqual([])
      }).pipe(Effect.scoped),
    )
  },
)
