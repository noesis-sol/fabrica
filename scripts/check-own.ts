import { Data, Option } from 'effect'
// scripts/check-own.ts: a worker's check of its own change, the repository's check_own (spec §13.6,
// §23). Run it as `pnpm check:own`, or `node scripts/check-own.ts`, from anywhere in the worktree.
//
// It checks what the branch changed since it left main (FABRICA_OWN_BASE names another commit): its
// commits, what isn't committed yet and the untracked files git doesn't ignore. Each step prints
// SUITE: <name> as it starts, every step runs, and the last line is the verdict:
//   typecheck: each package a changed TypeScript or JSON file is in, and the packages that depend
//              on it (pnpm's --filter ...<package>), deleted files included; effect-tsgo tsc on
//              scripts/ when a file there changed
//   lint:      oxlint on the changed files
//   format:    oxfmt --check on the changed files
//   test:      Vitest on the test files the change touches (testsFor): those that changed, and those
//              that import a changed module at any depth, through relative imports and the
//              workspace's packages (@fabrica/contracts), or name a changed file by its path (a
//              fixture they read); a snapshot touches its test, and a file a project's
//              vitest.config.ts names (its setup file) touches every test of that project.
// Imports are read from the text, not resolved by a bundler, so a deleted module still counts for
// the files that import it. A type-only statement (import type … from, export type … from) doesn't
// count: it is erased, so the test runs the same whatever the module holds, and a type error a change
// causes in a test is the type check's to find. import { type X } … still counts, as
// verbatimModuleSyntax keeps it as an import.
// A change to the project's setup (isSetupFile: a package.json, the lockfile, a tsconfig, the
// linter's and formatter's settings and ignore files, the root vitest.config.ts,
// scripts/check-fast.sh) runs scripts/check-fast.sh whole instead, and so does a branch with no main
// to start from.
// The vendored source under repos/ (isVendored: Foldkit, Effect and Pi, spec §23) is read-only
// reference that no check covers, so a change there counts for nothing, its package.json files
// included.
//
// A pass is kept by tree (H89), under the worktree's own git dir, never tracked: the tree it ran on
// (HEAD's, with the uncommitted and untracked files) and the test files that passed there. A run on
// a tree that passed already reuses that pass and runs nothing, so committing what was checked keeps
// its pass. Otherwise the run stands on the last pass: the engine's, FABRICA_CHECK_OWN_PASSED_AT,
// where it gives one, else the last in this worktree. The steps look only at what changed since that
// pass's tree, and the tests leave out those that passed there and that nothing since touches
// (standOn), saying how many. A failed run keeps nothing, and the earlier passes stand.
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The changes that run scripts/check-fast.sh whole: the project's setup and its checks' settings. */
export const isSetupFile = (file: string): boolean =>
  /(^|\/)package\.json$/.test(file) ||
  /(^|\/)tsconfig[\w.-]*\.json$/.test(file) ||
  [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'mise.toml',
    '.oxlintrc.json',
    '.oxfmtrc.json',
    '.eslintignore',
    '.prettierignore',
    'vitest.config.ts',
    'scripts/check-fast.sh',
  ].includes(file)

const isModule = (file: string): boolean =>
  /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)

export const isTestFile = (file: string): boolean =>
  /\.(test|spec)\.tsx?$/.test(file)

/** A Vitest project's config, the root's left out: the root's names the projects. */
const isProjectConfig = (file: string): boolean =>
  file.endsWith('/vitest.config.ts')

/** An import, re-export, dynamic import or require in a module's text, its specifier the first group. */
const importPattern = /\b(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g

/**
 * A type-only import or re-export: import type X, import type { X }, import type * as X,
 * export type { X } and export type * (as X), each from a specifier. import type from "x" imports a
 * default named type, a value.
 */
const typeOnlyPattern =
  /\b(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|(?!from\s*["'])[\w$]+)\s*from\s*["'][^"'\n]+["']/g

/**
 * The specifiers a module's text imports, re-exports or requires, relative or not, leaving out
 * type-only statements, which are erased.
 */
export const specifiers = (source: string): ReadonlyArray<string> =>
  [...source.replace(typeOnlyPattern, '').matchAll(importPattern)].map(
    match => match[1] ?? '',
  )

/** A package of the workspace: its name, its folder and the files its exports name, by subpath. */
export interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly exports: ReadonlyMap<string, string>
}

/** The package a package.json's text describes, in `dir`, or none where it has no name. */
export const workspacePackage = (
  dir: string,
  text: string,
): Option.Option<WorkspacePackage> => {
  const manifest: unknown = JSON.parse(text)
  if (typeof manifest !== 'object' || manifest === null) return Option.none()
  const name = 'name' in manifest ? manifest.name : undefined
  if (typeof name !== 'string') return Option.none()
  const field = 'exports' in manifest ? manifest.exports : undefined
  const exports = new Map<string, string>()
  const target = (value: unknown): Option.Option<string> => {
    if (typeof value === 'string') return Option.some(value)
    if (typeof value !== 'object' || value === null) return Option.none()
    if ('import' in value) return target(value.import)
    if ('default' in value) return target(value.default)
    return Option.none()
  }
  const add = (subpath: string, value: unknown) =>
    Option.map(target(value), file =>
      exports.set(subpath, posix.join(dir, file)),
    )
  if (typeof field === 'string') add('.', field)
  else if (typeof field === 'object' && field !== null) {
    for (const [subpath, value] of Object.entries(field)) add(subpath, value)
  }
  return Option.some({ name, dir, exports })
}

/** What the import graph is read from: the repository's files, as of the tree being checked. */
export interface Sources {
  /** Each module's text, by repository-relative path. */
  readonly modules: ReadonlyMap<string, string>
  /** Every file there, modules or not. */
  readonly files: ReadonlySet<string>
  readonly packages: ReadonlyArray<WorkspacePackage>
}

/**
 * The repository-relative files a specifier in `from` may name: the one there, or, where none is,
 * every file it could be, so that a deleted module still counts for its importers. None for a package
 * outside the workspace.
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  sources: Sources,
): ReadonlyArray<string> => {
  const path = specifier.replace(/\?.*$/, '')
  if (path.startsWith('./') || path.startsWith('../')) {
    const bare = posix.normalize(posix.join(posix.dirname(from), path))
    if (bare.startsWith('../')) return []
    const stem = bare.replace(/\.(js|mjs|cjs|jsx)$/, '')
    const candidates = [
      bare,
      `${stem}.ts`,
      `${stem}.tsx`,
      `${bare}/index.ts`,
      `${bare}/index.tsx`,
    ]
    const present = candidates.find(file => sources.files.has(file))
    return present === undefined ? candidates : [present]
  }
  for (const { name, exports } of sources.packages) {
    if (path !== name && !path.startsWith(`${name}/`)) continue
    const target = exports.get(`.${path.slice(name.length)}`)
    return target === undefined ? [] : [target]
  }
  return []
}

/** A module's text with its imports taken out: the graph follows those, and they name no other path. */
const withoutImports = (source: string): string =>
  source.replace(importPattern, '')

/**
 * The texts that name `file` in `module` other than by importing it: its path in the repository, in
 * its package, and from the module's folder (./fixtures/a.json, ../renderer/index.html).
 */
export const pathMentions = (
  file: string,
  module: string,
  sources: Sources,
): ReadonlyArray<string> => {
  const fromModule = posix.relative(posix.dirname(module), file)
  const mentions = [
    file,
    fromModule.startsWith('../') ? fromModule : `./${fromModule}`,
  ]
  const home = sources.packages.find(({ dir }) => file.startsWith(`${dir}/`))
  if (home !== undefined) {
    const inPackage = file.slice(home.dir.length + 1)
    if (inPackage.includes('/')) mentions.push(inPackage)
  }
  return mentions
}

/** The modules that import, re-export or require each file, by its path. */
const importersOf = (
  sources: Sources,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const importers = new Map<string, Array<string>>()
  for (const [module, source] of sources.modules) {
    for (const specifier of specifiers(source)) {
      for (const target of resolveSpecifier(module, specifier, sources)) {
        const list = importers.get(target)
        if (list === undefined) importers.set(target, [module])
        else list.push(module)
      }
    }
  }
  return importers
}

/** The folder of each Vitest project, by its config's path. */
const projectsOf = (sources: Sources): ReadonlyMap<string, string> =>
  new Map(
    [...sources.modules.keys()]
      .filter(isProjectConfig)
      .map(config => [config, posix.dirname(config)]),
  )

/** Every test file of the projects, sorted. */
export const allTests = (sources: Sources): ReadonlyArray<string> => {
  const dirs = [...projectsOf(sources).values()]
  return [...sources.files]
    .filter(
      file => isTestFile(file) && dirs.some(dir => file.startsWith(`${dir}/`)),
    )
    .sort()
}

/** The test files a change touches, sorted (see the top of this file). */
export const testsFor = (
  changed: ReadonlyArray<string>,
  sources: Sources,
): ReadonlyArray<string> => {
  const every = allTests(sources)
  if (changed.includes('vitest.config.ts')) return every
  const importers = importersOf(sources)
  const touched = new Set<string>()
  const queue: Array<string> = []
  const touch = (file: string) => {
    if (touched.has(file)) return
    touched.add(file)
    queue.push(file)
  }
  const texts = [...sources.modules].map(
    ([module, source]) => [module, withoutImports(source)] as const,
  )
  for (const file of changed) {
    touch(file)
    const snapshot = /^(.*)\/__snapshots__\/([^/]+)\.snap$/.exec(file)
    if (snapshot !== null) touch(`${snapshot[1]}/${snapshot[2]}`)
    for (const [module, text] of texts) {
      if (module === file) continue
      const mentions = pathMentions(file, module, sources)
      if (mentions.some(mention => text.includes(mention))) touch(module)
    }
  }
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const importer of importers.get(file) ?? []) touch(importer)
  }
  // A project's config, or a file it names (a setup file), touches every test of the project.
  const projects = new Set<string>()
  for (const [config, dir] of projectsOf(sources)) {
    const text = withoutImports(sources.modules.get(config) ?? '')
    const names = (file: string) =>
      pathMentions(file, config, sources).some(mention =>
        text.includes(mention),
      )
    if (touched.has(config) || [...touched].some(names)) projects.add(dir)
  }
  return every.filter(
    test =>
      touched.has(test) ||
      [...projects].some(dir => test.startsWith(`${dir}/`)),
  )
}

/** A pass of check-own: the tree it ran on and the test files that passed there. */
export interface Pass {
  readonly tree: string
  readonly tests: ReadonlyArray<string>
}

const isTree = (text: string): boolean => /^[0-9a-f]{40,64}$/.test(text)

/** A pass read from its file's text, or none where the text isn't one. */
export const readPass = (text: string): Option.Option<Pass> => {
  try {
    const record: unknown = JSON.parse(text)
    if (typeof record !== 'object' || record === null) return Option.none()
    const tree = 'tree' in record ? record.tree : undefined
    const tests = 'tests' in record ? record.tests : undefined
    if (typeof tree !== 'string' || !isTree(tree)) return Option.none()
    if (!Array.isArray(tests)) return Option.none()
    const names = tests.filter(test => typeof test === 'string')
    return names.length === tests.length
      ? Option.some({ tree, tests: names })
      : Option.none()
  } catch {
    return Option.none()
  }
}

/** What a run does. */
export type Plan = Data.TaggedEnum<{
  /** The tree passed already: nothing runs. */
  Reused: { readonly pass: Pass }
  /** scripts/check-fast.sh whole, for the reason given. */
  Whole: { readonly reason: string }
  /** The steps, on what changed. */
  Steps: {
    /** The tree of the earlier pass the run stands on, or none: it starts from main. */
    readonly from: Option.Option<string>
    /** The files the type check, lint and format look at: changed since the pass stood on, or main. */
    readonly changed: ReadonlyArray<string>
    /** The test files to run. */
    readonly tests: ReadonlyArray<string>
    /** The test files the change touches that the earlier pass stands for, left out. */
    readonly standing: ReadonlyArray<string>
    /** The test files that hold at this tree should the run pass. */
    readonly passed: ReadonlyArray<string>
  }
}>
export const Plan = Data.taggedEnum<Plan>()

/** An earlier pass a run may stand on, with what changed between its tree and this one. */
export interface Earlier {
  readonly pass: Pass
  readonly since: ReadonlyArray<string>
}

/** A file of the vendored source under repos/, which the checks leave out (spec §23). */
export const isVendored = (file: string): boolean => file.startsWith('repos/')

const checked = (files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter(file => !isVendored(file))

/**
 * What a run on `tree` does, `sinceBase` being what changed since main: nothing on a tree that passed
 * already, the whole check after a change to the setup, else the steps on what changed since the
 * earlier pass (or main), and the tests the change since main touches but those that passed at the
 * earlier pass and that nothing since touches. Vendored files are left out of both changes.
 */
export const standOn = (input: {
  readonly tree: string
  readonly sinceBase: ReadonlyArray<string>
  readonly earlier: Option.Option<Earlier>
  readonly sources: Sources
}): Plan => {
  const { tree, sources } = input
  const sinceBase = checked(input.sinceBase)
  const earlier = Option.map(input.earlier, ({ pass, since }) => ({
    pass,
    since: checked(since),
  }))
  if (Option.isSome(earlier) && earlier.value.pass.tree === tree) {
    return Plan.Reused({ pass: earlier.value.pass })
  }
  const changed = Option.match(earlier, {
    onNone: () => sinceBase,
    onSome: ({ since }) => since,
  })
  const setup = changed.find(isSetupFile)
  if (setup !== undefined) {
    return Plan.Whole({ reason: `${setup} changed` })
  }
  const selection = testsFor(sinceBase, sources)
  const present = new Set(allTests(sources))
  const stands = Option.match(earlier, {
    onNone: () => new Set<string>(),
    onSome: ({ pass, since }) => {
      const touched = new Set(testsFor(since, sources))
      return new Set(
        pass.tests.filter(test => present.has(test) && !touched.has(test)),
      )
    },
  })
  const tests = selection.filter(test => !stands.has(test))
  return Plan.Steps({
    from: Option.map(earlier, ({ pass }) => pass.tree),
    changed,
    tests,
    standing: selection.filter(test => stands.has(test)),
    passed: [...new Set([...tests, ...stands])].sort(),
  })
}

/** The type checks a change needs: the packages it changed TypeScript or JSON in, and scripts/. */
export const typeChecks = (
  changed: ReadonlyArray<string>,
  packages: ReadonlyArray<WorkspacePackage>,
): { readonly packages: ReadonlyArray<string>; readonly scripts: boolean } => {
  const typed = changed.filter(file => /\.(ts|tsx|mts|cts|json)$/.test(file))
  return {
    packages: packages
      .filter(({ dir }) => typed.some(file => file.startsWith(`${dir}/`)))
      .map(({ name }) => name)
      .sort(),
    scripts: typed.some(file => file.startsWith('scripts/')),
  }
}

/** How git is run: the command, the repository's root and the environment. */
export interface Git {
  readonly command: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

/** git's output, trimmed, or none where it failed. */
export const git = (
  runner: Git,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
): Option.Option<string> => {
  const result = spawnSync(runner.command, args, {
    cwd: runner.cwd,
    env: { ...runner.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return result.status === 0 ? Option.some(result.stdout.trim()) : Option.none()
}

/**
 * The tree of the worktree as it is: HEAD's, with the changes not committed yet and the untracked
 * files git doesn't ignore, written through an index of its own, so the worktree's isn't touched.
 * A copy of that index starts it, so git hashes only the files changed since it was written.
 */
export const workingTree = (
  runner: Git,
  gitDir: string,
): Option.Option<string> => {
  const scratch = mkdtempSync(join(gitDir, 'fabrica-check-own-index-'))
  const index = join(scratch, 'index')
  const env = { GIT_INDEX_FILE: index }
  try {
    const own = git(runner, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ])
    if (Option.isSome(own) && existsSync(own.value)) {
      // The copy keeps the index's times, as the engine's worktreeTree does (fab-mgi.39): git takes an
      // entry whose file changed in the second the index was written as racily clean, and checks its
      // content, by the index file's mtime; a copy newer than such an edit would have a same-size one
      // taken as unchanged, and name the tree without it (fab-adb).
      const times = statSync(own.value)
      copyFileSync(own.value, index)
      utimesSync(index, times.atime, times.mtime)
    } else if (Option.isNone(git(runner, ['read-tree', 'HEAD'], env))) {
      return Option.none()
    }
    return Option.flatMap(git(runner, ['add', '--all'], env), () =>
      git(runner, ['write-tree'], env),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** The files changed between two trees or commits, deleted ones included; none where git can't tell. */
export const changedBetween = (
  runner: Git,
  from: string,
  to: string,
): Option.Option<ReadonlyArray<string>> =>
  Option.map(
    git(runner, [
      'diff',
      '--name-only',
      '--no-renames',
      '--end-of-options',
      from,
      to,
      '--',
    ]),
    output => output.split('\n').filter(file => file !== ''),
  )

/** Where the passes are kept: a file a tree, and the last pass's tree. */
export const passesDir = (gitDir: string): string =>
  join(gitDir, 'fabrica-check-own')

/** The pass kept for a tree, or none. */
export const keptPass = (gitDir: string, tree: string): Option.Option<Pass> => {
  if (!isTree(tree)) return Option.none()
  const file = join(passesDir(gitDir), `${tree}.json`)
  return existsSync(file)
    ? Option.filter(
        readPass(readFileSync(file, 'utf8')),
        pass => pass.tree === tree,
      )
    : Option.none()
}

/** The last pass kept in this worktree, or none. */
export const lastPass = (gitDir: string): Option.Option<Pass> => {
  const file = join(passesDir(gitDir), 'last')
  return existsSync(file)
    ? keptPass(gitDir, readFileSync(file, 'utf8').trim())
    : Option.none()
}

/** Keeps a pass, by its tree, as the last one. */
export const keepPass = (gitDir: string, pass: Pass): void => {
  const dir = passesDir(gitDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${pass.tree}.json`), `${JSON.stringify(pass)}\n`)
  writeFileSync(join(dir, 'last'), `${pass.tree}\n`)
}

/**
 * The pass a run stands on: the one kept for its own tree, else the one at the tree the engine
 * gives (FABRICA_CHECK_OWN_PASSED_AT), else the last one kept here. None where git no longer has its
 * tree.
 */
export const earlierPass = (input: {
  readonly runner: Git
  readonly gitDir: string
  readonly tree: string
  readonly passedAt: Option.Option<string>
}): Option.Option<Earlier> => {
  const { runner, gitDir, tree, passedAt } = input
  const pass = Option.orElse(keptPass(gitDir, tree), () =>
    Option.match(passedAt, {
      onNone: () => lastPass(gitDir),
      onSome: at => keptPass(gitDir, at),
    }),
  )
  return Option.flatMap(pass, pass =>
    Option.map(changedBetween(runner, pass.tree, tree), since => ({
      pass,
      since,
    })),
  )
}

/** The repository's modules, packages and files, read from the worktree. */
const readSources = (runner: Git): Sources => {
  const listed = Option.getOrElse(
    git(runner, [
      'ls-files',
      '-co',
      '--exclude-standard',
      '--',
      'apps',
      'packages',
      'scripts',
    ]),
    () => '',
  )
  const path = (file: string) => join(runner.cwd, file)
  const files = new Set(
    listed.split('\n').filter(file => file !== '' && existsSync(path(file))),
  )
  const modules = new Map(
    [...files]
      .filter(isModule)
      .map(file => [file, readFileSync(path(file), 'utf8')] as const),
  )
  const packages = [...files]
    .filter(file => /^(apps|packages)\/[^/]+\/package\.json$/.test(file))
    .flatMap(file =>
      Option.toArray(
        workspacePackage(posix.dirname(file), readFileSync(path(file), 'utf8')),
      ),
    )
  return { modules, files, packages }
}

const count = (n: number, what: string): string =>
  `${n} ${what}${n === 1 ? '' : 's'}`

/** Runs a step's command with its output shown; whether it passed. */
const run = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string,
  args: ReadonlyArray<string>,
): boolean =>
  spawnSync(command, args, { cwd, env, stdio: 'inherit' }).status === 0

const main = (): number => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (env['FABRICA_CORES'] === undefined && env['TUTTI_CORES'] !== undefined) {
    env['FABRICA_CORES'] = env['TUTTI_CORES']
  }
  const runner: Git = { command: 'git', cwd, env }
  const passedAt = Option.fromNullishOr(env['FABRICA_CHECK_OWN_PASSED_AT'])
  const gitDir = git(runner, ['rev-parse', '--absolute-git-dir'])
  const tree = Option.flatMap(gitDir, dir => workingTree(runner, dir))
  const base = Option.orElse(
    Option.fromNullishOr(env['FABRICA_OWN_BASE']),
    () => git(runner, ['merge-base', 'HEAD', 'main']),
  )
  const sources = readSources(runner)
  const whole = (reason: string) => Plan.Whole({ reason })
  const plan: Plan = Option.match(Option.all({ gitDir, tree, base }), {
    onNone: () =>
      whole(
        Option.isNone(base)
          ? 'no main to start from'
          : 'git could not give the worktree its tree',
      ),
    onSome: ({ gitDir, tree, base }) =>
      Option.match(changedBetween(runner, base, tree), {
        onNone: () => whole(`git could not diff from ${base}`),
        onSome: sinceBase =>
          standOn({
            tree,
            sinceBase,
            earlier: earlierPass({ runner, gitDir, tree, passedAt }),
            sources,
          }),
      }),
  })

  const failed: Array<string> = []
  const step = (name: string, body: () => boolean) => {
    console.log(`SUITE: ${name}`)
    if (!body()) failed.push(name)
  }
  const tool = (args: ReadonlyArray<string>) =>
    run(cwd, env, 'pnpm', ['exec', ...args])
  const holds: ReadonlyArray<string> = Plan.$match(plan, {
    Reused: ({ pass }) => {
      console.log(
        `check-own: this tree passed already (${pass.tree.slice(0, 7)}): nothing to run.`,
      )
      return pass.tests
    },
    Whole: ({ reason }) => {
      console.log(`check-own: ${reason}: running scripts/check-fast.sh whole`)
      if (!run(cwd, env, join(cwd, 'scripts/check-fast.sh'), [])) {
        failed.push('scripts/check-fast.sh')
      }
      return allTests(sources)
    },
    Steps: ({ from, changed, tests, standing, passed }) => {
      const since = Option.match(from, {
        onNone: () => 'main',
        onSome: at => `the pass at ${at.slice(0, 7)}`,
      })
      console.log(`check-own: changed since ${since}:`)
      console.log(
        changed.length === 0
          ? '  nothing'
          : changed.map(f => `  ${f}`).join('\n'),
      )
      const present = changed.filter(file => sources.files.has(file))
      const checks = typeChecks(changed, sources.packages)
      step('typecheck', () => {
        if (checks.packages.length === 0 && !checks.scripts) {
          console.log('typecheck: no TypeScript or JSON file changed')
          return true
        }
        const cores = env['FABRICA_CORES'] ?? '4'
        const packages =
          checks.packages.length === 0 ||
          run(cwd, env, 'pnpm', [
            `--workspace-concurrency=${cores}`,
            ...checks.packages.flatMap(name => ['--filter', `...${name}`]),
            'run',
            'typecheck',
          ])
        const scripts =
          !checks.scripts ||
          tool([
            'effect-tsgo',
            'tsc',
            '--noEmit',
            '-p',
            'scripts/tsconfig.json',
          ])
        return packages && scripts
      })
      step('lint', () =>
        present.length === 0
          ? true
          : tool([
              'oxlint',
              '--deny-warnings',
              '--no-error-on-unmatched-pattern',
              ...present,
            ]),
      )
      step('format', () =>
        present.length === 0
          ? true
          : tool([
              'oxfmt',
              '--check',
              '--no-error-on-unmatched-pattern',
              ...present,
            ]),
      )
      step('test', () => {
        if (standing.length > 0) {
          console.log(
            `check-own: ${count(standing.length, 'test file')} passed in ${since} ` +
              'and nothing since touches them.',
          )
        }
        if (tests.length === 0) {
          console.log('test: no test file to run')
          return true
        }
        return tool(['vitest', 'run', ...tests])
      })
      return passed
    },
  })

  if (failed.length > 0) {
    console.log(`check-own: FAIL in ${failed.join(', ')}`)
    return 1
  }
  Option.map(Option.all({ gitDir, tree }), ({ gitDir, tree }) =>
    keepPass(gitDir, { tree, tests: holds }),
  )
  console.log(
    `check-own: PASS${Option.match(tree, { onNone: () => '', onSome: t => ` at ${t}` })}`,
  )
  return 0
}

if (import.meta.main) process.exitCode = main()
