import { RpcSerialization } from 'effect/rpc'

import { describe, expect, it } from '@effect/vitest'

import { maxFrame, ndjson, wholeFrames } from '../src/frames'

// The client's NDJSON frames read in one pass (fab-mgi.99): its parser is given a transport's reads
// only once one ends a frame, or they pass the frame limit, so a frame that comes in many reads is
// searched for its end once rather than at every read.

/** Effect's NDJSON serialization with `limit`, the reads its parser is given kept in `given`. */
const recording = (limit: number) => {
  const given: Array<Uint8Array | string> = []
  const inner = RpcSerialization.makeNdjson({ maxBufferSize: limit })
  const serialization = RpcSerialization.RpcSerialization.of({
    ...inner,
    makeUnsafe: () => {
      const parser = inner.makeUnsafe()
      return {
        encode: response => parser.encode(response),
        decode: data => {
          given.push(data)
          return parser.decode(data)
        },
      }
    },
  })
  return { given, parser: wholeFrames(serialization, limit).makeUnsafe() }
}

/** `text`'s bytes, cut every `size`. */
const cut = (text: string, size: number) => {
  const bytes = new TextEncoder().encode(text)
  const reads: Array<Uint8Array> = []
  for (let offset = 0; offset < bytes.length; offset += size) {
    reads.push(bytes.subarray(offset, offset + size))
  }
  return reads
}

const frames = [
  { _tag: 'Chunk', requestId: '1', values: ['grüße', '🜂'.repeat(40)] },
  { _tag: 'Pong' },
  { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: null } },
]
const text = frames.map(frame => `${JSON.stringify(frame)}\n`).join('')

describe('whole frames', () => {
  it('gives the parser a frame that comes in many reads as one read', () => {
    const { given, parser } = recording(maxFrame)
    const frame = `${JSON.stringify({ _tag: 'Pong', padding: 'x'.repeat(100) })}\n`
    const reads = cut(frame, 8)
    const decoded = reads.flatMap(read => parser.decode(read))
    expect(decoded).toStrictEqual([{ _tag: 'Pong', padding: 'x'.repeat(100) }])
    expect(given).toHaveLength(1)
    expect(given[0]).toStrictEqual(new TextEncoder().encode(frame))
  })

  it('reads frames cut anywhere as Effect’s parser does', () => {
    for (const size of [1, 3, 7, 64, text.length]) {
      const { parser } = recording(maxFrame)
      const decoded = cut(text, size).flatMap(read => parser.decode(read))
      expect(decoded).toStrictEqual(frames)
    }
  })

  it('reads frames that come as strings', () => {
    const parser = ndjson.makeUnsafe()
    const reads = text.match(/.{1,5}/gsu) ?? []
    expect(reads.flatMap(read => parser.decode(read))).toStrictEqual(frames)
  })

  it('fails on an overlong frame at the read that passes the limit', () => {
    const { given, parser } = recording(64)
    const reads = cut('x'.repeat(100), 16)
    // 64 bytes held after the fourth read, 80 after the fifth.
    expect(reads.slice(0, 4).map(read => parser.decode(read))).toStrictEqual([
      [],
      [],
      [],
      [],
    ])
    expect(() => reads.slice(4).map(read => parser.decode(read))).toThrow(
      RpcSerialization.MaxBufferSizeExceeded,
    )
    expect(given).toHaveLength(1)
  })
})
