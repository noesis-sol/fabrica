// scripts/release-notes.ts: a release's changelog (spec §22.5). Each ticket's entry is a file of its own,
// `changes/<ticket>.md`, until a release gathers them into its section of CHANGELOG.md, and that section,
// cut to fit, is the GitHub Release's notes (.github/workflows/release.yml).
//
//   node scripts/release-notes.ts <version>                    prints the version's notes
//   node scripts/release-notes.ts --gather <version> [<date>]  makes the release commit's changes
//
// The notes are the version's section, without its heading. GitHub refuses a Release's notes over
// 125,000 characters (tutti's first, 253,019), so a longer section is cut after the last whole entry
// within 120,000, and a last line says how many entries are left and links to CHANGELOG.md at the
// version's tag, in GITHUB_REPOSITORY (noesis-sol/fabrica outside GitHub Actions). Lengths are counted
// in UTF-16 code units, never fewer than GitHub's characters.
//
// --gather writes the version's section, `## [X.Y.Z] - YYYY-MM-DD` (today's date in UTC by default),
// above the last release's, from every file under changes/, in their tickets' order; removes those files;
// and sets the version of the package.json files that carry the release's (VERSIONED_MANIFESTS). Commit
// that alone as `Release X.Y.Z` (scripts/release-commit.sh). It refuses a version that has a section
// already, or when there is no change to gather.
//
// Node runs this file itself, stripping its types.
import { Clock, Data, Effect, Option } from 'effect'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import * as NodePath from 'node:path'

/** The most characters of notes made: GitHub's limit is 125,000. */
export const NOTES_LIMIT = 120_000

/** The repository the notes link to outside GitHub Actions (spec §20.5). */
export const DEFAULT_REPOSITORY = 'noesis-sol/fabrica'

/** The folder of the change files, one per ticket. */
export const CHANGES_FOLDER = 'changes'

export const CHANGELOG = 'CHANGELOG.md'

/**
 * The package.json files whose version is the release's: the repository's, and the engine's, which
 * `fabrica --version` prints and the distribution's archives are named after.
 */
export const VERSIONED_MANIFESTS = ['package.json', 'apps/engine/package.json']

/** The changelog's opening, written where there is no CHANGELOG.md yet. */
export const CHANGELOG_TITLE =
  '# Changelog\n\nEach release of Fabrica, newest first. Until a release gathers them here, each ' +
  "ticket's entry is a file of its own under `changes/` (spec §22.5).\n"

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** A release's version, `X.Y.Z` or a pre-release's `X.Y.Z-<suffix>`, from it or its tag (`vX.Y.Z`). */
export const versionOf = (text: string): Option.Option<string> => {
  const version = text.startsWith('v') ? text.slice(1) : text
  return VERSION.test(version) ? Option.some(version) : Option.none()
}

/** A version's heading in CHANGELOG.md. */
export const headingOf = ({
  version,
  date,
}: {
  readonly version: string
  readonly date: string
}): string => `## [${version}] - ${date}`

const isVersionHeading = (line: string): boolean => line.startsWith('## ')

/**
 * The version's section of the changelog: the lines after its heading up to the next version's, blank
 * lines at its ends left out; none where it has no section, or an empty one.
 */
export const versionSection = (
  changelog: string,
  version: string,
): Option.Option<string> => {
  const lines = changelog.split('\n')
  const heading = `## [${version}]`
  const start = lines.findIndex(
    line => line === heading || line.startsWith(`${heading} `),
  )
  if (start === -1) return Option.none()
  const after = lines.slice(start + 1)
  const end = after.findIndex(isVersionHeading)
  const section = (end === -1 ? after : after.slice(0, end)).join('\n').trim()
  return section === '' ? Option.none() : Option.some(section)
}

const startsEntry = (line: string): boolean =>
  line.startsWith('- ') || line.startsWith('#')

/**
 * A section's entries: each item of its list (a line starting `- `) or heading (`#`), with the lines
 * under it up to the next, blank lines at its end left out.
 */
export const entriesOf = (section: string): ReadonlyArray<string> => {
  const entries: Array<Array<string>> = []
  for (const line of section.split('\n')) {
    const open = entries.at(-1)
    if (open === undefined || startsEntry(line)) entries.push([line])
    else open.push(line)
  }
  return entries.map(lines => lines.join('\n').trimEnd())
}

/** The line ending notes cut short: how many entries are left out, and where they all are. */
export const restLine = ({
  left,
  link,
}: {
  readonly left: number
  readonly link: string
}): string =>
  `…and ${left} more ${left === 1 ? 'entry' : 'entries'}, past what a GitHub Release's notes hold: ` +
  `every change is in ${link}`

/**
 * The notes of a section: the whole section where it fits in `limit`; else its first entries, as many as
 * fit with the line linking to the rest after them.
 */
export const cutNotes = ({
  section,
  limit,
  link,
}: {
  readonly section: string
  readonly limit: number
  readonly link: string
}): string => {
  if (section.length <= limit) return section
  const entries = entriesOf(section)
  // The notes keeping the first `kept` entries are as long as they are, a line break between each two,
  // a blank line, and the line linking to the rest.
  const restLength = (kept: number) =>
    restLine({ left: entries.length - kept, link }).length
  let kept = 0
  let length = 0
  while (kept < entries.length) {
    const longer = length + (entries[kept]?.length ?? 0) + (kept === 0 ? 0 : 1)
    const fits =
      kept + 1 === entries.length
        ? longer <= limit
        : longer + 2 + restLength(kept + 1) <= limit
    if (!fits) break
    kept += 1
    length = longer
  }
  const shown = entries.slice(0, kept).join('\n')
  if (kept === entries.length) return shown
  const rest = restLine({ left: entries.length - kept, link })
  return kept === 0 ? rest : `${shown}\n\n${rest}`
}

/** Where a version's whole changelog is: CHANGELOG.md at its tag. */
export const changelogLink = ({
  repository,
  version,
}: {
  readonly repository: string
  readonly version: string
}): string => `https://github.com/${repository}/blob/v${version}/${CHANGELOG}`

/** A version's release notes, cut to `limit`; none where the changelog has no section for it. */
export const releaseNotes = ({
  changelog,
  version,
  repository,
  limit = NOTES_LIMIT,
}: {
  readonly changelog: string
  readonly version: string
  readonly repository: string
  readonly limit?: number
}): Option.Option<string> =>
  Option.map(versionSection(changelog, version), section =>
    cutNotes({
      section,
      limit,
      link: changelogLink({ repository, version }),
    }),
  )

/** A ticket's change file: its name under changes/, and its text. */
export interface ChangeFile {
  readonly name: string
  readonly text: string
}

const tickets = new Intl.Collator('en', { numeric: true })

/** How gathering the change files into the changelog went. */
export type Gathered = Data.TaggedEnum<{
  /** The changelog with the version's section in it. */
  Written: { readonly changelog: string }
  /** The version has a section already. */
  AlreadyReleased: {}
  /** There is no change file to gather. */
  NothingToGather: {}
}>

export const Gathered = Data.taggedEnum<Gathered>()

/**
 * The changelog with the version's section, made of the change files in their tickets' order (numbers
 * compared as numbers: fab-mgi.3.2 before fab-mgi.3.10), above the last version's section.
 */
export const gatherChangelog = ({
  changelog,
  changes,
  version,
  date,
}: {
  /** CHANGELOG.md's text, where there is one. */
  readonly changelog: Option.Option<string>
  readonly changes: ReadonlyArray<ChangeFile>
  readonly version: string
  readonly date: string
}): Gathered => {
  const text = Option.getOrElse(changelog, () => CHANGELOG_TITLE)
  if (text.split('\n').some(line => line.startsWith(`## [${version}]`)))
    return Gathered.AlreadyReleased()
  const entries = changes
    .toSorted((a, b) => tickets.compare(a.name, b.name))
    .map(change => change.text.trim())
    .filter(entry => entry !== '')
  if (entries.length === 0) return Gathered.NothingToGather()
  const section = `${headingOf({ version, date })}\n\n${entries.join('\n')}\n`
  const lines = text.split('\n')
  const last = lines.findIndex(isVersionHeading)
  const head = (last === -1 ? lines : lines.slice(0, last)).join('\n').trimEnd()
  const tail =
    last === -1 ? '' : `\n${lines.slice(last).join('\n').trimEnd()}\n`
  return Gathered.Written({ changelog: `${head}\n\n${section}${tail}` })
}

/** A package.json's text with its version set to `version`; none where it has no version. */
export const setVersion = (
  manifest: string,
  version: string,
): Option.Option<string> => {
  const field = /^(\s*"version":\s*)"[^"]*"/m
  return field.test(manifest)
    ? Option.some(
        manifest.replace(field, (_, key: string) => `${key}"${version}"`),
      )
    : Option.none()
}

const usage =
  'usage: node scripts/release-notes.ts <version>\n' +
  '       node scripts/release-notes.ts --gather <version> [<YYYY-MM-DD>]\n'

const readOption = (path: string): Option.Option<string> => {
  try {
    return Option.some(readFileSync(path, 'utf8'))
  } catch {
    return Option.none()
  }
}

const fail = (message: string): number => {
  process.stderr.write(`release-notes: ${message}\n`)
  return 1
}

const printNotes = (root: string, version: string): number => {
  const changelog = readOption(NodePath.join(root, CHANGELOG))
  const notes = Option.flatMap(changelog, text =>
    releaseNotes({
      changelog: text,
      version,
      repository: process.env['GITHUB_REPOSITORY'] ?? DEFAULT_REPOSITORY,
    }),
  )
  return Option.match(notes, {
    onNone: () =>
      fail(`${CHANGELOG} has no notes for ${version} under '## [${version}]'`),
    onSome: text => {
      process.stdout.write(`${text}\n`)
      return 0
    },
  })
}

const gather = (root: string, version: string, date: string): number => {
  const folder = NodePath.join(root, CHANGES_FOLDER)
  const names = Option.getOrElse(
    Option.liftThrowable(() => readdirSync(folder))(),
    () => [],
  ).filter(name => name.endsWith('.md'))
  const changes = names.map(name => ({
    name,
    text: readFileSync(NodePath.join(folder, name), 'utf8'),
  }))
  const manifests = VERSIONED_MANIFESTS.map(path => ({
    path: NodePath.join(root, path),
    text: setVersion(readFileSync(NodePath.join(root, path), 'utf8'), version),
  }))
  const unversioned = manifests.filter(({ text }) => Option.isNone(text))
  if (unversioned.length > 0)
    return fail(
      `${unversioned.map(({ path }) => NodePath.relative(root, path)).join(', ')} has no "version" to set`,
    )
  return Gathered.$match(
    gatherChangelog({
      changelog: readOption(NodePath.join(root, CHANGELOG)),
      changes,
      version,
      date,
    }),
    {
      AlreadyReleased: () =>
        fail(`${CHANGELOG} has a section for ${version} already`),
      NothingToGather: () =>
        fail(`there is no change under ${CHANGES_FOLDER}/ to gather`),
      Written: ({ changelog }) => {
        writeFileSync(NodePath.join(root, CHANGELOG), changelog)
        for (const name of names) rmSync(NodePath.join(folder, name))
        for (const { path, text } of manifests)
          Option.map(text, manifest => writeFileSync(path, manifest))
        process.stdout.write(
          `${CHANGELOG}: ${headingOf({ version, date })}, from ${names.length} change files; ` +
            `version ${version} in ${VERSIONED_MANIFESTS.join(', ')}. Commit it as 'Release ${version}'.\n`,
        )
        return 0
      },
    },
  )
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Today's date in UTC, YYYY-MM-DD. */
const today = (): string =>
  Effect.runSync(
    Effect.map(Clock.currentTimeMillis, millis =>
      new Date(millis).toISOString().slice(0, 10),
    ),
  )

const main = (args: ReadonlyArray<string>): number => {
  const root = NodePath.dirname(import.meta.dirname)
  const [first, second, third, ...rest] = args
  if (first === '--gather' && second !== undefined && rest.length === 0) {
    const date = third ?? today()
    if (!DATE.test(date)) return fail(`${date} is not a date, YYYY-MM-DD`)
    return Option.match(versionOf(second), {
      onNone: () => fail(`${second} is not a version, X.Y.Z or X.Y.Z-<suffix>`),
      onSome: version => gather(root, version, date),
    })
  }
  if (first !== undefined && first !== '--gather' && second === undefined) {
    return Option.match(versionOf(first), {
      onNone: () => fail(`${first} is not a version, X.Y.Z or X.Y.Z-<suffix>`),
      onSome: version => printNotes(root, version),
    })
  }
  process.stderr.write(usage)
  return 2
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
