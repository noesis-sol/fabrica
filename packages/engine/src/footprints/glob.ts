// Globs (spec §13.4): those a ticket's `files` and the project's `shared_files` give, matched part by
// part as Go's path.Match matches them, `**` matching any number of folders. Bounded: a run of `**`s
// is one, and a match remembers the ways that failed, so each part of the pattern meets each part of
// the path once, however many `**`s it has (a glob of seven took tutti 3.6 s a fill, tutti-crj).

/** A name in NFC, the Unicode form names are compared in. */
export const nfc = (name: string): string => name.normalize('NFC')

/** Whether a name is a glob: it has a `*`, a `?` or a `[`. */
export const isGlob = (name: string): boolean => /[*?[]/u.test(name)

/** The glob with each run of `**`s as one, which matches the same paths: `a/**\/**\/b` as `a/**\/b`. */
export const collapseAny = (glob: string): string =>
  glob.replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/gu, '$1**')

const escapeChar = (c: string): string =>
  `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`

/**
 * A part of a glob as a regular expression: `*` any run of characters, `?` one, `[a-z]` and
 * `[^a-z]` a class, `\` escaping the next character. A malformed part matches nothing.
 */
const compilePart = (part: string): RegExp | undefined => {
  const chars = [...part]
  let source = ''
  let i = 0
  // The next character of a class, escaped or not; undefined where the class is malformed.
  const classChar = (): string | undefined => {
    let c = chars[i]
    if (c === undefined || c === '-' || c === ']') return undefined
    if (c === '\\') {
      i++
      c = chars[i]
      if (c === undefined) return undefined
    }
    i++
    return c
  }
  while (i < chars.length) {
    const c = chars[i] ?? ''
    if (c === '*') {
      source += '[^/]*'
      i++
    } else if (c === '?') {
      source += '[^/]'
      i++
    } else if (c === '\\') {
      const next = chars[i + 1]
      if (next === undefined) return undefined
      source += escapeChar(next)
      i += 2
    } else if (c === '[') {
      i++
      const negated = chars[i] === '^'
      if (negated) i++
      let ranges = ''
      for (let count = 0; ; count++) {
        if (chars[i] === ']' && count > 0) {
          i++
          break
        }
        const lo = classChar()
        if (lo === undefined) return undefined
        let hi = lo
        if (chars[i] === '-') {
          i++
          const end = classChar()
          if (end === undefined) return undefined
          hi = end
        }
        // A range running backwards matches nothing, as in Go.
        if ((lo.codePointAt(0) ?? 0) <= (hi.codePointAt(0) ?? 0))
          ranges += `${escapeChar(lo)}-${escapeChar(hi)}`
      }
      if (negated) source += ranges === '' ? '[^/]' : `(?![${ranges}])[^/]`
      else source += ranges === '' ? '(?!)' : `[${ranges}]`
    } else {
      source += escapeChar(c)
      i++
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

/**
 * A glob's part, compiled once: `**`, or a name's pattern (undefined when malformed) with the one
 * name it matches where it matches one alone.
 */
type Part =
  | { readonly any: true; readonly text: string }
  | {
      readonly any: false
      readonly text: string
      readonly literal: string | undefined
      readonly pattern: RegExp | undefined
    }

/** A glob, compiled once and matched against many paths. */
export interface Glob {
  /** The glob as written, its runs of `**` collapsed and in NFC. */
  readonly text: string
  /** Whether it matches the path, from the repository's root. */
  readonly matches: (path: string) => boolean
}

/**
 * The one name a glob's part matches, its escapes undone; undefined when it matches others (a `*`,
 * a `?` or a class) or none (a `\` ending it).
 */
const literalPart = (s: string): string | undefined => {
  if (!/[*?[\\]/u.test(s)) return s
  let out = ''
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i] ?? ''
    if (c === '*' || c === '?' || c === '[') return undefined
    if (c === '\\') {
      i++
      if (i === chars.length) return undefined
      c = chars[i] ?? ''
    }
    out += c
  }
  return out
}

const partsOf = (text: string): ReadonlyArray<Part> =>
  text.split('/').map(part =>
    part === '**'
      ? { any: true, text: part }
      : {
          any: false,
          text: part,
          literal: literalPart(part),
          pattern: compilePart(part),
        },
  )

const partMatches = (part: Part, name: string): boolean =>
  part.any ? true : (part.pattern?.test(name) ?? false)

/**
 * Whether the parts of a path match the glob's: each name its part, `**` any number of them. The
 * ways tried that failed are remembered, so no pair of positions is tried twice.
 */
const matchParts = (
  glob: ReadonlyArray<Part>,
  path: ReadonlyArray<string>,
): boolean => {
  const failed = new Set<number>()
  const match = (i: number, j: number): boolean => {
    const key = i * (path.length + 1) + j
    if (failed.has(key)) return false
    const part = glob[i]
    const name = path[j]
    const ok =
      part === undefined
        ? name === undefined
        : part.any
          ? match(i + 1, j) || (name !== undefined && match(i, j + 1))
          : name !== undefined && partMatches(part, name) && match(i + 1, j + 1)
    if (!ok) failed.add(key)
    return ok
  }
  return match(0, 0)
}

/** A glob compiled: its runs of `**` collapsed, a leading `/` or `./` left off. */
export const compileGlob = (glob: string): Glob => {
  const text = collapseAny(nfc(glob.replace(/^\.?\//u, '')))
  const parts = partsOf(text)
  return {
    text,
    matches: path => matchParts(parts, nfc(path).split('/')),
  }
}

/**
 * A glob of the settings (`shared_files`), as orchestra matches them: with a slash, the path from
 * the repository's root; without one, the file's name in any folder.
 */
export const compileSettingsGlob = (glob: string): Glob => {
  const written = nfc(glob)
  if (written.replace(/^\//u, '').includes('/')) return compileGlob(written)
  const parts = partsOf(collapseAny(written))
  return {
    text: written,
    matches: path => matchParts(parts, [nfc(path).split('/').at(-1) ?? '']),
  }
}

const lastSpecial = (s: string): number =>
  Math.max(...['*', '?', '[', ']', '\\'].map(c => s.lastIndexOf(c)))

/**
 * Whether one name can match both parts: the name one of them stands for alone, which the other
 * matches, or, both patterns, any name their literal beginnings and ends allow (`*.ts` and `c*.ts`
 * meet, `*.ts` and `*.go` don't).
 */
const partsMeet = (x: Part, y: Part): boolean => {
  if (x.any || y.any) return true
  const lx = x.literal
  const ly = y.literal
  if (lx !== undefined && ly !== undefined) return lx === ly
  if (ly !== undefined) return partMatches(x, ly)
  if (lx !== undefined) return partMatches(y, lx)
  const px = x.text.slice(0, x.text.search(/[*?[\\]/u))
  const py = y.text.slice(0, y.text.search(/[*?[\\]/u))
  const sx = x.text.slice(lastSpecial(x.text) + 1)
  const sy = y.text.slice(lastSpecial(y.text) + 1)
  return (
    (px.startsWith(py) || py.startsWith(px)) &&
    (sx.endsWith(sy) || sy.endsWith(sx))
  )
}

/**
 * Whether one path can match both globs, a path's parts written as a glob's: `**` any number of
 * names, the others one each. The ways tried that failed are remembered, as in a match.
 */
const globPartsMeet = (
  a: ReadonlyArray<Part>,
  b: ReadonlyArray<Part>,
): boolean => {
  const failed = new Set<number>()
  const meet = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j
    if (failed.has(key)) return false
    const x = a[i]
    const y = b[j]
    const ok =
      x !== undefined && x.any
        ? meet(i + 1, j) || (j < b.length && meet(i, j + 1))
        : y !== undefined && y.any
          ? meet(i, j + 1) || (i < a.length && meet(i + 1, j))
          : x === undefined || y === undefined
            ? x === undefined && y === undefined
            : partsMeet(x, y) && meet(i + 1, j + 1)
    if (!ok) failed.add(key)
    return ok
  }
  return meet(0, 0)
}

/** A literal path's parts as a glob's, a folder's followed by `**` for the files under it. */
const literalParts = (path: string, folder: boolean): ReadonlyArray<Part> => [
  ...nfc(path)
    .split('/')
    .map((name): Part => ({
      any: false,
      text: name,
      literal: name,
      pattern: new RegExp(`^${[...name].map(escapeChar).join('')}$`, 'u'),
    })),
  ...(folder ? [{ any: true, text: '**' } satisfies Part] : []),
]

/** Whether the glob matches a file in the folder, or one that may be added there. */
export const globMeetsFolder = (glob: Glob, folder: string): boolean =>
  globPartsMeet(partsOf(glob.text), literalParts(folder, true))

/** Whether two globs can match one file. */
export const globsMeet = (a: Glob, b: Glob): boolean =>
  a.text === b.text || globPartsMeet(partsOf(a.text), partsOf(b.text))
