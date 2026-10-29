import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { CommitHash, ProjectId, RunId, TicketId } from '../ids'
import { Text } from '../ticket'
import { Moment, Ordinal, optional } from './common'
import { ProjectNotFound, TicketNotFound } from './errors'
import { NoRun, RunNotFound } from './runs'

// The Review group (spec §8.1, §18.4): a ticket's branch diff, a run's merged diff, run reports and the
// human log's tail.

/** How a file changed. */
export const FileChange = Schema.Literals([
  'added',
  'modified',
  'deleted',
  'renamed',
])
export type FileChange = typeof FileChange.Type

/** One file's part of a diff, as a unified patch. */
export class FileDiff extends Schema.Class<FileDiff>('FileDiff')({
  path: Text,
  change: FileChange,
  /** Its path before, for a rename. */
  from: Schema.OptionFromNullOr(Text),
  patch: Schema.String,
}) {}

/** A diff between two commits. */
export class Diff extends Schema.Class<Diff>('Diff')({
  base: CommitHash,
  head: CommitHash,
  files: Schema.Array(FileDiff),
}) {}

/** A run's report (§16), as Markdown. */
export class Report extends Schema.Class<Report>('Report')({
  run: RunId,
  markdown: Schema.String,
  writtenAt: Moment,
}) {}

/** The ticket has no branch to diff: never dispatched, or its worktree gone. */
export class NoBranch extends Schema.TaggedError<NoBranch>()('NoBranch', {
  project: ProjectId,
  ticket: TicketId,
}) {}

/** The run has no report yet. */
export class NoReport extends Schema.TaggedError<NoReport>()('NoReport', {
  project: ProjectId,
  run: RunId,
}) {}

export const ReviewRpcs = RpcGroup.make(
  Rpc.make('diff.ticket', {
    payload: { project: ProjectId, ticket: TicketId },
    success: Diff,
    error: Schema.Union([ProjectNotFound, TicketNotFound, NoBranch]),
  }),
  Rpc.make('diff.run', {
    payload: { project: ProjectId, run: RunId },
    success: Diff,
    error: Schema.Union([ProjectNotFound, RunNotFound]),
  }),
  /** A run's report: the last run's when none is named. */
  Rpc.make('report.get', {
    payload: { project: ProjectId, run: optional(RunId) },
    success: Report,
    error: Schema.Union([ProjectNotFound, NoRun, RunNotFound, NoReport]),
  }),
  /** The human log's last lines (§7.5). */
  Rpc.make('log.tail', {
    payload: { project: ProjectId, lines: Ordinal },
    success: Schema.Struct({ lines: Schema.Array(Schema.String) }),
    error: ProjectNotFound,
  }),
)
