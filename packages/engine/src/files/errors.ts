import { Data, Option } from 'effect'

// What can go wrong reading or writing an engine file (spec §20.2, H84).

/** What stood at a path. */
export type FoundKind =
  | 'symbolic link'
  | 'hard-linked file'
  | 'named pipe'
  | 'folder'
  | 'file'
  | 'socket'
  | 'device'
  | 'other'

/** The path holds something other than what was wanted there: a regular file, or a real folder on the way to one. */
export class FileRefused extends Data.TaggedError('FileRefused')<{
  readonly path: string
  readonly found: FoundKind
  readonly wanted: 'regular file' | 'folder'
}> {
  override get message() {
    return `${this.path} is a ${this.found}, not a ${this.wanted}; refused`
  }
}

/** The path names nothing. */
export class FileMissing extends Data.TaggedError('FileMissing')<{
  readonly path: string
}> {
  override get message() {
    return `${this.path} doesn't exist`
  }
}

/** The path leaves its root: absolute, empty, or through `..`. */
export class PathOutsideRoot extends Data.TaggedError('PathOutsideRoot')<{
  readonly root: string
  readonly path: string
}> {
  override get message() {
    return `${JSON.stringify(this.path)} isn't a path inside ${this.root}`
  }
}

/** A file read past the size its reader allows. */
export class FileTooLarge extends Data.TaggedError('FileTooLarge')<{
  readonly path: string
  readonly size: number
  readonly maxBytes: number
}> {
  override get message() {
    return `${this.path} has ${this.size} bytes, more than the ${this.maxBytes} allowed`
  }
}

/** The system refused an operation on the path; `code` is its error code (`ENOSPC`) where it gave one. */
export class FileFailed extends Data.TaggedError('FileFailed')<{
  readonly path: string
  readonly operation: string
  readonly code: Option.Option<string>
  readonly reason: string
}> {
  override get message() {
    return `${this.operation} ${this.path}: ${this.reason}`
  }

  /** The error a system call threw, as a FileFailed. */
  static fromCause(
    path: string,
    operation: string,
    cause: unknown,
  ): FileFailed {
    return new FileFailed({
      path,
      operation,
      code: errorCode(cause),
      reason: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

/** A line handed to a line stream holds a newline, so it would write more than one record. */
export class NotALine extends Data.TaggedError('NotALine')<{
  readonly path: string
}> {
  override get message() {
    return `a record for ${this.path} holds a newline`
  }
}

/** A record's write stopped short (a full disk): the record is lost, and the stream's next record starts a line of its own. */
export class RecordCut extends Data.TaggedError('RecordCut')<{
  readonly path: string
  readonly written: number
  readonly length: number
  readonly reason: string
}> {
  override get message() {
    return `${this.path}: a record was cut after ${this.written} of ${this.length} bytes: ${this.reason}`
  }
}

/** The system error code (`ENOENT`, `ELOOP`) a thrown value carries. */
export const errorCode = (cause: unknown): Option.Option<string> =>
  typeof cause === 'object' &&
  cause !== null &&
  'code' in cause &&
  typeof cause.code === 'string'
    ? Option.some(cause.code)
    : Option.none()
