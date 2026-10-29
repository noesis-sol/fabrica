import { Effect, Option } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import {
  type ByteSink,
  FileFailed,
  makeLineStream,
  openFileTruncating,
  openLineStream,
  readFileText,
  writeFileWhole,
} from '../src/files'

// The safe file writer and hostile-file reads (spec §20.2, §13.12, H62, H84), against real files in a
// temporary folder.

/** A temporary folder for one test, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(NodePath.join(tmpdir(), 'fabrica-files-'))),
  folder => Effect.promise(() => rm(folder, { recursive: true, force: true })),
)

const read = (path: string) => Effect.promise(() => readFile(path, 'utf8'))

/** Makes a named pipe at `path`, with mkfifo named by its full path and an empty environment. */
const makeFifo = (path: string) =>
  Effect.sync(() => execFileSync('/usr/bin/mkfifo', [path], { env: {} }))

describe('writeFileWhole', () => {
  it.effect('writes the file and its folders, leaving no temporary file', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      yield* writeFileWhole(
        { root, path: '.fabrica/settings.json' },
        '{"a":1}\n',
      )
      yield* writeFileWhole(
        { root, path: '.fabrica/settings.json' },
        '{"a":2}\n',
      )
      expect(yield* read(NodePath.join(root, '.fabrica/settings.json'))).toBe(
        '{"a":2}\n',
      )
      expect(
        yield* Effect.promise(() => readdir(NodePath.join(root, '.fabrica'))),
      ).toEqual(['settings.json'])
    }),
  )

  it.effect(
    'replaces a symbolic link at the target, not writing through it',
    () =>
      Effect.gen(function* () {
        const root = yield* scratch
        const outside = NodePath.join(root, 'outside.txt')
        yield* Effect.promise(() => writeFile(outside, 'kept'))
        yield* Effect.promise(() => mkdir(NodePath.join(root, 'run')))
        yield* Effect.promise(() =>
          symlink(outside, NodePath.join(root, 'run/state.json')),
        )
        yield* writeFileWhole({ root, path: 'run/state.json' }, 'new')
        expect(yield* read(outside)).toBe('kept')
        const target = yield* Effect.promise(() =>
          lstat(NodePath.join(root, 'run/state.json')),
        )
        expect(target.isFile()).toBe(true)
        expect(yield* read(NodePath.join(root, 'run/state.json'))).toBe('new')
      }),
  )

  it.effect('leaves a file hard-linked to the target intact', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const config = NodePath.join(root, 'config')
      yield* Effect.promise(() => writeFile(config, '[core]\n'))
      yield* Effect.promise(() => link(config, NodePath.join(root, 'log')))
      yield* writeFileWhole({ root, path: 'log' }, 'overwritten')
      expect(yield* read(config)).toBe('[core]\n')
      expect(yield* read(NodePath.join(root, 'log'))).toBe('overwritten')
    }),
  )

  it.effect('refuses a folder on the way that is a link', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const elsewhere = NodePath.join(root, 'elsewhere')
      const checkout = NodePath.join(root, 'checkout')
      yield* Effect.promise(() => mkdir(elsewhere))
      yield* Effect.promise(() => mkdir(checkout))
      yield* Effect.promise(() =>
        symlink(elsewhere, NodePath.join(checkout, '.fabrica')),
      )
      const error = yield* Effect.flip(
        writeFileWhole({ root: checkout, path: '.fabrica/fabrica.log' }, 'x'),
      )
      expect(error).toMatchObject({
        _tag: 'FileRefused',
        found: 'symbolic link',
        wanted: 'folder',
      })
      expect(yield* Effect.promise(() => readdir(elsewhere))).toEqual([])
    }),
  )

  it.effect('refuses a path outside its root', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      for (const path of ['../escape', '/etc/passwd', '', 'a/../../b']) {
        const error = yield* Effect.flip(writeFileWhole({ root, path }, 'x'))
        expect(error._tag).toBe('PathOutsideRoot')
      }
    }),
  )
})

describe('readFileText', () => {
  it.effect('reads a regular file', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      yield* Effect.promise(() =>
        writeFile(NodePath.join(root, 'answer.txt'), 'yes'),
      )
      expect(yield* readFileText({ root, path: 'answer.txt' })).toBe('yes')
    }),
  )

  it.effect('refuses a symbolic link at the target', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      yield* Effect.promise(() =>
        writeFile(NodePath.join(root, 'secret'), 'token'),
      )
      yield* Effect.promise(() =>
        symlink(NodePath.join(root, 'secret'), NodePath.join(root, 'answer')),
      )
      const error = yield* Effect.flip(readFileText({ root, path: 'answer' }))
      expect(error).toMatchObject({
        _tag: 'FileRefused',
        found: 'symbolic link',
        wanted: 'regular file',
      })
    }),
  )

  it.effect('refuses a named pipe without waiting on it', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      yield* makeFifo(NodePath.join(root, 'check.log'))
      const error = yield* Effect.flip(
        readFileText({ root, path: 'check.log' }),
      )
      expect(error).toMatchObject({ _tag: 'FileRefused', found: 'named pipe' })
    }),
  )

  it.effect('tells a missing file, and one past its size, from a read', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      expect(
        (yield* Effect.flip(readFileText({ root, path: 'none/answer' })))._tag,
      ).toBe('FileMissing')
      yield* Effect.promise(() =>
        writeFile(NodePath.join(root, 'big'), 'x'.repeat(100)),
      )
      expect(
        yield* Effect.flip(
          readFileText({ root, path: 'big' }, { maxBytes: 10 }),
        ),
      ).toMatchObject({ _tag: 'FileTooLarge', size: 100, maxBytes: 10 })
    }),
  )
})

describe('openFileTruncating', () => {
  it.effect('writes a file of its own from empty', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const path = NodePath.join(root, 'logs/check.log')
      yield* writeFileWhole({ root, path: 'logs/check.log' }, 'an old log\n')
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* openFileTruncating({
            root,
            path: 'logs/check.log',
          })
          yield* writer.write('line 1\n')
          yield* writer.write(new TextEncoder().encode('line 2\n'))
          yield* writer.sync
        }),
      )
      expect(yield* read(path)).toBe('line 1\nline 2\n')
    }),
  )

  it.effect(
    'creates a hard-linked target afresh, never truncating the linked file',
    () =>
      Effect.gen(function* () {
        const root = yield* scratch
        const config = NodePath.join(root, 'git-config')
        const log = NodePath.join(root, 'check.log')
        yield* Effect.promise(() =>
          writeFile(config, '[core]\n\tbare = false\n'),
        )
        yield* Effect.promise(() => link(config, log))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* openFileTruncating({
              root,
              path: 'check.log',
            })
            yield* writer.write('checks passed\n')
          }),
        )
        expect(yield* read(config)).toBe('[core]\n\tbare = false\n')
        expect(yield* read(log)).toBe('checks passed\n')
        expect((yield* Effect.promise(() => stat(config))).nlink).toBe(1)
        expect((yield* Effect.promise(() => stat(log))).nlink).toBe(1)
      }),
  )

  it.effect('refuses a symbolic link and a named pipe at the target', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const outside = NodePath.join(root, 'outside')
      yield* Effect.promise(() => writeFile(outside, 'kept'))
      yield* Effect.promise(() =>
        symlink(outside, NodePath.join(root, 'linked.log')),
      )
      yield* makeFifo(NodePath.join(root, 'pipe.log'))
      const linked = yield* Effect.flip(
        Effect.scoped(openFileTruncating({ root, path: 'linked.log' })),
      )
      const pipe = yield* Effect.flip(
        Effect.scoped(openFileTruncating({ root, path: 'pipe.log' })),
      )
      expect(linked).toMatchObject({
        _tag: 'FileRefused',
        found: 'symbolic link',
      })
      expect(pipe).toMatchObject({ _tag: 'FileRefused', found: 'named pipe' })
      expect(yield* read(outside)).toBe('kept')
    }),
  )
})

describe('openLineStream', () => {
  it.effect('appends each record as a line', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* openLineStream({
            root,
            path: '.fabrica/run/events.jsonl',
          })
          yield* stream.append('{"kind":"start"}')
          yield* stream.append('{"kind":"end"}')
        }),
      )
      expect(
        yield* read(NodePath.join(root, '.fabrica/run/events.jsonl')),
      ).toBe('{"kind":"start"}\n{"kind":"end"}\n')
    }),
  )

  it.effect('repairs a torn last line before the first new record', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const path = NodePath.join(root, 'events.jsonl')
      yield* Effect.promise(() =>
        writeFile(path, '{"kind":"start"}\n{"kind":"disp'),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* openLineStream({ root, path: 'events.jsonl' })
          yield* stream.append('{"kind":"end"}')
          yield* stream.append('{"kind":"done"}')
        }),
      )
      expect(yield* read(path)).toBe(
        '{"kind":"start"}\n{"kind":"disp\n{"kind":"end"}\n{"kind":"done"}\n',
      )
    }),
  )

  it.effect('keeps whole lines when records are appended side by side', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const records = Array.from({ length: 40 }, (_, index) =>
        JSON.stringify({ index, text: 'x'.repeat(index * 50) }),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* openLineStream({ root, path: 'events.jsonl' })
          yield* Effect.forEach(records, record => stream.append(record), {
            concurrency: 'unbounded',
          })
        }),
      )
      const lines = (yield* read(NodePath.join(root, 'events.jsonl'))).split(
        '\n',
      )
      expect(lines.pop()).toBe('')
      expect(lines.toSorted()).toEqual(records.toSorted())
    }),
  )

  it.effect(
    'copies a hard-linked stream to a file of its own before appending',
    () =>
      Effect.gen(function* () {
        const root = yield* scratch
        const config = NodePath.join(root, 'git-config')
        const path = NodePath.join(root, 'events.jsonl')
        yield* Effect.promise(() => writeFile(config, '[core]\n'))
        yield* Effect.promise(() => link(config, path))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* openLineStream({ root, path: 'events.jsonl' })
            yield* stream.append('{"kind":"start"}')
          }),
        )
        expect(yield* read(config)).toBe('[core]\n')
        expect(yield* read(path)).toBe('[core]\n{"kind":"start"}\n')
      }),
  )

  it.effect('refuses a symbolic link and a named pipe at the stream', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const outside = NodePath.join(root, 'outside')
      yield* Effect.promise(() => writeFile(outside, 'kept\n'))
      yield* Effect.promise(() =>
        symlink(outside, NodePath.join(root, 'fabrica.log')),
      )
      yield* makeFifo(NodePath.join(root, 'events.jsonl'))
      const linked = yield* Effect.flip(
        Effect.scoped(openLineStream({ root, path: 'fabrica.log' })),
      )
      const pipe = yield* Effect.flip(
        Effect.scoped(openLineStream({ root, path: 'events.jsonl' })),
      )
      expect(linked).toMatchObject({
        _tag: 'FileRefused',
        found: 'symbolic link',
      })
      expect(pipe).toMatchObject({ _tag: 'FileRefused', found: 'named pipe' })
      expect(yield* read(outside)).toBe('kept\n')
    }),
  )

  it.effect('refuses a record holding a newline', () =>
    Effect.gen(function* () {
      const root = yield* scratch
      const stream = yield* openLineStream({ root, path: 'events.jsonl' })
      const error = yield* Effect.flip(stream.append('one\ntwo'))
      expect(error._tag).toBe('NotALine')
    }),
  )
})

/** How a memory sink answers one write: take every byte, take only so many, or fail as a full disk does. */
type Step = 'all' | number | 'full'

/** A sink holding its bytes in memory, answering its writes by `steps` in turn, then taking every byte. */
const memorySink = (initial: string, steps: ReadonlyArray<Step>) => {
  const held: Array<Uint8Array> = [new TextEncoder().encode(initial)]
  let call = 0
  const sink: ByteSink = {
    write: bytes => {
      const step = steps[call] ?? 'all'
      call += 1
      if (step === 'full')
        return Effect.fail(
          new FileFailed({
            path: 'events.jsonl',
            operation: 'write',
            code: Option.some('ENOSPC'),
            reason: 'no space left on device',
          }),
        )
      const count = step === 'all' ? bytes.length : Math.min(step, bytes.length)
      held.push(bytes.slice(0, count))
      return Effect.succeed(count)
    },
  }
  const text = () => Buffer.concat(held).toString('utf8')
  return { sink, text }
}

describe('makeLineStream', () => {
  it.effect('loses only the record whose write was cut short', () =>
    Effect.gen(function* () {
      // "one" goes whole; "two" gets 2 bytes before the disk is full; "three" goes whole.
      const { sink, text } = memorySink('', ['all', 2, 'full'])
      const stream = yield* makeLineStream({
        path: 'events.jsonl',
        sink,
        endsWithNewline: true,
      })
      yield* stream.append('one')
      const cut = yield* Effect.flip(stream.append('two'))
      yield* stream.append('three')
      expect(cut).toMatchObject({ _tag: 'RecordCut', written: 2, length: 4 })
      expect(text()).toBe('one\ntw\nthree\n')
    }),
  )

  it.effect('adds no newline where the cut write ended its line', () =>
    Effect.gen(function* () {
      // The stream's last line is torn; the repair's newline goes out before the disk is full.
      const { sink, text } = memorySink('{"kind":"disp', [1, 'full'])
      const stream = yield* makeLineStream({
        path: 'events.jsonl',
        sink,
        endsWithNewline: false,
      })
      expect((yield* Effect.flip(stream.append('lost')))._tag).toBe('RecordCut')
      yield* stream.append('next')
      expect(text()).toBe('{"kind":"disp\nnext\n')
    }),
  )

  it.effect('finishes a record the system writes a part at a time', () =>
    Effect.gen(function* () {
      const { sink, text } = memorySink('', [3, 3, 3, 3])
      const stream = yield* makeLineStream({
        path: 'events.jsonl',
        sink,
        endsWithNewline: true,
      })
      yield* stream.append('{"kind":"start"}')
      expect(text()).toBe('{"kind":"start"}\n')
    }),
  )

  it.effect('takes a write of no bytes for a cut', () =>
    Effect.gen(function* () {
      const { sink, text } = memorySink('', [5, 0])
      const stream = yield* makeLineStream({
        path: 'events.jsonl',
        sink,
        endsWithNewline: true,
      })
      expect(yield* Effect.flip(stream.append('a record'))).toMatchObject({
        _tag: 'RecordCut',
        written: 5,
      })
      yield* stream.append('b')
      expect(text()).toBe('a rec\nb\n')
    }),
  )
})
