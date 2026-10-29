import { Effect, type Scope, Semaphore } from 'effect'
import { constants } from 'node:fs'

import {
  type FileFailed,
  type FileMissing,
  type FileRefused,
  NotALine,
  type PathOutsideRoot,
  RecordCut,
} from './errors'
import { openOwnFile } from './links'
import {
  type FileLocation,
  attempt,
  checkFolders,
  closeQuietly,
  resolveLocation,
} from './open'

// An append-only stream of lines (the event stream, the human log; spec §13.12 "Written safely",
// H84). A stream whose last line an earlier crash cut short gets a newline before its first new
// record. Each record goes out with its newline in one buffer; where the write stops short (a full
// disk), the record is lost, and the stream remembers that its last line is cut, so the next record
// starts with a newline: a short write loses only its own record.

const newline = 0x0a

/** Where a line stream's bytes go: one write, which may write fewer bytes than it was given. */
export interface ByteSink {
  readonly write: (
    bytes: Uint8Array,
  ) => Effect.Effect<number, FileFailed | FileMissing>
}

/** An append-only stream of lines. */
export interface LineStream {
  readonly path: string
  /** Appends one record, a line without its newline; a write cut short fails with RecordCut. */
  readonly append: (line: string) => Effect.Effect<void, NotALine | RecordCut>
}

/** A line stream over `sink`; `endsWithNewline` says whether what the sink holds already ends a line (true when it is empty). */
export const makeLineStream = (options: {
  readonly path: string
  readonly sink: ByteSink
  readonly endsWithNewline: boolean
}): Effect.Effect<LineStream> =>
  Effect.gen(function* () {
    const { path, sink } = options
    const lock = yield* Semaphore.make(1)
    let endsWithNewline = options.endsWithNewline

    const writeRecord = Effect.fn('SafeFiles.appendLine')(function* (
      line: string,
    ) {
      if (line.includes('\n')) return yield* new NotALine({ path })
      const bytes = Buffer.from(
        `${endsWithNewline ? '' : '\n'}${line}\n`,
        'utf8',
      )
      let written = 0
      // The record is lost; whether the stream's last line is now cut is in the bytes that went out.
      const cut = (reason: string) => {
        if (written > 0) endsWithNewline = bytes[written - 1] === newline
        return new RecordCut({ path, written, length: bytes.length, reason })
      }
      while (written < bytes.length) {
        const count = yield* sink
          .write(bytes.subarray(written))
          .pipe(Effect.mapError(failure => cut(failure.message)))
        if (count <= 0) return yield* cut('the system wrote no bytes')
        written += count
      }
      endsWithNewline = true
    })

    return {
      path,
      append: line => lock.withPermits(1)(writeRecord(line)),
    } satisfies LineStream
  })

/**
 * Opens the line stream at `location` for appending, making the file and the folders it needs; it is
 * closed when the scope closes. Where the file's last line was cut short, the first record repairs it.
 */
export const openLineStream: (
  location: FileLocation,
) => Effect.Effect<
  LineStream,
  PathOutsideRoot | FileRefused | FileFailed | FileMissing,
  Scope.Scope
> = Effect.fn('SafeFiles.openLineStream')(function* (location: FileLocation) {
  const { full, folders } = yield* resolveLocation(location)
  yield* checkFolders(folders, true)
  const { handle, stats } = yield* Effect.acquireRelease(
    openOwnFile(full, constants.O_RDWR | constants.O_APPEND, 'contents'),
    opened => closeQuietly(opened.handle),
  )
  const endsWithNewline =
    stats.size === 0 ||
    (yield* attempt(full, 'read', () =>
      handle.read(Buffer.alloc(1), 0, 1, stats.size - 1),
    )).buffer[0] === newline
  return yield* makeLineStream({
    path: full,
    endsWithNewline,
    sink: {
      write: bytes =>
        attempt(full, 'write', () => handle.write(bytes)).pipe(
          Effect.map(result => result.bytesWritten),
        ),
    },
  })
})
