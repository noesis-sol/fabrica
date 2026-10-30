import { Effect, Option, Schema } from 'effect'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import { ProjectId, type TicketId } from '@fabrica/contracts'

import { sessionFolder } from '../src/agent'
import {
  type Project,
  binFolder,
  file,
  ofKind,
  project,
  runOf,
  setUpRuns,
  settings,
} from './run-harness'

// The run's workers take the merge queue's hand-backs (spec §13.7): a merge check failing in a ticket's
// own code goes back to its worker, its session resumed with the hand-back's prompt, and the fix it
// commits is checked once more and merges.

beforeAll(setUpRuns)

const StubEntry = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    message: Schema.optionalKey(Schema.String),
    session: Schema.optionalKey(Schema.String),
  }),
)

/** The ticket's stub's log: every session's prompts and resumes, oldest first. */
const stubLog = (fixture: Project, ticket: TicketId) => {
  const log = join(
    sessionFolder({
      data: fixture.data,
      project: ProjectId.make('p1'),
      ticket,
    }),
    'stub.jsonl',
  )
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => Schema.decodeUnknownSync(StubEntry)(line))
}

describe("a run's hand-backs", () => {
  it.effect(
    "gives a merge check failing in the ticket's own code to its resumed worker, whose fix merges",
    () =>
      Effect.gen(function* () {
        // The merge check fails while broken.txt has one line: the worker's first go writes one, its
        // resumed session a second.
        const check = join(binFolder(), 'check-broken')
        writeFileSync(
          check,
          '#!/bin/sh\nif [ -f broken.txt ] && [ "$(wc -l < broken.txt)" -lt 2 ]; then echo "error: broken.txt has one line"; exit 1; fi\necho passing\n',
        )
        chmodSync(check, 0o755)
        const fixture = project({ ...settings, check_fast: check })
        const { end, events, ticketOf, made } = yield* runOf(
          fixture,
          file('Mend it', 'finish broken.txt'),
        )
        const id = made.id
        expect(end).toEqual({ kind: 'READY_EMPTY', code: 0 })
        expect(
          ofKind(events, 'warn').filter(({ text }) => text.includes('FIXING')),
        ).toEqual([
          expect.objectContaining({
            ticket: id,
            text: expect.stringContaining(
              `${id} handed back to its worker (first)`,
            ),
          }),
        ])
        const log = stubLog(fixture, id)
        const resumed = log.filter(entry => entry.event === 'resumed')
        expect(resumed).toHaveLength(1)
        const prompts = log.flatMap(entry =>
          entry.event === 'prompt' && entry.message !== undefined
            ? [entry.message]
            : [],
        )
        expect(prompts).toHaveLength(2)
        expect(prompts[1]).toContain('broken.txt has one line')
        expect(
          ofKind(events, 'ticket_end').map(({ outcome }) => outcome),
        ).toEqual(['merged'])
        const ticket = ticketOf(id)
        expect(ticket.status).toBe('closed')
        expect(Option.isSome(ticket.mergedCommit)).toBe(true)
        expect(readFileSync(join(fixture.checkout, 'broken.txt'), 'utf8')).toBe(
          'Mend it\nMend it\n',
        )
      }),
  )
})
