import { Effect } from 'effect'

// What a request or stream the engine doesn't serve yet answers (spec §8.1): its group's handlers are
// in place and each answers `NotImplemented`, until the ticket that builds the group fills its file.
// It answers as a defect, an `Error` named `NotImplemented` that the protocol carries as one, since no
// group's schema has an error for it; the server keeps such a defect to its own request.

/** A request or stream the engine doesn't serve yet. */
export class NotImplemented extends Error {
  override readonly name = 'NotImplemented'
  constructor(readonly rpc: string) {
    super(`${rpc} is not implemented yet`)
  }
}

/** The handler of a request or stream the engine doesn't serve yet: it answers `NotImplemented`. */
export const notImplemented = (rpc: string) => (): Effect.Effect<never> =>
  Effect.die(new NotImplemented(rpc))
