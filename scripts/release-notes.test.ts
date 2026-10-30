import { Effect, Option } from 'effect'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, layer } from '@effect/vitest'

import {
  Toolbox,
  layerToolbox,
  runCommandExit,
  tempFolder,
} from '../packages/testkit/src/index.ts'
import {
  CHANGELOG_TITLE,
  Gathered,
  NOTES_LIMIT,
  changelogLink,
  cutNotes,
  entriesOf,
  gatherChangelog,
  releaseNotes,
  restLine,
  setVersion,
  versionOf,
  versionSection,
} from './release-notes'

// The release's changelog (spec §22.5): a version's section as its notes, cut after the last whole entry
// within 120,000 characters with a line linking to the rest, and the change files, one per ticket,
// gathered into CHANGELOG.md at release.

const changelog = `# Changelog

Intro.

## [0.2.0] - 2026-11-02

- Second's first entry.
  Its second line.
- Second's other entry.

## [0.1.0] - 2026-10-30

- First's entry.
`

const link = 'https://github.com/noesis-sol/fabrica/blob/v0.3.0/CHANGELOG.md'

/** An entry of `length` characters, its first line `- <name>`, the rest under it. */
const entry = (name: string, length: number): string => {
  const head = `- ${name} `
  const body = 'x'.repeat(Math.max(0, length - head.length - 3))
  return `${head}\n  ${body}`.padEnd(length, 'y')
}

describe('a version', () => {
  it('is X.Y.Z or a pre-release, with or without its tag’s v', () => {
    expect(versionOf('0.1.0')).toEqual(Option.some('0.1.0'))
    expect(versionOf('v0.1.0-rc.1')).toEqual(Option.some('0.1.0-rc.1'))
    expect(versionOf('0.1')).toEqual(Option.none())
    expect(versionOf('v0.1.0 ')).toEqual(Option.none())
    expect(versionOf('latest')).toEqual(Option.none())
  })
})

describe("a version's section", () => {
  it('is the lines under its heading, to the next version’s', () => {
    expect(versionSection(changelog, '0.2.0')).toEqual(
      Option.some(
        "- Second's first entry.\n  Its second line.\n- Second's other entry.",
      ),
    )
    expect(versionSection(changelog, '0.1.0')).toEqual(
      Option.some("- First's entry."),
    )
  })

  it('is none for a version without one, or with an empty one', () => {
    expect(versionSection(changelog, '0.3.0')).toEqual(Option.none())
    expect(versionSection(changelog, '0.2')).toEqual(Option.none())
    expect(
      versionSection('## [0.3.0] - 2026-11-03\n\n## [0.2.0]\n- a\n', '0.3.0'),
    ).toEqual(Option.none())
  })

  it('has its items and headings as entries, each with the lines under it', () => {
    expect(entriesOf('- a\n  more\n\n### Fixed\n- b\n\n- c')).toEqual([
      '- a\n  more',
      '### Fixed',
      '- b',
      '- c',
    ])
  })
})

describe("a release's notes", () => {
  it('are the whole section where it fits', () => {
    const section = [entry('a', 60_000), entry('b', 59_999)].join('\n')
    expect(section.length).toBe(NOTES_LIMIT)
    expect(cutNotes({ section, limit: NOTES_LIMIT, link })).toBe(section)
  })

  it('are cut after the last whole entry within 120,000 characters, linking to the rest', () => {
    const entries = Array.from({ length: 300 }, (_, index) =>
      entry(`entry ${index}`, 997 + (index % 7)),
    )
    const section = entries.join('\n')
    expect(section.length).toBeGreaterThan(NOTES_LIMIT)
    const notes = cutNotes({ section, limit: NOTES_LIMIT, link })
    expect(notes.length).toBeLessThanOrEqual(NOTES_LIMIT)
    const [shown = '', rest] = notes.split('\n\n')
    const kept = shown.split('\n- ').length
    expect(shown).toBe(entries.slice(0, kept).join('\n'))
    expect(rest).toBe(restLine({ left: entries.length - kept, link }))
    expect(rest).toContain(link)
    // One more entry wouldn't have fitted.
    const longer = `${entries.slice(0, kept + 1).join('\n')}\n\n${restLine({ left: entries.length - kept - 1, link })}`
    expect(longer.length).toBeGreaterThan(NOTES_LIMIT)
  })

  it('keep the entry that reaches the limit exactly', () => {
    const rest = restLine({ left: 1, link })
    const first = entry('first', NOTES_LIMIT - rest.length - 2)
    const section = `${first}\n${entry('second', 1000)}`
    const notes = cutNotes({ section, limit: NOTES_LIMIT, link })
    expect(notes).toBe(`${first}\n\n${rest}`)
    expect(notes.length).toBe(NOTES_LIMIT)
  })

  it('are the line linking to the rest alone where the first entry is too long', () => {
    const section = `${entry('huge', NOTES_LIMIT + 5)}\n- small`
    expect(cutNotes({ section, limit: NOTES_LIMIT, link })).toBe(
      restLine({ left: 2, link }),
    )
  })

  it('count a character past the basic plane as two', () => {
    const notes = cutNotes({
      section: `- ${'😀'.repeat(30)}\n- b`,
      limit: 40,
      link: 'L',
    })
    expect(notes).toBe(restLine({ left: 2, link: 'L' }))
  })

  it('link to CHANGELOG.md at the version’s tag', () => {
    expect(
      changelogLink({ repository: 'noesis-sol/fabrica', version: '0.3.0' }),
    ).toBe(link)
    expect(
      releaseNotes({
        changelog,
        version: '0.2.0',
        repository: 'noesis-sol/fabrica',
      }),
    ).toEqual(versionSection(changelog, '0.2.0'))
    expect(
      releaseNotes({
        changelog,
        version: '0.3.0',
        repository: 'noesis-sol/fabrica',
      }),
    ).toEqual(Option.none())
  })
})

describe('gathering the change files', () => {
  const changes = [
    { name: 'fab-mgi.3.10.md', text: '- Tenth.\n' },
    {
      name: 'fab-mgi.3.2.md',
      text: '- Second.\n  More of it.\n- Its other.\n',
    },
    { name: 'fab-mgi.9.md', text: '\n' },
  ]

  it('puts the version’s section above the last release’s, in the tickets’ order', () => {
    expect(
      gatherChangelog({
        changelog: Option.some(changelog),
        changes,
        version: '0.3.0',
        date: '2026-11-04',
      }),
    ).toEqual(
      Gathered.Written({
        changelog: changelog.replace(
          '## [0.2.0]',
          () =>
            '## [0.3.0] - 2026-11-04\n\n- Second.\n  More of it.\n- Its other.\n- Tenth.\n\n## [0.2.0]',
        ),
      }),
    )
  })

  it('starts the changelog where there is none', () => {
    const gathered = gatherChangelog({
      changelog: Option.none(),
      changes,
      version: '0.1.0-rc.1',
      date: '2026-11-04',
    })
    expect(gathered).toEqual(
      Gathered.Written({
        changelog: `${CHANGELOG_TITLE}\n## [0.1.0-rc.1] - 2026-11-04\n\n- Second.\n  More of it.\n- Its other.\n- Tenth.\n`,
      }),
    )
  })

  it('refuses a version released already, or nothing to gather', () => {
    expect(
      gatherChangelog({
        changelog: Option.some(changelog),
        changes,
        version: '0.2.0',
        date: '2026-11-04',
      }),
    ).toEqual(Gathered.AlreadyReleased())
    expect(
      gatherChangelog({
        changelog: Option.some(changelog),
        changes: [{ name: 'fab-mgi.9.md', text: '\n' }],
        version: '0.3.0',
        date: '2026-11-04',
      }),
    ).toEqual(Gathered.NothingToGather())
  })

  it("sets a package.json's version, and only that", () => {
    const manifest =
      '{\n  "name": "fabrica",\n  "version": "0.0.0",\n  "x": "0.0.0"\n}\n'
    expect(setVersion(manifest, '0.1.0')).toEqual(
      Option.some(
        '{\n  "name": "fabrica",\n  "version": "0.1.0",\n  "x": "0.0.0"\n}\n',
      ),
    )
    expect(setVersion('{ "name": "x" }', '0.1.0')).toEqual(Option.none())
  })
})

const repository = join(import.meta.dirname, '..')

/** A package.json, of a module package as the repository's are. */
const manifest = (name: string) =>
  `{\n  "name": "${name}",\n  "version": "0.0.0",\n  "type": "module"\n}\n`

/** A repository of the test's holding the script, its changelog and change files, and its manifests. */
const fixture = Effect.fn(function* (given: Record<string, string>) {
  const files = { 'package.json': manifest('fabrica'), ...given }
  const root = yield* tempFolder('release-notes')
  yield* Effect.promise(async () => {
    await mkdir(join(root, 'scripts'))
    await cp(
      join(repository, 'scripts', 'release-notes.ts'),
      join(root, 'scripts', 'release-notes.ts'),
    )
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'))
    for (const [name, text] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true })
      await writeFile(join(root, name), text)
    }
  })
  return root
})

layer(layerToolbox({ tools: ['node'] }))('the script', it => {
  const script = (
    root: string,
    args: ReadonlyArray<string>,
    vars: Record<string, string> = {},
  ) =>
    Effect.gen(function* () {
      const tools = yield* Toolbox
      return yield* runCommandExit({
        command: 'node',
        args: ['scripts/release-notes.ts', ...args],
        cwd: root,
        env: tools.env(vars),
      })
    })

  it.effect(
    "prints a version's notes, linking to the repository it runs for",
    () =>
      Effect.gen(function* () {
        const root = yield* fixture({ 'CHANGELOG.md': changelog })
        const printed = yield* script(root, ['v0.2.0'], {
          GITHUB_REPOSITORY: 'someone/fork',
        })
        expect(printed).toEqual({
          code: 0,
          stdout:
            "- Second's first entry.\n  Its second line.\n- Second's other entry.\n",
          stderr: '',
        })
        const missing = yield* script(root, ['0.3.0'])
        expect(missing.code).toBe(1)
        expect(missing.stderr).toBe(
          "release-notes: CHANGELOG.md has no notes for 0.3.0 under '## [0.3.0]'\n",
        )
        const usage = yield* script(root, [])
        expect(usage.code).toBe(2)
      }),
  )

  it.effect('gathers the change files into the release commit’s changes', () =>
    Effect.gen(function* () {
      const root = yield* fixture({
        'CHANGELOG.md': changelog,
        'changes/fab-mgi.3.2.md': '- Second.\n',
        'changes/fab-mgi.3.10.md': '- Tenth.\n',
        'package.json': manifest('fabrica'),
        'apps/engine/package.json': manifest('@fabrica/engine-app'),
        'apps/desktop/package.json': manifest('@fabrica/desktop'),
        'packages/ui/package.json': manifest('@fabrica/ui'),
      })
      const gathered = yield* script(root, ['--gather', '0.3.0', '2026-11-04'])
      expect(gathered.code).toBe(0)
      const read = (name: string) =>
        Effect.promise(() => readFile(join(root, name), 'utf8'))
      expect(yield* read('CHANGELOG.md')).toBe(
        changelog.replace(
          '## [0.2.0]',
          () => '## [0.3.0] - 2026-11-04\n\n- Second.\n- Tenth.\n\n## [0.2.0]',
        ),
      )
      expect(
        yield* Effect.promise(() => readdir(join(root, 'changes'))),
      ).toEqual([])
      expect(yield* read('package.json')).toContain('"version": "0.3.0"')
      expect(yield* read('apps/engine/package.json')).toContain(
        '"version": "0.3.0"',
      )
      expect(yield* read('apps/desktop/package.json')).toContain(
        '"version": "0.3.0"',
      )
      expect(yield* read('packages/ui/package.json')).toContain(
        '"version": "0.0.0"',
      )
      const again = yield* script(root, ['--gather', '0.3.0', '2026-11-04'])
      expect(again.code).toBe(1)
      expect(again.stderr).toBe(
        'release-notes: CHANGELOG.md has a section for 0.3.0 already\n',
      )
    }),
  )
})
