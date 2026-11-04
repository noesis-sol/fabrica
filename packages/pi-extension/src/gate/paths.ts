import { Data, Option } from 'effect'
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Expansion, expandBraces } from './braces'

// Path confinement (spec §12.6, §20.2): whether a path, or a shell glob, stays inside the worktree.
// Every brace alternative is checked; a glob's wildcard segment stands for any entry of its folder,
// and for `..` where it can match that (a dot followed by a wildcard: older shells match `.*` against
// `..`). A leading `~` is the home folder; a relative path is read from the folder it is resolved in,
// which may be unknown (after `cd "$dir"`). Files in a worktree are hostile (H62), so a path is walked
// on the file system, a segment at a time, as the system resolves it: a link is followed, a dangling
// one too (a write creates its target, which `realpath` would refuse to name), `..` after a link is
// the target's parent, and what doesn't exist yet is read as written. `cd` and Pi's file tools take
// `..` off a path before the system sees it, so that reading is walked too, and each must stay inside.

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
  /** Its real path (`realFolder`): paths are compared with it once their links are followed. */
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

/** One step of a path: a name to go through, or a wildcard, which can match `..` where it `climbs`. */
type Step = Data.TaggedEnum<{
  Name: { readonly text: string }
  Wildcard: { readonly climbs: boolean }
}>
const Step = Data.taggedEnum<Step>()

/** A path's text as its steps. */
const names = (path: string): ReadonlyArray<Step> =>
  path.split('/').map(text => Step.Name({ text }))

/** One brace alternative, unescaped, as its steps. */
const steps = (alternative: string): ReadonlyArray<Step> =>
  segments(alternative).flatMap(segment =>
    Option.match(literal(segment), {
      onNone: () => [Step.Wildcard({ climbs: canMatchParent(segment) })],
      onSome: names,
    }),
  )

/** `path` as text: a wildcard read as `..` or as one name. */
const unglobbed = (path: ReadonlyArray<Step>): string =>
  path
    .map(step =>
      Step.$match(step, {
        Name: ({ text }) => text,
        Wildcard: ({ climbs }) => (climbs ? '..' : 'glob'),
      }),
    )
    .join('/')

/** `path` with `..` taken off as written, as `cd` and Pi's file tools read it. */
const lexically = (path: ReadonlyArray<Step>): ReadonlyArray<Step> => {
  const kept: Array<Step> = []
  for (const step of path)
    Step.$match(step, {
      Name: ({ text }) => {
        if (text === '..') kept.pop()
        else if (text !== '' && text !== '.') kept.push(step)
      },
      Wildcard: ({ climbs }) => {
        if (climbs) kept.pop()
        else kept.push(step)
      },
    })
  return kept
}

/** Where one brace alternative lands. */
export type Place = Data.TaggedEnum<{
  /** At `path`, absolute, its links followed. */
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

/**
 * What's done with a link a path ends in: `followed` by what opens or writes it, `kept` by what acts
 * on the link itself (`rm link` removes the link, and `rm link/` or `rm link/x` go through it).
 */
export type LastLink = 'followed' | 'kept'

/** What the file system holds at a path. */
type Entry = Data.TaggedEnum<{
  Missing: {}
  Link: { readonly target: string }
  Other: {}
  /** The gate can't read it: why. */
  Unreadable: { readonly reason: string }
}>
const Entry = Data.taggedEnum<Entry>()

/** Whether a file system call failed because the path doesn't exist. */
const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR')

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const entryAt = (path: string): Entry => {
  try {
    return lstatSync(path).isSymbolicLink()
      ? Entry.Link({ target: readlinkSync(path) })
      : Entry.Other()
  } catch (error) {
    return isMissing(error)
      ? Entry.Missing()
      : Entry.Unreadable({ reason: message(error) })
  }
}

/** A folder's entries, for a wildcard to stand for. */
type Listing = Data.TaggedEnum<{
  Listed: { readonly entries: ReadonlyArray<string> }
  /** The gate can't read it: why. */
  Unreadable: { readonly reason: string }
}>
const Listing = Data.taggedEnum<Listing>()

const listingOf = (folder: string): Listing => {
  try {
    return Listing.Listed({ entries: readdirSync(folder) })
  } catch (error) {
    return isMissing(error)
      ? Listing.Listed({ entries: [] })
      : Listing.Unreadable({ reason: message(error) })
  }
}

/** Links followed on one way down a path before the gate stops, as the system's own limit does. */
const maxLinks = 40

/** Steps taken for one reading of a path before the gate can't tell where its wildcards reach. */
const maxSteps = 4096

/** Part way down a path: at `at`, a real folder, with `path` from `index` still to go. */
interface Walker {
  readonly at: string
  readonly path: ReadonlyArray<Step>
  readonly index: number
  readonly links: number
}

/** Where `path`, absolute, lands on the file system: each folder a wildcard may reach, followed. */
const walk = (
  path: ReadonlyArray<Step>,
  last: LastLink,
): ReadonlyArray<Place> => {
  const landed = new Set<string>()
  const unknown = new Set<string>()

  const step = (walker: Walker): ReadonlyArray<Walker> => {
    const { at, index, links } = walker
    const current = walker.path[index]
    if (current === undefined) {
      landed.add(at)
      return []
    }
    const after = walker.path.slice(index + 1)
    const isLast = after.length === 0
    const next = (folder: string): Walker => ({
      ...walker,
      at: folder,
      index: index + 1,
    })
    /** What doesn't exist yet goes no further on the file system: the rest is as written. */
    const asWritten = () =>
      landed.add(resolve(at, unglobbed(walker.path.slice(index))))
    const unreadable = (where: string, reason: string) =>
      unknown.add(`the gate can’t follow ${where}: ${reason}`)
    return Step.$match(current, {
      Name: ({ text }) => {
        if (text === '' || text === '.') return [next(at)]
        if (text === '..') return [next(dirname(at))]
        const entry = join(at, text)
        return Entry.$match(entryAt(entry), {
          Missing: () => {
            asWritten()
            return []
          },
          Other: () => [next(entry)],
          Unreadable: ({ reason }) => {
            unreadable(entry, reason)
            return []
          },
          Link: ({ target }) => {
            if (isLast && last === 'kept') {
              landed.add(entry)
              return []
            }
            if (links === maxLinks) {
              unreadable(entry, 'it goes through too many links')
              return []
            }
            return [
              {
                at: isAbsolute(target) ? '/' : at,
                path: [...names(target), ...after],
                index: 0,
                links: links + 1,
              },
            ]
          },
        })
      },
      Wildcard: ({ climbs }) => {
        // A wildcard that matches nothing stays as it is written.
        asWritten()
        const climbed = climbs ? [next(dirname(at))] : []
        if (isLast && last === 'kept') return climbed
        return Listing.$match(listingOf(at), {
          Unreadable: ({ reason }) => {
            unreadable(at, reason)
            return climbed
          },
          Listed: ({ entries }) => [
            ...climbed,
            ...entries.map(name => ({
              ...walker,
              path: [Step.Name({ text: name }), ...after],
              index: 0,
            })),
          ],
        })
      },
    })
  }

  const pending: Array<Walker> = [{ at: '/', path, index: 0, links: 0 }]
  let taken = 0
  for (
    let walker = pending.pop();
    walker !== undefined;
    walker = pending.pop()
  ) {
    const next = step(walker)
    taken += next.length
    if (taken > maxSteps) {
      unknown.add(`${unglobbed(path)} reaches more than the gate follows`)
      break
    }
    pending.push(...next)
  }
  return [
    ...[...landed].map(place => Place.At({ path: place })),
    ...[...unknown].map(reason => Place.Unknown({ reason })),
  ]
}

/** `path`, absolute, as the file system reads it, a link it ends in followed; as given where it can't be read. */
export const realFolder = (path: string): string => {
  const [place] = walk(names(path), 'followed')
  return place !== undefined && Place.$is('At')(place) ? place.path : path
}

/** Where one alternative lands, from `from` where it is relative: as the system reads it, and with `..` taken off first. */
const walked = (
  from: string,
  path: ReadonlyArray<Step>,
  last: LastLink,
): ReadonlyArray<Place> => {
  const whole = [...names(from), ...path]
  return [...walk(whole, last), ...walk(lexically(whole), last)]
}

/** Where one alternative lands: more than one place where a wildcard or a link's `..` can land apart. */
const locate = (
  alternative: string,
  context: PathContext,
  last: LastLink,
): ReadonlyArray<Place> => {
  const path = steps(alternative)
  const text = unglobbed(path)
  if (text === '~' || text.startsWith('~/'))
    return Option.match(context.home, {
      onNone: () => [Place.Unknown({ reason: 'the home folder isn’t known' })],
      onSome: home => walked(home, path.slice(1), last),
    })
  if (text.startsWith('~'))
    return [
      Place.Unknown({
        reason: `${text.split('/')[0]} is another user’s home folder`,
      }),
    ]
  if (isAbsolute(text)) return walked('/', path, last)
  return Option.match(context.cwd, {
    onNone: () => [
      Place.Unknown({
        reason: `${text} is relative to a folder the gate can't tell`,
      }),
    ],
    onSome: cwd => walked(cwd, path, last),
  })
}

/** Where each alternative of `pattern`, a path or a shell glob in its escaped form, lands. */
export const locations = (
  pattern: string,
  context: PathContext,
  last: LastLink = 'followed',
): Locations =>
  Expansion.$match(expandBraces(pattern), {
    Refused: ({ reason }) => Locations.Refused({ reason }),
    Expanded: ({ alternatives }) =>
      Locations.Located({
        places: alternatives.flatMap(alternative =>
          locate(alternative, context, last),
        ),
      }),
  })

/** Where `pattern`, a path or a shell glob in its escaped form, lands: outside where any alternative does. */
export const confine = (
  pattern: string,
  context: PathContext,
  last: LastLink = 'followed',
): Confinement =>
  Locations.$match(locations(pattern, context, last), {
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
