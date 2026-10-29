import { Stream } from 'effect'

// How Pi's RPC records are framed (spec §12.1): one JSON record a line, split on LF alone. Node's
// readline also splits on U+2028 and U+2029, which a JSON string may hold unescaped, so it is never
// used: a record holding one would be cut in two and both halves lost.

const LF = 0x0a

const utf8 = (parts: ReadonlyArray<Uint8Array>): string =>
  Buffer.concat(parts).toString('utf8')

/**
 * The lines of a byte stream, split on LF only, each without its LF; a last line with no LF is
 * given when the stream ends. Lines are cut on bytes, so a character split across chunks is whole.
 */
export const splitRecords = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E, R> =>
  bytes.pipe(
    Stream.mapAccum(
      (): ReadonlyArray<Uint8Array> => [],
      (pending, chunk) => {
        const lines: Array<string> = []
        let held: Array<Uint8Array> = [...pending]
        let start = 0
        for (let index = chunk.indexOf(LF); index !== -1;) {
          held.push(chunk.subarray(start, index))
          lines.push(utf8(held))
          held = []
          start = index + 1
          index = chunk.indexOf(LF, start)
        }
        if (start < chunk.length) held.push(chunk.subarray(start))
        return [held, lines]
      },
      {
        onHalt: pending =>
          pending.some(part => part.length > 0) ? [utf8(pending)] : [],
      },
    ),
  )
