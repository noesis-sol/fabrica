import { Effect, Exit, Option, Schema } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  AddNote,
  AnswerToolName,
  AskAndWait,
  AskQuestion,
  Awaited,
  Defer,
  FileTicket,
  Finish,
  GetTicket,
  type Tool,
  ToolRefusal,
  VerdictTool,
  WaitFor,
  WorkerTools,
  answerTool,
  decodeArguments,
  finishFor,
} from './tools'

const tree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const commit = 'eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'

/** A tool whose arguments decode with no services, as every tool here does. */
type Decodes = Tool<
  Schema.Struct<Schema.Struct.Fields> & { readonly DecodingServices: never },
  Schema.Top
>

const accepts = (tool: Decodes, input: unknown) => decodeArguments(tool)(input)

const refuses = (tool: Decodes, input: unknown) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decodeArguments(tool)(input))
    expect(Exit.isFailure(exit)).toBe(true)
  })

const followUp = {
  title: 'Retry a refused fast-forward once',
  description:
    'The merge queue gives up on the first refusal; a lock held by another git process clears in a moment.',
  type: 'task',
  files: ['packages/engine/src/merge/queue.ts'],
  link: 'blocks',
}

const choices = (count: number, recommended: number) => ({
  options: Array.from({ length: count }, (_, index) => ({
    label: `Option ${index + 1}`,
    tradeOff: `What option ${index + 1} costs`,
  })),
  recommended,
})

const question = {
  title: 'Keep the tickets ref out of git hooks?',
  description:
    'Writing refs/fabrica/tickets runs the project hooks. Options: skip them, or run them. Recommended: skip.',
  choices: choices(2, 0),
  consequential: false,
  maintainerOnly: false,
}

const checkOwn = { tree, commit, output: '.fabrica/run/check-own.log' }

const finish = {
  checkOwn,
  result: { _tag: 'summary', summary: 'Added the worker tool payloads.' },
}

describe('get_ticket', () => {
  it.effect('reads the worker’s own ticket when given no ID', () =>
    Effect.gen(function* () {
      const { id } = yield* decodeArguments(GetTicket)({})
      expect(Option.isNone(id)).toBe(true)
    }),
  )

  it.effect('reads a linked ticket by its ID', () =>
    Effect.gen(function* () {
      const { id } = yield* decodeArguments(GetTicket)({ id: 'fab-mgi.3.1' })
      expect(id).toEqual(Option.some('fab-mgi.3.1'))
    }),
  )

  it.effect('refuses an ID that isn’t one, and keys it doesn’t name', () =>
    Effect.gen(function* () {
      yield* refuses(GetTicket, { id: 'not an id' })
      yield* refuses(GetTicket, { ticket: 'fab-mgi.3.1' })
    }),
  )
})

describe('file_ticket', () => {
  it.effect('files a follow-up with its files and link', () =>
    Effect.gen(function* () {
      const filed = yield* decodeArguments(FileTicket)(followUp)
      expect(filed.files).toEqual(['packages/engine/src/merge/queue.ts'])
      expect(filed.link).toBe('blocks')
      expect(Option.isNone(filed.priority)).toBe(true)
      expect(Option.isNone(filed.labels)).toBe(true)
    }),
  )

  it.effect('takes unknown files, a priority and labels', () =>
    Effect.gen(function* () {
      const filed = yield* decodeArguments(FileTicket)({
        ...followUp,
        files: 'unknown',
        priority: 1,
        labels: ['solo'],
        link: 'discovered_from',
      })
      expect(filed.files).toBe('unknown')
      expect(filed.priority).toEqual(Option.some(1))
      expect(filed.labels).toEqual(Option.some(['solo']))
    }),
  )

  it.effect('refuses a title over 60 characters, or of two lines', () =>
    Effect.gen(function* () {
      yield* accepts(FileTicket, { ...followUp, title: 'x'.repeat(60) })
      yield* refuses(FileTicket, { ...followUp, title: 'x'.repeat(61) })
      yield* refuses(FileTicket, { ...followUp, title: 'Retry\nonce' })
      yield* refuses(FileTicket, { ...followUp, title: '   ' })
    }),
  )

  it.effect(
    'refuses files that are none, absolute or outside the repository',
    () =>
      Effect.gen(function* () {
        yield* refuses(FileTicket, { ...followUp, files: [] })
        yield* refuses(FileTicket, { ...followUp, files: ['/etc/hosts'] })
        yield* refuses(FileTicket, { ...followUp, files: ['../other/x.ts'] })
        yield* refuses(FileTicket, { ...followUp, files: ['src/../../x.ts'] })
        yield* refuses(FileTicket, { ...followUp, files: ['src/'] })
        yield* refuses(FileTicket, { ...followUp, files: 'none' })
        yield* refuses(FileTicket, { ...followUp, files: undefined })
        yield* accepts(FileTicket, { ...followUp, files: ['src/..x/a.ts'] })
      }),
  )

  it.effect('refuses a description restating the title', () =>
    Effect.gen(function* () {
      yield* refuses(FileTicket, {
        ...followUp,
        description:
          'Retry a refused fast-forward once. The merge queue gives up on the first refusal.',
      })
      yield* refuses(FileTicket, {
        ...followUp,
        description:
          'retry a refused FAST-FORWARD once: because a lock clears.',
      })
    }),
  )

  it.effect('refuses a type, priority or link a worker doesn’t file', () =>
    Effect.gen(function* () {
      yield* refuses(FileTicket, { ...followUp, type: 'epic' })
      yield* refuses(FileTicket, { ...followUp, type: 'question' })
      yield* refuses(FileTicket, { ...followUp, priority: 5 })
      yield* refuses(FileTicket, { ...followUp, link: 'parent' })
      yield* refuses(FileTicket, { ...followUp, labels: ['two words'] })
    }),
  )
})

describe('ask_question and ask_and_wait', () => {
  it.effect('asks about the worker’s own ticket or another one', () =>
    Effect.gen(function* () {
      const own = yield* decodeArguments(AskQuestion)(question)
      expect(Option.isNone(own.blocks)).toBe(true)
      expect(own.choices.options).toHaveLength(2)
      const other = yield* decodeArguments(AskAndWait)({
        ...question,
        choices: choices(4, 3),
        consequential: true,
        maintainerOnly: true,
        blocks: 'fab-mgi.3.20',
      })
      expect(other.blocks).toEqual(Option.some('fab-mgi.3.20'))
      expect(other.maintainerOnly).toBe(true)
      expect(other.consequential).toBe(true)
    }),
  )

  it.effect('refuses 1 or 5 options, and a recommendation not among them', () =>
    Effect.gen(function* () {
      for (const tool of [AskQuestion, AskAndWait]) {
        yield* refuses(tool, { ...question, choices: choices(1, 0) })
        yield* refuses(tool, { ...question, choices: choices(5, 0) })
        yield* refuses(tool, { ...question, choices: choices(3, 3) })
        yield* refuses(tool, { ...question, choices: choices(3, -1) })
      }
    }),
  )

  it.effect('refuses a question without its flags or options', () =>
    Effect.gen(function* () {
      const { maintainerOnly: _, ...unflagged } = question
      yield* refuses(AskQuestion, unflagged)
      const { choices: __, ...unchosen } = question
      yield* refuses(AskQuestion, unchosen)
      yield* refuses(AskQuestion, { ...question, title: 'x'.repeat(61) })
    }),
  )

  it.effect('ask_and_wait ends with the answer, or none in time', () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Awaited)
      const answered = yield* decode({
        _tag: 'answered',
        question: 'fab-q1x2',
        answer: 'Skip them',
      })
      expect(
        Awaited.match(answered, {
          answered: ({ answer }) => answer,
          unanswered: () => 'none',
        }),
      ).toBe('Skip them')
      const unanswered = yield* decode({
        _tag: 'unanswered',
        question: 'fab-q1x2',
      })
      expect(unanswered._tag).toBe('unanswered')
    }),
  )
})

describe('add_note, defer and wait_for', () => {
  it.effect('take their text and refuse it blank', () =>
    Effect.gen(function* () {
      yield* accepts(AddNote, { body: 'Kept the test next to its module.' })
      yield* refuses(AddNote, { body: ' \n' })
      yield* accepts(Defer, { reason: 'The Pi spike has not merged.' })
      yield* refuses(Defer, { reason: '' })
      yield* refuses(Defer, {})
    }),
  )

  it.effect('wait_for names the ticket and what it needs from it', () =>
    Effect.gen(function* () {
      const waiting = yield* decodeArguments(WaitFor)({
        ticket: 'fab-mgi.3.9',
        needs: 'The SQLite store’s ticket CRUD.',
      })
      expect(waiting.ticket).toBe('fab-mgi.3.9')
      yield* refuses(WaitFor, { ticket: 'fab-mgi.3.9' })
      yield* refuses(WaitFor, { ticket: 'FAB', needs: 'x' })
    }),
  )
})

describe('finish', () => {
  it.effect('gives check_own’s pass and a result', () =>
    Effect.gen(function* () {
      const finished = yield* decodeArguments(Finish)(finish)
      expect(finished.checkOwn.tree).toBe(tree)
      expect(finished.checkOwn.commit).toBe(commit)
      expect(finished.result._tag).toBe('summary')
    }),
  )

  it.effect('refuses a pass without its tree, commit or output file', () =>
    Effect.gen(function* () {
      yield* refuses(Finish, { result: finish.result })
      yield* refuses(Finish, {
        ...finish,
        checkOwn: { ...checkOwn, tree: 'HEAD' },
      })
      yield* refuses(Finish, {
        ...finish,
        checkOwn: { ...checkOwn, commit: commit.slice(0, 7) },
      })
      yield* refuses(Finish, { ...finish, checkOwn: { tree, commit } })
      yield* refuses(Finish, {
        checkOwn,
        result: { _tag: 'summary', summary: '' },
      })
    }),
  )

  it.effect('for a ticket’s result_kind, takes that result alone', () =>
    Effect.gen(function* () {
      const migration = finishFor('migration_added')
      const result = {
        _tag: 'migration_added',
        summary: 'Added the notes table.',
        migration: '0002_notes',
      }
      const finished = yield* decodeArguments(migration)({ checkOwn, result })
      expect(finished.result).toEqual(result)
      yield* refuses(migration, finish)
      yield* accepts(finishFor('summary'), finish)
      yield* refuses(finishFor('summary'), { checkOwn, result })
      yield* accepts(Finish, { checkOwn, result })
    }),
  )
})

describe('verdict', () => {
  const finding = (blocking: boolean) => ({
    gap: 'tools.test.ts has no case for an absolute path.',
    blocking,
  })

  it.effect('PASS has only optional findings', () =>
    Effect.gen(function* () {
      const { verdict } = yield* decodeArguments(VerdictTool)({
        verdict: {
          _tag: 'PASS',
          summary: 'Meets the ticket.',
          findings: [finding(false)],
        },
      })
      expect(verdict._tag).toBe('PASS')
      yield* refuses(VerdictTool, {
        verdict: {
          _tag: 'PASS',
          summary: 'Meets it.',
          findings: [finding(true)],
        },
      })
    }),
  )

  it.effect('FAIL has at least one blocking finding', () =>
    Effect.gen(function* () {
      const { verdict } = yield* decodeArguments(VerdictTool)({
        verdict: {
          _tag: 'FAIL',
          summary: 'One gap.',
          findings: [
            { ...finding(true), disagreesWithRound: 1 },
            finding(false),
          ],
        },
      })
      expect(verdict.findings[0]?.disagreesWithRound).toEqual(Option.some(1))
      yield* refuses(VerdictTool, {
        verdict: { _tag: 'FAIL', summary: 'None.', findings: [] },
      })
      yield* refuses(VerdictTool, {
        verdict: { _tag: 'FAIL', summary: 'None.', findings: [finding(false)] },
      })
      yield* refuses(VerdictTool, {
        verdict: {
          _tag: 'FAIL',
          summary: 'Round 0.',
          findings: [{ ...finding(true), disagreesWithRound: 0 }],
        },
      })
      yield* refuses(VerdictTool, {
        verdict: { _tag: 'MAYBE', summary: 'Hm.' },
      })
    }),
  )
})

describe('the organs’ answer tool', () => {
  const predictor = answerTool({
    answer: Schema.Array(Schema.String),
    description: 'The files the ticket will likely change.',
  })

  it.effect('wraps the organ’s answer in an envelope', () =>
    Effect.gen(function* () {
      expect(predictor.name).toBe(AnswerToolName)
      const { answer } = yield* decodeArguments(predictor)({
        answer: ['packages/engine/src/run/loop.ts'],
      })
      expect(answer).toEqual(['packages/engine/src/run/loop.ts'])
      yield* refuses(predictor, ['packages/engine/src/run/loop.ts'])
      yield* refuses(predictor, { answer: 'loop.ts' })
    }),
  )
})

describe('the tools', () => {
  it('have names of their own', () => {
    const names = WorkerTools.map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual([
      'get_ticket',
      'file_ticket',
      'ask_question',
      'add_note',
      'finish',
      'defer',
      'wait_for',
      'ask_and_wait',
    ])
  })

  it.effect('refusals round-trip, naming what was refused', () =>
    Effect.gen(function* () {
      const dirty = {
        _tag: 'worktree_dirty',
        uncommitted: ['packages/contracts/src/tools.ts'],
        untracked: ['scratch.txt'],
      }
      const refusal = yield* Schema.decodeUnknownEffect(ToolRefusal)(dirty)
      expect(yield* Schema.encodeEffect(ToolRefusal)(refusal)).toEqual(dirty)
      yield* Schema.decodeUnknownEffect(ToolRefusal)({
        _tag: 'wrong_result_kind',
        expected: 'migration_added',
        given: 'summary',
      })
      const exit = yield* Effect.exit(
        Schema.decodeUnknownEffect(ToolRefusal)({
          _tag: 'wrong_result_kind',
          expected: 'migration',
          given: 'summary',
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
