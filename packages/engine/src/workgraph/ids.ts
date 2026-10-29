import { Effect, Option, Random } from 'effect'

import { NoteId, TicketId } from '@fabrica/contracts'

import { InvalidPrefix } from './errors'

// How the work graph draws its IDs (spec §11.2, §11.4). A ticket's is `<prefix>-<random>`; the random
// part is 11 lower-case base36 characters, the shortest that keeps two engines from minting the same ID
// below 1e-7 at 100k tickets (P = 5.0e9 / 36^11 = 3.8e-8, spike fab-mgi.2.3). A child's is
// `<parent>.<n>` and draws nothing.

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'

/** The length of a ticket ID's random part. */
export const ticketIdRandomLength = 11

/** The length of a note ID: notes from every ticket share one table, so it draws more. */
const noteIdLength = 16

/** `length` random lower-case base36 characters. */
export const drawBase36 = (length: number): Effect.Effect<string> =>
  Effect.map(
    Effect.all(
      // Effect's upper bound is inclusive unless half open: index 36 would be no character at all.
      Array.from({ length }, () =>
        Random.nextIntBetween(0, alphabet.length, { halfOpen: true }),
      ),
    ),
    indices => indices.map(index => alphabet[index]).join(''),
  )

/** The prefix, checked: a ticket ID made with it decodes. */
export const checkPrefix = (
  prefix: string,
): Effect.Effect<string, InvalidPrefix> =>
  Option.match(
    TicketId.makeOption(`${prefix}-${'0'.repeat(ticketIdRandomLength)}`),
    {
      onNone: () => Effect.fail(new InvalidPrefix({ prefix })),
      onSome: () => Effect.succeed(prefix),
    },
  )

/** A new top-level ticket ID with the (checked) prefix. */
export const drawTicketId = (prefix: string): Effect.Effect<TicketId> =>
  Effect.map(drawBase36(ticketIdRandomLength), random =>
    TicketId.make(`${prefix}-${random}`),
  )

/** A new note ID. */
export const drawNoteId: Effect.Effect<NoteId> = Effect.map(
  drawBase36(noteIdLength),
  random => NoteId.make(random),
)

/** The number after `<parent>.` in a child's ID; none for any other ID. */
export const childNumber = (
  parent: TicketId,
  id: string,
): Option.Option<number> => {
  const rest = id.startsWith(`${parent}.`) ? id.slice(parent.length + 1) : ''
  return /^[1-9][0-9]*$/u.test(rest) ? Option.some(Number(rest)) : Option.none()
}

/** The ID of the parent's next child: one past the highest of `taken`, the IDs already used under it. */
export const nextChildId = (
  parent: TicketId,
  taken: ReadonlyArray<string>,
): TicketId => {
  const highest = taken.reduce(
    (max, id) =>
      Option.match(childNumber(parent, id), {
        onNone: () => max,
        onSome: n => Math.max(max, n),
      }),
    0,
  )
  return TicketId.make(`${parent}.${highest + 1}`)
}
