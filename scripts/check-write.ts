// scripts/check-write.ts: the checks after every agent write (spec §23): a type check and oxlint (with
// @foldkit/oxlint-plugin and the repository's own rules, lint-source.ts) on the files a write
// changed, their problems handed back to the agent in-band. Hooks, not prompts:
//   Claude Code: a PostToolUse hook in .claude/settings.json runs `node scripts/check-write.ts` after
//                Write, Edit and MultiEdit, the hook's JSON on stdin. Problems go to stderr with exit
//                status 2, which Claude Code gives the agent as the tool's feedback.
//   Pi:          the development-only package scripts/pi-checks, which .pi/settings.json loads, calls
//                checkWritten from a tool_result handler after write and edit, and adds the
//                problems to the tool's result.
// Only TypeScript and JavaScript modules are checked. The type check is that of the package holding
// the file, run as its typecheck script runs it (each tsconfig its -p names; the root's for a file in
// no package, scripts/ among them), and reports the diagnostics in the written files only: a change
// that breaks a module elsewhere is the check of the whole change's to find (pnpm check:own). oxlint
// runs on the written files, with .oxlintrc.json's settings. Both run side by side.
import { Data, Option } from 'effect'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The files the checks look at: TypeScript and JavaScript modules. */
export const isChecked = (file: string): boolean =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)

/** The repository-relative path of `path`, written from `cwd`, or none where it is outside `root`. */
export const inRepository = (
  root: string,
  cwd: string,
  path: string,
): Option.Option<string> => {
  const inside = relative(root, resolve(cwd, path))
  return inside === '' ||
    inside === '..' ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
    ? Option.none()
    : Option.some(inside.split(sep).join('/'))
}

/** A package's type checks: its folder ('' for the root) and the tsconfigs, repository-relative. */
export interface TypedPackage {
  readonly dir: string
  readonly tsconfigs: ReadonlyArray<string>
}

/** The tsconfigs a typecheck script names with -p (or --project), repository-relative from `dir`. */
export const tsconfigsOf = (
  dir: string,
  script: string,
): ReadonlyArray<string> =>
  [...script.matchAll(/(?:^|\s)(?:-p|--project)(?:\s+|=)([^\s&|;]+)/g)].map(
    match => posix.join(dir, match[1] ?? ''),
  )

/** The type checks a package.json's text names in its typecheck script, its package in `dir`. */
export const typedPackage = (dir: string, text: string): TypedPackage => {
  const manifest: unknown = JSON.parse(text)
  const scripts =
    typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
      ? manifest.scripts
      : undefined
  const script =
    typeof scripts === 'object' && scripts !== null && 'typecheck' in scripts
      ? scripts.typecheck
      : undefined
  return {
    dir,
    tsconfigs: typeof script === 'string' ? tsconfigsOf(dir, script) : [],
  }
}

/** The root's and the workspace's packages (apps/*, packages/*), read from the repository at `root`. */
export const readPackages = (root: string): ReadonlyArray<TypedPackage> => {
  const manifest = (dir: string) => join(root, dir, 'package.json')
  const dirs = ['apps', 'packages'].flatMap(group =>
    existsSync(join(root, group))
      ? readdirSync(join(root, group), { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => `${group}/${entry.name}`)
      : [],
  )
  return ['', ...dirs]
    .filter(dir => existsSync(manifest(dir)))
    .map(dir => typedPackage(dir, readFileSync(manifest(dir), 'utf8')))
}

/** The tsconfigs whose type checks see `file`: those of the package holding it, else the root's. */
export const tsconfigsFor = (
  file: string,
  packages: ReadonlyArray<TypedPackage>,
): ReadonlyArray<string> => {
  const holding = packages
    .filter(({ dir }) => dir === '' || file.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)
  return holding[0]?.tsconfigs ?? []
}

/** A check's diagnostic: the file it is in (none for one about no file) and its text. */
export interface Diagnostic {
  readonly file: Option.Option<string>
  readonly text: string
}

/**
 * effect-tsgo tsc's diagnostics in its --pretty false output: `file(line,col): error …`, any lines after it
 * indented. Effect's own (`effect(missingReturnYieldStar)`, …) come the same way, as errors or warnings.
 */
export const typeDiagnostics = (output: string): ReadonlyArray<Diagnostic> => {
  const diagnostics: Array<{ file: Option.Option<string>; lines: string[] }> =
    []
  for (const line of output.split('\n')) {
    const head = /^(.+?)\(\d+,\d+\): (?:error|warning) TS\d+/.exec(line)
    const last = diagnostics.at(-1)
    if (head !== null) {
      diagnostics.push({ file: Option.some(head[1] ?? ''), lines: [line] })
    } else if (/^(?:error|warning) TS\d+/.test(line)) {
      diagnostics.push({ file: Option.none(), lines: [line] })
    } else if (/^\s+\S/.test(line) && last !== undefined) {
      last.lines.push(line)
    }
  }
  return diagnostics.map(({ file, lines }) => ({
    file,
    text: lines.join('\n').trimEnd(),
  }))
}

/** oxlint's diagnostics in its unix output: `file:line:col: message [Severity/rule]`, a line each. */
export const lintDiagnostics = (output: string): ReadonlyArray<Diagnostic> =>
  output.split('\n').flatMap(line => {
    const head = /^(.+?):\d+:\d+: /.exec(line)
    return head === null
      ? []
      : [{ file: Option.some(head[1] ?? ''), text: line.trimEnd() }]
  })

/** How a command ended. */
export type Ran = Data.TaggedEnum<{
  /** It exited, with this code, having printed `output` (stdout and stderr). */
  Exited: { readonly code: number; readonly output: string }
  /** It didn't start, or a signal ended it. */
  Failed: { readonly reason: string }
}>
export const Ran = Data.taggedEnum<Ran>()

/** Runs a command from the repository's root. */
export type Run = (command: string, args: ReadonlyArray<string>) => Promise<Ran>

/** What a check found in the written files. */
export type Step = Data.TaggedEnum<{
  /** Nothing in the written files. */
  Passed: {}
  /** These problems. */
  Found: { readonly problems: ReadonlyArray<string> }
  /** The check couldn't run, for this reason. */
  NotRun: { readonly reason: string }
}>
export const Step = Data.taggedEnum<Step>()

/** A check after a write: its name and what it found. */
export interface Checked {
  readonly name: string
  readonly step: Step
}

/**
 * What a check's command found in `files`: nothing where it passed; else its diagnostics in those
 * files and those about no file, or its whole output where it printed none it could read.
 */
export const stepOf = (input: {
  readonly ran: Ran
  readonly root: string
  readonly files: ReadonlyArray<string>
  readonly diagnostics: (output: string) => ReadonlyArray<Diagnostic>
}): Step =>
  Ran.$match(input.ran, {
    Failed: ({ reason }) => Step.NotRun({ reason }),
    Exited: ({ code, output }) => {
      if (code === 0) return Step.Passed()
      const diagnostics = input.diagnostics(output)
      if (diagnostics.length === 0) {
        const text = output.trim()
        return Step.Found({
          problems: [text === '' ? `exited with ${code}` : text],
        })
      }
      const written = new Set(input.files)
      const problems = diagnostics
        .filter(({ file }) =>
          Option.match(file, {
            onNone: () => true,
            onSome: file =>
              Option.exists(inRepository(input.root, input.root, file), path =>
                written.has(path),
              ),
          }),
        )
        .map(({ text }) => text)
      return problems.length === 0 ? Step.Passed() : Step.Found({ problems })
    },
  })

/** The type checks and oxlint on the written `files` (repository-relative), side by side. */
export const checkWrite = (input: {
  readonly root: string
  readonly files: ReadonlyArray<string>
  readonly packages: ReadonlyArray<TypedPackage>
  readonly run: Run
  /** Where a tool of the repository's is: effect-tsgo, oxlint. */
  readonly bin: (tool: string) => string
}): Promise<ReadonlyArray<Checked>> => {
  const { root, packages, run, bin } = input
  const files = [...new Set(input.files.filter(isChecked))].sort()
  if (files.length === 0) return Promise.resolve([])
  const tsconfigs = [
    ...new Set(files.flatMap(file => tsconfigsFor(file, packages))),
  ].sort()
  const check = (
    name: string,
    command: string,
    args: ReadonlyArray<string>,
    diagnostics: (output: string) => ReadonlyArray<Diagnostic>,
  ): Promise<Checked> =>
    run(command, args).then(ran => ({
      name,
      step: stepOf({ ran, root, files, diagnostics }),
    }))
  return Promise.all([
    ...tsconfigs.map(tsconfig =>
      check(
        `type check (${tsconfig})`,
        bin('effect-tsgo'),
        ['tsc', '--noEmit', '--pretty', 'false', '-p', tsconfig],
        typeDiagnostics,
      ),
    ),
    check(
      'oxlint',
      bin('oxlint'),
      [
        '--deny-warnings',
        '--no-error-on-unmatched-pattern',
        '--format',
        'unix',
        ...files,
      ],
      lintDiagnostics,
    ),
  ])
}

/** The checks' report for the agent, or none where every check passed. */
export const report = (
  files: ReadonlyArray<string>,
  checks: ReadonlyArray<Checked>,
): Option.Option<string> => {
  const sections = checks.flatMap(({ name, step }) =>
    Step.$match(step, {
      Passed: () => [],
      Found: ({ problems }) => [`${name}:\n${problems.join('\n')}`],
      NotRun: ({ reason }) => [`${name} could not run: ${reason}`],
    }),
  )
  return sections.length === 0
    ? Option.none()
    : Option.some(
        `The checks after this write (spec §23) found problems in ${files.join(', ')}:\n\n` +
          `${sections.join('\n\n')}\n\nFix them before going on.`,
      )
}

/** Runs commands from `root`, in `env`, their stdout and stderr together. */
export const spawnRun =
  (root: string, env: NodeJS.ProcessEnv): Run =>
  (command, args) =>
    new Promise(done => {
      const child = spawn(command, args, {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks: Array<Buffer> = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.on('error', error =>
        done(Ran.Failed({ reason: `${command}: ${error.message}` })),
      )
      child.on('close', (code, signal) =>
        done(
          code === null
            ? Ran.Failed({
                reason: `${command} ended by ${signal ?? 'a signal'}`,
              })
            : Ran.Exited({
                code,
                output: Buffer.concat(chunks).toString('utf8'),
              }),
        ),
      )
    })

/** This repository's root: the folder above scripts/. */
export const repositoryRoot = (): string =>
  fileURLToPath(new URL('..', import.meta.url))

/**
 * The checks after a write of `paths`, written from `cwd`, in the repository at `root`: their report,
 * or none where they passed or nothing written is checked. Tools come from the repository's
 * node_modules/.bin unless `bin` says otherwise.
 */
export const checkWritten = async (input: {
  readonly root: string
  readonly cwd: string
  readonly paths: ReadonlyArray<string>
  readonly run: Run
  readonly bin?: (tool: string) => string
}): Promise<Option.Option<string>> => {
  const { cwd, run } = input
  // Links resolved on both sides, so a checkout reached through one (macOS's /var) still holds its files.
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path)
  const root = real(input.root)
  const files = input.paths.flatMap(path =>
    Option.toArray(inRepository(root, root, real(resolve(cwd, path)))),
  )
  const checks = await checkWrite({
    root,
    files,
    packages: readPackages(root),
    run,
    bin: input.bin ?? (tool => join(root, 'node_modules', '.bin', tool)),
  })
  return report(files.filter(isChecked), checks)
}

/** The file a Claude Code PostToolUse hook's input says the tool wrote, from the folder it ran in. */
export const claudeWritten = (
  payload: unknown,
): Option.Option<{ readonly cwd: string; readonly path: string }> => {
  if (typeof payload !== 'object' || payload === null) return Option.none()
  const cwd = 'cwd' in payload ? payload.cwd : undefined
  const tool = 'tool_input' in payload ? payload.tool_input : undefined
  const path =
    typeof tool === 'object' && tool !== null && 'file_path' in tool
      ? tool.file_path
      : undefined
  return typeof cwd === 'string' && typeof path === 'string'
    ? Option.some({ cwd, path })
    : Option.none()
}

const readStdin = async (): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** The Claude Code hook: 2, its report on stderr, where the checks found problems; else 0. */
const main = async (): Promise<number> => {
  const root = repositoryRoot()
  const written = claudeWritten(JSON.parse(await readStdin()))
  if (Option.isNone(written)) return 0
  const found = await checkWritten({
    root,
    cwd: written.value.cwd,
    paths: [written.value.path],
    run: spawnRun(root, process.env),
  })
  return Option.match(found, {
    onNone: () => 0,
    onSome: text => {
      process.stderr.write(`${text}\n`)
      return 2
    },
  })
}

if (import.meta.main) process.exitCode = await main()
