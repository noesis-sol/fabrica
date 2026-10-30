import { RpcSerialization } from 'effect/rpc'

// How the client reads the engine's NDJSON frames (spec §8). Effect's NDJSON parser searches all it
// holds for a newline at each read it is given, so a frame that comes in many reads costs time in its
// size squared: macOS reads a local socket 8 KiB at a time, which made a 16 MiB frame 2 s of work.
// `wholeFrames` holds a transport's reads back until one brings a newline, or what it holds passes the
// frame limit, then gives the parser them all in one read, which it searches once.

/** The longest frame the client reads, Effect's default: a longer one is a defect. */
export const maxFrame = 16 * 1024 * 1024

/** Whether a read holds the end of a frame. */
const endsFrame = (data: Uint8Array | string) =>
  typeof data === 'string' ? data.includes('\n') : data.includes(0x0a)

/** Reads held back, joined into one. */
const joined = (
  reads: ReadonlyArray<Uint8Array | string>,
): Uint8Array | string => {
  const [first] = reads
  if (reads.length === 1 && first !== undefined) {
    return first
  }
  if (reads.every(read => typeof read === 'string')) {
    return reads.join('')
  }
  const encoder = new TextEncoder()
  const bytes = reads.map(read =>
    typeof read === 'string' ? encoder.encode(read) : read,
  )
  const whole = new Uint8Array(
    bytes.reduce((size, read) => size + read.length, 0),
  )
  let offset = 0
  for (const read of bytes) {
    whole.set(read, offset)
    offset += read.length
  }
  return whole
}

/**
 * `serialization`, its parser given a transport's reads only once one ends a frame or they pass
 * `limit` (its own limit, so that it still fails on an overlong frame as soon as it would).
 */
export const wholeFrames = (
  serialization: RpcSerialization.RpcSerialization['Service'],
  limit: number,
): RpcSerialization.RpcSerialization['Service'] =>
  RpcSerialization.RpcSerialization.of({
    ...serialization,
    makeUnsafe: () => {
      const parser = serialization.makeUnsafe()
      let held: Array<Uint8Array | string> = []
      let size = 0
      return {
        encode: response => parser.encode(response),
        decode: data => {
          held.push(data)
          size += data.length
          if (!endsFrame(data) && size <= limit) {
            return []
          }
          const whole = joined(held)
          held = []
          size = 0
          return parser.decode(whole)
        },
      }
    },
  })

/** The client's NDJSON serialization: Effect's, its parser given whole frames. */
export const ndjson = wholeFrames(
  RpcSerialization.makeNdjson({ maxBufferSize: maxFrame }),
  maxFrame,
)
