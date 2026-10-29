import { Array, Data, Schema, SchemaIssue } from 'effect'

// Where a resolved setting came from, kept for the Settings screen, and the problems a resolution
// found, every one listed together (spec §13.13, tutti spec §3.3 AppConfig).

/** The project's settings file, inside its checkout. */
export const projectSettingsPath = '.fabrica/settings.json'

/** Where a setting's value came from, highest first. */
export type SettingSource = Data.TaggedEnum<{
  Flag: { readonly flag: string }
  Environment: { readonly variable: string }
  ProjectFile: { readonly file: string }
  EngineSettings: {}
  Default: {}
}>
export const SettingSource = Data.taggedEnum<SettingSource>()

/** A source as a person reads it: `--concurrent`, `FABRICA_CONCURRENT`, `.fabrica/settings.json`. */
export const describeSource = SettingSource.$match({
  Flag: ({ flag }) => flag,
  Environment: ({ variable }) => variable,
  ProjectFile: ({ file }) => file,
  EngineSettings: () => "the engine's settings",
  Default: () => 'the default',
})

/** One problem with the settings: where it was given, the path in its file it is at, and what is wrong. */
export interface SettingsProblem {
  readonly source: SettingSource
  /** The path the problem is at, `verifier.rounds` or `requires.0.install`; empty for the whole file. */
  readonly path: string
  readonly message: string
}

/** A problem as one line: its source, its path and its message. */
export const describeProblem = (problem: SettingsProblem): string =>
  `${describeSource(problem.source)}${problem.path === '' ? '' : ` ${problem.path}`}: ${problem.message}`

/** The settings have problems, every one of them listed. */
export class SettingsProblems extends Data.TaggedError('SettingsProblems')<{
  readonly problems: Array.NonEmptyReadonlyArray<SettingsProblem>
}> {
  override get message() {
    return `The settings have ${this.problems.length === 1 ? 'a problem' : `${this.problems.length} problems`}:\n${this.problems
      .map(problem => `- ${describeProblem(problem)}`)
      .join('\n')}`
  }
}

/** A problem's place in its file, as the segments of its path. */
export interface IssueAt {
  readonly segments: ReadonlyArray<string>
  readonly message: string
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** Every problem a decoding failure holds, each at its path. */
export const issuesOf = (error: Schema.SchemaError): ReadonlyArray<IssueAt> =>
  formatIssues(error.issue).issues.map(issue => ({
    segments: (issue.path ?? []).map(segment =>
      typeof segment === 'object' ? String(segment.key) : String(segment),
    ),
    message: issue.message,
  }))
