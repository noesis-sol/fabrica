import { Effect, Option } from 'effect'

import { describe, expect, it } from '@effect/vitest'

import {
  type Footprint,
  FootprintSource,
  type FootprintTicket,
  Overlap,
  type ReadSource,
  Shared,
  askedFiles,
  branchFootprint,
  checkFiles,
  codeIn,
  collapseAny,
  compileGlob,
  declaredBy,
  declaredIn,
  footprintParts,
  makeApartFiles,
  makeRepository,
  mentionsIn,
  namesFunctions,
  noMentions,
  overlap,
  placeName,
  readDeclared,
  readMentions,
  ticketFootprint,
  withChanges,
} from '../src/footprints'

// Footprints (spec §13.4, H70): files first, text only without them, functions only where the
// repository declares them and only in code, overlaps only on a file one ticket is to change, the
// files that hold nothing apart giving LIKELY_CONFLICT, and globs within their budget.

const tracked = [
  'Makefile',
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'docs/guide.md',
  'docs/spec.md',
  'docs/features.md',
  'scripts/check-fast.sh',
  'scripts/lint.sh',
  'scripts/test-rerun.ts',
  'src/loop.ts',
  'src/git.ts',
  'src/log.ts',
  'src/use.ts',
  'src/ready.ts',
  'src/ui/view.ts',
  'src/ui/theme.ts',
]
const repository = makeRepository(tracked)

const sources = new Map<string, string>([
  [
    'src/loop.ts',
    [
      'export class Loop {',
      '  merge(ticket: string): void {}',
      '}',
      'export const refreshBranch = () => 1',
    ].join('\n'),
  ],
  ['src/git.ts', 'export const status = () => 0\n'],
  [
    'src/log.ts',
    [
      '// refreshBranch is called by the loop',
      'console.log("refreshBranch failed")',
      'const line = `after ${status()}: refreshBranch`',
    ].join('\n'),
  ],
  ['src/use.ts', "import { refreshBranch } from './loop'\nrefreshBranch()\n"],
  ['src/ready.ts', 'export function ready() {}\n'],
  ['docs/guide.md', 'refreshBranch() is documented here.\n'],
  [
    'package.json',
    JSON.stringify({
      scripts: {
        test: 'node scripts/test-rerun.ts',
        lint: 'sh scripts/lint.sh && pnpm run lint',
      },
    }),
  ],
  [
    'scripts/check-fast.sh',
    [
      '#!/bin/sh',
      '# README.md says how to run it',
      '(echo "SUITE: unit" && pnpm run test) || status=1',
      'pnpm lint',
    ].join('\n'),
  ],
  ['scripts/lint.sh', 'oxlint\n'],
  ['Makefile', 'check:\n\tsh scripts/check-fast.sh\n'],
])

/** A reader of `sources`, keeping each path it was asked for. */
const reader = (): {
  readonly read: ReadSource
  readonly asked: Array<string>
} => {
  const asked: Array<string> = []
  return {
    asked,
    read: path =>
      Effect.sync(() => {
        asked.push(path)
        return Option.fromNullishOr(sources.get(path))
      }),
  }
}

const declared = declaredBy(sources)

const ticket = (fields: {
  readonly title: string
  readonly description?: string
  readonly acceptance?: string
  readonly files?: ReadonlyArray<string>
  readonly spec?: string
  readonly predicted?: ReadonlyArray<string>
  readonly labels?: ReadonlyArray<string>
}): FootprintTicket => ({
  ticket: {
    title: fields.title,
    description: Option.fromNullishOr(fields.description),
    design: Option.none(),
    acceptance: Option.fromNullishOr(fields.acceptance),
    metadata: {
      files: Option.fromNullishOr(fields.files),
      spec: Option.fromNullishOr(fields.spec),
      predicted_files: Option.fromNullishOr(fields.predicted),
      result_kind: Option.none(),
    },
  },
  labels: fields.labels ?? [],
})

const footprintOf = (fields: Parameters<typeof ticket>[0]): Footprint =>
  ticketFootprint({ ticket: ticket(fields), repository, declared })

const names = (footprint: Footprint) => ({
  source: footprint.source._tag,
  places: footprint.places.map(placeName),
  cited: footprint.cited,
  functions: footprint.functions,
  undeclared: footprint.undeclared,
})

const noneApart = makeApartFiles({ unioned: [], checks: [], shared: [] })

describe('a footprint', () => {
  it.each([
    {
      name: 'its files first, its text not read',
      fields: {
        title: 'Change src/git.ts and Loop.merge',
        description: 'Per docs/guide.md, touch src/use.ts too.',
        files: ['src/loop.ts', 'src/ui', 'src/new/thing.ts', 'src/**/*.css'],
      },
      expected: {
        source: 'Files',
        places: ['src/**/*.css', 'src/loop.ts', 'src/new/thing.ts', 'src/ui/'],
        cited: [],
        functions: [],
        undeclared: [],
      },
    },
    {
      name: 'its text only without files: tracked paths and capitalised or quoted bare names',
      fields: {
        title: 'Fix src/git.ts:12 and the Makefile',
        description:
          'Also `ready.ts`, but not ready.ts unquoted, nor src/missing.ts or /etc/passwd.',
      },
      expected: {
        source: 'Text',
        places: ['Makefile', 'src/git.ts', 'src/ready.ts'],
        cited: [],
        functions: [],
        undeclared: [],
      },
    },
    {
      name: 'a library name not counting, a declared function counting',
      fields: {
        title: 'Make Loop.merge call JSON.stringify()',
        description: 'Through `refreshBranch` and Effect.fn.',
      },
      expected: {
        source: 'Text',
        places: [],
        cited: [],
        functions: ['Loop.merge', 'refreshBranch'],
        undeclared: ['Effect.fn', 'JSON.stringify'],
      },
    },
    {
      name: 'a document cited, the spec too, one asked to change changed',
      fields: {
        title: 'Build the thing per docs/guide.md',
        description: 'As docs/spec.md has it. Update README.md with it.',
        spec: 'docs/spec.md',
      },
      expected: {
        source: 'Text',
        places: ['README.md'],
        cited: ['docs/guide.md', 'docs/spec.md'],
        functions: [],
        undeclared: [],
      },
    },
    {
      name: 'the predicted files where its text names nothing',
      fields: { title: 'Make it faster', predicted: ['src/loop.ts'] },
      expected: {
        source: 'Predicted',
        places: ['src/loop.ts'],
        cited: [],
        functions: [],
        undeclared: [],
      },
    },
    {
      name: 'nothing named',
      fields: { title: 'Think about it', files: [] },
      expected: {
        source: 'Nothing',
        places: [],
        cited: [],
        functions: [],
        undeclared: [],
      },
    },
  ])('$name', ({ fields, expected }) => {
    expect(names(footprintOf(fields))).toEqual(expected)
  })

  it('keeps its area labels, and its worktree changes while it runs', () => {
    const running = withChanges({
      footprint: footprintOf({
        title: 'x',
        files: ['src/loop.ts'],
        labels: ['area:ui', 'solo', 'area:'],
      }),
      changed: ['src/git.ts', './src/use.ts', '../outside.ts'],
      repository,
    })
    expect(running.areas).toEqual(['area:ui'])
    expect(running.changed).toEqual(['src/git.ts', 'src/use.ts'])
    expect(footprintParts(running)).toEqual([
      'src/git.ts',
      'src/loop.ts',
      'src/use.ts',
      'area:ui',
    ])
  })

  it('past its work, holds on its branch alone', () => {
    const past = branchFootprint({
      labels: [],
      changed: ['src/ready.ts'],
      repository,
    })
    expect(FootprintSource.$is('Branch')(past.source)).toBe(true)
    expect(footprintParts(past)).toEqual(['src/ready.ts', '(from its branch)'])
  })

  it('asks for the declarations only when its text names a function', () => {
    expect(
      namesFunctions({
        ticket: ticket({ title: 'Fix Loop.merge' }),
        repository,
      }),
    ).toBe(true)
    expect(
      namesFunctions({
        ticket: ticket({ title: 'Fix Loop.merge', files: ['src/loop.ts'] }),
        repository,
      }),
    ).toBe(false)
    expect(
      namesFunctions({
        ticket: ticket({ title: 'Fix src/loop.ts' }),
        repository,
      }),
    ).toBe(false)
  })
})

const tagOf = (result: Overlap): string =>
  Overlap.$match(result, {
    Clear: () => 'clear',
    LikelyConflict: ({ files }) => `likely conflict on ${files.join(', ')}`,
    Holds: ({ on }) =>
      Shared.$match(on, {
        Area: ({ label }) => `holds on ${label}`,
        Function: ({ name }) => `holds on ${name}`,
        Path: ({ name }) => `holds on ${name}`,
      }),
  })

describe('two footprints', () => {
  const apart = makeApartFiles({
    unioned: ['CHANGELOG.md'],
    checks: ['scripts/check-fast.sh'],
    shared: ['docs/features.md', '*.lock'],
  })
  it.each([
    {
      name: 'one file both change',
      a: { title: 'a', files: ['src/loop.ts'] },
      b: { title: 'b', files: ['src/loop.ts', 'src/git.ts'] },
      expected: 'holds on src/loop.ts',
    },
    {
      name: 'different files',
      a: { title: 'a', files: ['src/loop.ts'] },
      b: { title: 'b', files: ['src/git.ts'] },
      expected: 'clear',
    },
    {
      name: 'a folder holding a file',
      a: { title: 'a', files: ['src/ui'] },
      b: { title: 'b', files: ['src/ui/view.ts'] },
      expected: 'holds on src/ui/view.ts',
    },
    {
      name: 'a new folder holding a file added in it',
      a: { title: 'a', files: ['src/new'] },
      b: { title: 'b', files: ['src/new/thing.ts'] },
      expected: 'holds on src/new/thing.ts',
    },
    {
      name: 'a glob matching a file',
      a: { title: 'a', files: ['src/**/*.ts'] },
      b: { title: 'b', files: ['src/ui/theme.ts'] },
      expected: 'holds on src/ui/theme.ts',
    },
    {
      name: 'two globs that can match one file',
      a: { title: 'a', files: ['web/*.ts'] },
      b: { title: 'b', files: ['web/c*.ts'] },
      expected: 'holds on web/*.ts',
    },
    {
      name: 'two globs that cannot',
      a: { title: 'a', files: ['web/*.ts'] },
      b: { title: 'b', files: ['web/*.go'] },
      expected: 'clear',
    },
    {
      name: 'an area both have',
      a: { title: 'a', files: ['src/loop.ts'], labels: ['area:ui'] },
      b: { title: 'b', files: ['src/git.ts'], labels: ['area:ui'] },
      expected: 'holds on area:ui',
    },
    {
      name: 'a document both only cite',
      a: { title: 'Fix src/loop.ts per docs/guide.md' },
      b: { title: 'Fix src/git.ts, see docs/guide.md' },
      expected: 'clear',
    },
    {
      name: 'a document one cites and one changes',
      a: { title: 'Fix src/loop.ts per docs/guide.md' },
      b: { title: 'b', files: ['docs/guide.md'] },
      expected: 'holds on docs/guide.md',
    },
    {
      name: 'a function both name',
      a: { title: 'Fix Loop.merge' },
      b: { title: 'Speed up `merge()`' },
      expected: 'holds on Loop.merge',
    },
    {
      name: 'a library function both name',
      a: { title: 'Use JSON.stringify() in src/loop.ts' },
      b: { title: 'Use JSON.stringify() in src/git.ts' },
      expected: 'clear',
    },
    {
      name: 'shared_files giving LIKELY_CONFLICT',
      a: { title: 'a', files: ['docs/features.md', 'src/loop.ts'] },
      b: { title: 'b', files: ['docs/features.md', 'src/git.ts'] },
      expected: 'likely conflict on docs/features.md',
    },
    {
      name: 'a union-merged file and a check file giving LIKELY_CONFLICT',
      a: { title: 'a', files: ['CHANGELOG.md', 'scripts/check-fast.sh'] },
      b: { title: 'b', files: ['CHANGELOG.md', 'scripts/check-fast.sh'] },
      expected: 'likely conflict on CHANGELOG.md, scripts/check-fast.sh',
    },
    {
      name: 'a shared file beside one that holds',
      a: { title: 'a', files: ['docs/features.md', 'src/loop.ts'] },
      b: { title: 'b', files: ['docs/features.md', 'src/loop.ts'] },
      expected: 'holds on src/loop.ts',
    },
    {
      name: 'a shared glob as written',
      a: { title: 'a', files: ['pnpm.lock'] },
      b: { title: 'b', files: ['pnpm.lock'] },
      expected: 'likely conflict on pnpm.lock',
    },
  ])('$name: $expected', ({ a, b, expected }) => {
    expect(
      tagOf(
        overlap({
          a: footprintOf(a),
          b: footprintOf(b),
          mentions: noMentions,
          apart,
        }),
      ),
    ).toBe(expected)
  })

  it('a worktree change holds a ticket naming that file', () => {
    const running = withChanges({
      footprint: footprintOf({ title: 'a', files: ['src/loop.ts'] }),
      changed: ['src/git.ts'],
      repository,
    })
    expect(
      tagOf(
        overlap({
          a: footprintOf({ title: 'b', files: ['src/git.ts'] }),
          b: running,
          mentions: noMentions,
          apart: noneApart,
        }),
      ),
    ).toBe('holds on src/git.ts')
  })

  const named = footprintOf({ title: 'Rename refreshBranch()' })
  it.effect.each([
    {
      name: 'a function in a log string, a comment and a template not counting',
      files: ['src/log.ts'],
      expected: 'clear',
    },
    {
      name: 'a function its code calls counting',
      files: ['src/use.ts'],
      expected: 'holds on src/use.ts',
    },
    {
      name: 'a function the code under a folder mentions counting',
      files: ['src'],
      expected: 'holds on src/loop.ts',
    },
    {
      name: 'a function the code a glob matches mentions counting',
      files: ['src/u*.ts'],
      expected: 'holds on src/use.ts',
    },
    {
      name: 'a folder whose code never mentions it',
      files: ['src/ui'],
      expected: 'clear',
    },
    {
      name: 'a function a document names not counting',
      files: ['docs/guide.md'],
      expected: 'clear',
    },
  ])('$name', ({ files, expected }) =>
    Effect.gen(function* () {
      const other = footprintOf({ title: 'x', files })
      const mentions = yield* readMentions({
        pairs: [[named, other]],
        read: reader().read,
      })
      expect(
        tagOf(overlap({ a: named, b: other, mentions, apart: noneApart })),
      ).toBe(expected)
    }),
  )

  it.effect('reads contents only for pairs where one names a function', () =>
    Effect.gen(function* () {
      const plain = footprintOf({ title: 'a', files: ['src/loop.ts'] })
      const other = footprintOf({
        title: 'b',
        files: ['src/use.ts', 'docs/guide.md'],
      })
      const none = reader()
      yield* readMentions({ pairs: [[plain, other]], read: none.read })
      expect(none.asked).toEqual([])
      const some = reader()
      yield* readMentions({
        pairs: [
          [named, other],
          [plain, other],
        ],
        read: some.read,
      })
      expect(some.asked).toEqual(['src/use.ts'])
      // A folder's tracked source files are read for it.
      expect(
        askedFiles([[named, footprintOf({ title: 'c', files: ['src/ui'] })]]),
      ).toEqual(new Set(['src/ui/theme.ts', 'src/ui/view.ts']))
      // A pair already held apart by a function reads nothing either.
      expect(
        askedFiles([[named, footprintOf({ title: 'Call `refreshBranch`' })]]),
      ).toEqual(new Set())
    }),
  )
})

describe('a glob', () => {
  it('collapses a run of seven ** into one', () => {
    expect(collapseAny('**/**/**/**/**/**/**/x.ts')).toBe('**/x.ts')
    expect(collapseAny('a/**/**/b/**')).toBe('a/**/b/**')
    expect(compileGlob('./**/**/**/**/**/**/**/x.ts').text).toBe('**/x.ts')
  })

  it('matches seven ** apart within budget, remembering the ways that failed', () => {
    // Without the ways remembered, this miss takes some C(60, 7) tries.
    const glob = compileGlob('**/a/**/a/**/a/**/a/**/a/**/a/**/a/z')
    const deep = Array.from({ length: 60 }, () => 'a').join('/')
    expect(glob.matches(deep)).toBe(false)
    expect(glob.matches(`${deep}/z`)).toBe(true)
  })

  it.each([
    ['*.ts', 'loop.ts', true],
    ['*.ts', 'src/loop.ts', false],
    ['src/**/*.ts', 'src/loop.ts', true],
    ['src/**/*.ts', 'src/a/b/loop.ts', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/[a-c].ts', 'src/d.ts', false],
    ['src/[^a-c].ts', 'src/d.ts', true],
    ['src/\\*.ts', 'src/*.ts', true],
    ['src/[', 'src/[', false],
  ])('%s against %s: %s', (glob, path, expected) => {
    expect(compileGlob(glob).matches(path)).toBe(expected)
  })
})

describe('code', () => {
  it.each([
    [
      'src/a.ts',
      'f() // g\nconst s = "h" + `i ${j} k` /* l */\nconst r = /m/',
      ['f', 'const', 's', 'j', 'const', 'r'],
    ],
    ['src/a.py', 'f()  # g\ns = "h" + f"{j} i"\n', ['f', 's', 'j']],
    ['src/a.sh', 'f # g\necho "h $(j)" \'k\'\n', ['f', 'echo', 'j']],
    ['src/a.go', 'f() // g\ns := "h" + `i`\nc := \'k\'\n', ['f', 's', 'c']],
  ])('of %s leaves comments and strings out', (file, text, words) => {
    expect(codeIn(file, text).match(/[A-Za-z_]\w*/gu)).toEqual(words)
  })

  it('mentions a function in code alone, by its type and name', () => {
    const mentions = mentionsIn(sources)
    expect(mentions('src/use.ts', 'refreshBranch')).toBe(true)
    expect(mentions('src/log.ts', 'refreshBranch')).toBe(false)
    expect(mentions('src/loop.ts', 'Loop.merge')).toBe(true)
    expect(mentions('src/git.ts', 'Loop.merge')).toBe(false)
    expect(mentions('docs/guide.md', 'refreshBranch')).toBe(false)
  })

  it.each([
    ['export function merge() {}', ['merge']],
    [
      'export class Loop {\n  async merge(a: A): Promise<B> {\n}',
      ['Loop', 'merge'],
    ],
    ['  readonly files: ReadonlyArray<string>', ['files']],
    ['func (r *Repo) Merge(x int) {}', ['Merge']],
    ['def ready(self):', ['ready']],
    ['MAX_SIZE = 10', ['MAX_SIZE']],
    ['merge(a)\nif (x) {', []],
    ['import {\n  type Effect,\n}', []],
  ])('declared in %j: %j', (text, names) => {
    expect([...declaredIn(text)].sort()).toEqual([...names].sort())
  })

  it.effect('the declarations, read from the tracked source files alone', () =>
    Effect.gen(function* () {
      const { read, asked } = reader()
      const found = yield* readDeclared({ repository, read })
      expect(found.declares('Loop.merge')).toBe(true)
      expect(found.declares('JSON.stringify')).toBe(false)
      expect(
        asked.every(path => path.endsWith('.ts') || path.endsWith('.sh')),
      ).toBe(true)
    }),
  )
})

describe('the check files', () => {
  it.effect.each([
    {
      name: 'a script it names, and what the script runs through the manifest',
      commands: ['scripts/check-fast.sh'],
      // README.md is named in a comment of the script, and runs nothing.
      expected: [
        'scripts/check-fast.sh',
        'scripts/lint.sh',
        'scripts/test-rerun.ts',
      ],
    },
    {
      name: 'the Makefile make runs, and what its recipes run',
      commands: ['make check'],
      expected: [
        'Makefile',
        'scripts/check-fast.sh',
        'scripts/lint.sh',
        'scripts/test-rerun.ts',
      ],
    },
    {
      name: 'a manifest script',
      commands: ['pnpm test'],
      expected: ['scripts/test-rerun.ts'],
    },
  ])('$name', ({ commands, expected }) =>
    Effect.gen(function* () {
      const files = yield* checkFiles({
        commands,
        repository,
        read: reader().read,
      })
      expect([...files].sort()).toEqual(expected)
    }),
  )
})
