import { Data } from 'effect'

// A shell word's brace expansion, as path confinement reads it (spec §20.2): every alternative of
// `{a,b}` and of a sequence `{1..3}`, nested or side by side, so that confinement checks each one
// (`{..,src}/*` passed tutti's scout, tutti-n142). A pattern whose braces don't close, or that expands
// past `MaxAlternatives`, is refused rather than read. The pattern is a word's escaped form (see
// `shell.ts`): a backslash makes the next character literal, as quoting does, and the alternatives
// keep their escapes for the globbing that follows.

/** The most alternatives a pattern may expand to. */
export const MaxAlternatives = 256

export type Expansion = Data.TaggedEnum<{
  /** The pattern's alternatives, in the shell's order. */
  Expanded: { readonly alternatives: ReadonlyArray<string> }
  /** A brace that doesn't close, or more alternatives than `MaxAlternatives`. */
  Refused: { readonly reason: string }
}>
export const Expansion = Data.taggedEnum<Expansion>()

/** One piece of a pattern: literal text, or a choice among sequences of pieces. */
type Piece =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Choice'; readonly options: ReadonlyArray<Sequence> }
type Sequence = ReadonlyArray<Piece>

class Unclosed extends Data.TaggedError('Unclosed')<{
  readonly at: number
}> {}

/** Where the brace opening at `open` closes, and the offsets of its top-level commas; none when it doesn't close. */
const closing = (
  pattern: string,
  open: number,
):
  | { readonly close: number; readonly commas: ReadonlyArray<number> }
  | undefined => {
  const commas: Array<number> = []
  let depth = 0
  for (let index = open + 1; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') index++
    else if (char === '{') depth++
    else if (char === '}') {
      if (depth === 0) return { close: index, commas }
      depth--
    } else if (char === ',' && depth === 0) commas.push(index)
  }
  return undefined
}

const sequencePattern =
  /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$|^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/u

/** A sequence expression's terms (`1..3`, `a..e..2`), or none when `body` isn't one. */
const sequenceTerms = (
  body: string,
):
  | { readonly count: number; readonly terms: () => ReadonlyArray<string> }
  | undefined => {
  const match = sequencePattern.exec(body)
  if (match === null) return undefined
  const numeric = match[1] !== undefined
  const from = numeric ? Number(match[1]) : (match[4] ?? '').charCodeAt(0)
  const to = numeric ? Number(match[2]) : (match[5] ?? '').charCodeAt(0)
  const step = Math.abs(Number(match[numeric ? 3 : 6] ?? '1')) || 1
  const count = Math.floor(Math.abs(to - from) / step) + 1
  const direction = to >= from ? step : -step
  return {
    count,
    terms: () =>
      Array.from({ length: count }, (_, index) => {
        const term = from + index * direction
        return numeric ? String(term) : String.fromCharCode(term)
      }),
  }
}

/** The pieces of `pattern` from `start` to `end`. */
const parse = (pattern: string, start: number, end: number): Sequence => {
  const pieces: Array<Piece> = []
  let text = ''
  let index = start
  while (index < end) {
    const char = pattern[index] ?? ''
    if (char === '\\') {
      text += pattern.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '$' && pattern[index + 1] === '{') {
      // A parameter, `${name}`, not a brace expansion.
      const found = closing(pattern, index + 1)
      if (found === undefined) throw new Unclosed({ at: index + 1 })
      text += pattern.slice(index, found.close + 1)
      index = found.close + 1
      continue
    }
    if (char !== '{') {
      text += char
      index++
      continue
    }
    const found = closing(pattern, index)
    if (found === undefined || found.close >= end)
      throw new Unclosed({ at: index })
    const body = pattern.slice(index + 1, found.close)
    const sequence = found.commas.length === 0 ? sequenceTerms(body) : undefined
    if (found.commas.length === 0 && sequence === undefined) {
      // No comma and no sequence: the braces are literal, though what they hold may expand.
      text += '{'
      pieces.push({ _tag: 'Text', text })
      text = ''
      pieces.push(...parse(pattern, index + 1, found.close))
      text = '}'
      index = found.close + 1
      continue
    }
    pieces.push({ _tag: 'Text', text })
    text = ''
    if (sequence !== undefined)
      pieces.push({
        _tag: 'Choice',
        options:
          sequence.count > MaxAlternatives
            ? Array.from({ length: MaxAlternatives + 1 }, () => [])
            : sequence.terms().map(term => [{ _tag: 'Text', text: term }]),
      })
    else {
      const bounds = [index, ...found.commas, found.close]
      pieces.push({
        _tag: 'Choice',
        options: bounds
          .slice(1)
          .map((bound, option) =>
            parse(pattern, (bounds[option] ?? 0) + 1, bound),
          ),
      })
    }
    index = found.close + 1
  }
  pieces.push({ _tag: 'Text', text })
  return pieces
}

/** How many alternatives a sequence expands to, counted no further than one past the limit. */
const count = (sequence: Sequence): number =>
  sequence.reduce(
    (total, piece) =>
      piece._tag === 'Text'
        ? total
        : Math.min(
            total *
              Math.min(
                piece.options.reduce((sum, option) => sum + count(option), 0),
                MaxAlternatives + 1,
              ),
            MaxAlternatives + 1,
          ),
    1,
  )

const expand = (sequence: Sequence): ReadonlyArray<string> =>
  sequence.reduce<ReadonlyArray<string>>(
    (prefixes, piece) =>
      piece._tag === 'Text'
        ? prefixes.map(prefix => prefix + piece.text)
        : prefixes.flatMap(prefix =>
            piece.options.flatMap(option =>
              expand(option).map(rest => prefix + rest),
            ),
          ),
    [''],
  )

/** Every alternative of `pattern`'s braces, or why it is refused. */
export const expandBraces = (pattern: string): Expansion => {
  let sequence: Sequence
  try {
    sequence = parse(pattern, 0, pattern.length)
  } catch (error) {
    if (error instanceof Unclosed)
      return Expansion.Refused({
        reason: `the brace at offset ${error.at} of ${JSON.stringify(pattern)} doesn't close`,
      })
    throw error
  }
  return count(sequence) > MaxAlternatives
    ? Expansion.Refused({
        reason: `${JSON.stringify(pattern)} expands to more than ${MaxAlternatives} alternatives`,
      })
    : Expansion.Expanded({ alternatives: expand(sequence) })
}
