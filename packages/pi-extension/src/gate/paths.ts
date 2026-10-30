import { Data, Option } from 'effect'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Expansion, expandBraces } from './braces'

// Path confinement (spec §12.6, §20.2): whether a path, or a shell glob, stays inside the worktree.
// Every brace alternative is checked; a glob's segments match one name each, except one that can
// match `..` (a dot followed by a wildcard: older shells match `.*` against `..`), read as `..`. A
// leading `~` is the home folder; a relative path is read from the folder it is resolved in, which
// may be unknown (after `cd "$dir"`). Paths are read as written, without following links.

/** Where a path or glob lands. */
export type Confinement = Data.TaggedEnum<{
  Inside: {}
  /** One of its alternatives lands outside the worktree, at `path`. */
  Outside: { readonly path: string }
  /** The gate can't tell where it lands: why. */
  Unknown: { readonly reason: string }
  /** A pattern the gate refuses to read (§20.2): why. */
  Refused: { readonly reason: string }
}>
export const Confinement = Data.taggedEnum<Confinement>()

/** What paths are resolved against: the worktree, the home folder, and the folder a relative path starts from. */
export interface PathContext {
  readonly worktree: string
  readonly home: Option.Option<string>
  /** None where the gate can't tell the current folder. */
  readonly cwd: Option.Option<string>
}

/** Whether `path`, absolute, is the worktree or inside it. */
export const isInside = (worktree: string, path: string): boolean => {
  const rest = relative(resolve(worktree), resolve(path))
  return (
    rest === '' ||
    (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
  )
}

/** `pattern`'s segments, split on unescaped slashes, each kept escaped. */
const segments = (pattern: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let part = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? ''
    if (char === '\\') {
      part += pattern.slice(index, index + 2)
      index++
    } else if (char === '/') {
      parts.push(part)
      part = ''
    } else part += char
  }
  parts.push(part)
  return parts
}

/** An escaped segment's literal text, or none when it holds an unescaped wildcard. */
const literal = (segment: string): Option.Option<string> => {
  let text = ''
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index] ?? ''
    if (char === '\\') {
      text += segment[index + 1] ?? ''
      index++
    } else if (char === '*' || char === '?' || char === '[')
      return Option.none()
    else text += char
  }
  return Option.some(text)
}

/** A glob segment can match `..` when it opens with a literal dot and holds a wildcard. */
const canMatchParent = (segment: string): boolean =>
  segment.startsWith('.') || segment.startsWith('\\.')

/** `pattern`, one brace alternative, unescaped: a glob segment read as `..` or as one name. */
const unglobbed = (alternative: string): string =>
  segments(alternative)
    .map(segment =>
      Option.getOrElse(literal(segment), () =>
        canMatchParent(segment) ? '..' : 'glob',
      ),
    )
    .join('/')

/** Where one brace alternative lands. */
export type Place = Data.TaggedEnum<{
  /** At `path`, absolute. */
  At: { readonly path: string }
  /** The gate can't tell where it lands: why. */
  Unknown: { readonly reason: string }
}>
export const Place = Data.taggedEnum<Place>()

/** Where each of a pattern's brace alternatives lands. */
export type Locations = Data.TaggedEnum<{
  Located: { readonly places: ReadonlyArray<Place> }
  /** A pattern the gate refuses to read (§20.2): why. */
  Refused: { readonly reason: string }
}>
export const Locations = Data.taggedEnum<Locations>()

/** Where one alternative lands. */
const locate = (alternative: string, context: PathContext): Place => {
  const path = unglobbed(alternative)
  if (path === '~' || path.startsWith('~/'))
    return Option.match(context.home, {
      onNone: () => Place.Unknown({ reason: 'the home folder isn’t known' }),
      onSome: home => Place.At({ path: resolve(join(home, path.slice(1))) }),
    })
  if (path.startsWith('~'))
    return Place.Unknown({
      reason: `${path.split('/')[0]} is another user’s home folder`,
    })
  if (isAbsolute(path)) return Place.At({ path: resolve(path) })
  return Option.match(context.cwd, {
    onNone: () =>
      Place.Unknown({
        reason: `${path} is relative to a folder the gate can't tell`,
      }),
    onSome: cwd => Place.At({ path: resolve(cwd, path) }),
  })
}

/** Where each alternative of `pattern`, a path or a shell glob in its escaped form, lands. */
export const locations = (pattern: string, context: PathContext): Locations =>
  Expansion.$match(expandBraces(pattern), {
    Refused: ({ reason }) => Locations.Refused({ reason }),
    Expanded: ({ alternatives }) =>
      Locations.Located({
        places: alternatives.map(alternative => locate(alternative, context)),
      }),
  })

/** Where `pattern`, a path or a shell glob in its escaped form, lands: outside where any alternative does. */
export const confine = (pattern: string, context: PathContext): Confinement =>
  Locations.$match(locations(pattern, context), {
    Refused: ({ reason }) => Confinement.Refused({ reason }),
    Located: ({ places }) => {
      const [outside] = places.flatMap(place =>
        Place.$match(place, {
          At: ({ path }) => (isInside(context.worktree, path) ? [] : [path]),
          Unknown: () => [],
        }),
      )
      const [unknown] = places.flatMap(place =>
        Place.$match(place, {
          At: () => [],
          Unknown: ({ reason }) => [reason],
        }),
      )
      if (outside !== undefined) return Confinement.Outside({ path: outside })
      return unknown === undefined
        ? Confinement.Inside()
        : Confinement.Unknown({ reason: unknown })
    },
  })
