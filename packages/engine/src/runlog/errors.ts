import { Data } from 'effect'

/** A record the stream's schema refuses: a field missing or out of its range. Nothing was written. */
export class RecordInvalid extends Data.TaggedError('RecordInvalid')<{
  readonly kind: string
  readonly reason: string
}> {
  override get message() {
    return `a ${this.kind} record doesn't fit the event stream's schema: ${this.reason}`
  }
}
