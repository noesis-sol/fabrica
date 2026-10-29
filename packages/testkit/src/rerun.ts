import { Data, Option, Schema } from 'effect'
import * as NodePath from 'node:path'

// Reruns of failed tests (spec §24, H55, H88): a file's failed tests are rerun together in one
// process, the files side by side; a test that passes on its rerun is reported flaky, and the suite
// passes. A test that timed out is rerun like any failure. An error between tests whose stack is in a
// test file goes with that file's rerun: with its failed tests' where it has some, or the whole file's
// (tutti-0vbd.4, -06a). An error no test file can be blamed for fails the suite: no rerun clears it.
//
// scripts/test-rerun.ts runs Vitest with `rerun-reporter.ts`, which writes a `RunReport` to the file
// `rerun-variable.ts` names, and decides with this module. Node loads this module itself: it imports
// no relative module.

/** One test file's results: its tests by full name (`suite > test`), and the errors outside its tests. */
export const ModuleReport = Schema.Struct({
  file: Schema.String,
  project: Schema.String,
  failed: Schema.Array(Schema.String),
  passed: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
})
export type ModuleReport = typeof ModuleReport.Type

/** An error Vitest caught between tests. */
export const UnhandledReport = Schema.Struct({
  message: Schema.String,
  stack: Schema.String,
})
export type UnhandledReport = typeof UnhandledReport.Type

/** What one Vitest process ran. */
export const RunReport = Schema.Struct({
  modules: Schema.Array(ModuleReport),
  unhandled: Schema.Array(UnhandledReport),
})
export type RunReport = typeof RunReport.Type

/** A report as the reporter wrote it; none for text that isn't one. */
export const decodeRunReport: (text: string) => Option.Option<RunReport> =
  Schema.decodeUnknownOption(Schema.fromJsonString(RunReport))

/** What a test file's rerun runs: its failed tests, or the whole file. */
export type Rerun = Data.TaggedEnum<{
  Tests: {
    readonly file: string
    readonly project: string
    readonly names: ReadonlyArray<string>
  }
  File: {
    readonly file: string
    readonly project: string
    readonly why: string
  }
}>
export const Rerun = Data.taggedEnum<Rerun>()

/** What follows a first run. */
export type Plan = Data.TaggedEnum<{
  /** Nothing failed. */
  Passed: {}
  /** These files are rerun. */
  Rerun: { readonly reruns: ReadonlyArray<Rerun> }
  /** Errors no test file can be blamed for: the suite fails, with no rerun. */
  Broken: { readonly errors: ReadonlyArray<UnhandledReport> }
}>
export const Plan = Data.taggedEnum<Plan>()

/** The test files an error's stack goes through. */
const blamed = (
  error: UnhandledReport,
  modules: ReadonlyArray<ModuleReport>,
): ReadonlyArray<ModuleReport> =>
  modules.filter(module => error.stack.includes(module.file))

/** The reruns a first run's report calls for. */
export const planReruns = (report: RunReport): Plan => {
  const unblamed = report.unhandled.filter(
    error => blamed(error, report.modules).length === 0,
  )
  if (unblamed.length > 0) return Plan.Broken({ errors: unblamed })
  const blamedFiles = new Set(
    report.unhandled.flatMap(error =>
      blamed(error, report.modules).map(module => module.file),
    ),
  )
  const reruns = report.modules.flatMap((module): ReadonlyArray<Rerun> => {
    const { file, project } = module
    if (module.errors.length > 0)
      return [Rerun.File({ file, project, why: 'an error outside its tests' })]
    if (module.failed.length > 0)
      return [Rerun.Tests({ file, project, names: module.failed })]
    if (blamedFiles.has(file))
      return [Rerun.File({ file, project, why: 'an error between tests' })]
    return []
  })
  return reruns.length === 0 ? Plan.Passed() : Plan.Rerun({ reruns })
}

/** A pattern for Vitest's `testNamePattern` matching exactly these full names. */
export const namePattern = (names: ReadonlyArray<string>): string =>
  `^(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`

/**
 * What a rerun's process runs: the first run's arguments for their options, their file filters
 * dropped, on the one file, in its project, and only its failed tests where they are named.
 */
export const RerunRequest = Schema.Struct({
  args: Schema.Array(Schema.String),
  file: Schema.String,
  project: Schema.String,
  testNamePattern: Schema.optionalKey(Schema.String),
})
export type RerunRequest = typeof RerunRequest.Type

/** The request that reruns `rerun` after a first run with `args`. */
export const rerunRequest = (
  rerun: Rerun,
  args: ReadonlyArray<string>,
): RerunRequest => ({
  args,
  file: rerun.file,
  project: rerun.project,
  ...Rerun.$match(rerun, {
    Tests: ({ names }) => ({ testNamePattern: namePattern(names) }),
    File: () => ({}),
  }),
})

/** A request as its process was given it; none for text that isn't one. */
export const decodeRerunRequest: (text: string) => Option.Option<RerunRequest> =
  Schema.decodeUnknownOption(Schema.fromJsonString(RerunRequest))

/** What became of a rerun test, or of a file rerun whole (`name` then says why it was). */
export type Outcome = Data.TaggedEnum<{
  Flaky: { readonly file: string; readonly name: string }
  Failed: { readonly file: string; readonly name: string }
}>
export const Outcome = Data.taggedEnum<Outcome>()

/** The outcomes of a rerun from its report; none where its process wrote none. */
export const judgeRerun = (
  rerun: Rerun,
  report: Option.Option<RunReport>,
): ReadonlyArray<Outcome> => {
  const module = Option.flatMap(report, ({ modules }) =>
    Option.fromNullishOr(modules.find(({ file }) => file === rerun.file)),
  )
  // Clean: the file ran, with no error outside its tests and none between them it can be blamed for.
  const clean = Option.exists(
    Option.all({ report, module }),
    r =>
      r.module.errors.length === 0 &&
      r.report.unhandled.every(error => {
        const files = blamed(error, r.report.modules)
        return (
          files.length > 0 && !files.some(({ file }) => file === rerun.file)
        )
      }),
  )
  const outcome = (passed: boolean, name: string): Outcome =>
    passed
      ? Outcome.Flaky({ file: rerun.file, name })
      : Outcome.Failed({ file: rerun.file, name })
  return Rerun.$match(rerun, {
    Tests: ({ names }) =>
      names.map(name =>
        outcome(
          clean &&
            Option.exists(
              module,
              ({ passed, failed }) =>
                passed.includes(name) && !failed.includes(name),
            ),
          name,
        ),
      ),
    File: ({ why }) => [
      outcome(
        clean && Option.exists(module, ({ failed }) => failed.length === 0),
        `(${why})`,
      ),
    ],
  })
}

/** The line an outcome prints: `FLAKY: <file> > <test>`, as tutti reads it, or `FAILED: …`. */
export const outcomeLine = (outcome: Outcome, cwd: string): string =>
  Outcome.$match(outcome, {
    Flaky: ({ file, name }) =>
      `FLAKY: ${NodePath.relative(cwd, file)} > ${name}`,
    Failed: ({ file, name }) =>
      `FAILED: ${NodePath.relative(cwd, file)} > ${name}`,
  })
