import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { ProviderName, Utilization } from '../events'
import { ProjectId, RunId } from '../ids'
import { ProjectSettings } from '../settings'
import { Text } from '../ticket'
import { Count, Moment, Ordinal, optional } from './common'
import { ProjectNotFound } from './errors'
import { keyedPatch, resume, streamItem } from './stream'

// The Projects group (spec §8.1, §10): adding a checkout on the engine's host or a clone of a URL,
// the host's folders a client browses for that checkout, listing and removing projects, the user's
// trust in each (§12.1), their settings, `init`, the stream of their status that the sidebar
// shows (§18.3), and the stream of a project's provider account's usage windows that the title bar
// shows (§12.9, H90).

/** Where a project comes from (§10.1): a checkout the engine can read, or a git URL it clones. */
export const ProjectSource = Schema.TaggedUnion({
  path: { path: Text },
  url: { url: Text },
})
export type ProjectSource = typeof ProjectSource.Type

/** A folder on the engine's host, as a client browses for a checkout to add (§10.1). */
export class HostFolder extends Schema.Class<HostFolder>('HostFolder')({
  name: Text,
  /** Its absolute path on the engine's host. */
  path: Text,
  /** It is a git checkout's top folder: it holds `.git`. */
  checkout: Schema.Boolean,
}) {}

/** A folder on the engine's host and its subfolders, by name. */
export class FolderListing extends Schema.Class<FolderListing>('FolderListing')(
  {
    /** The folder listed, absolute. */
    path: Text,
    /** The folder above it; none at the root. */
    parent: Schema.OptionFromNullOr(Text),
    /** It is a git checkout's top folder itself. */
    checkout: Schema.Boolean,
    /** Its subfolders, hidden ones left out. */
    folders: Schema.Array(HostFolder),
  },
) {}

/** A project on the engine. */
export class ProjectInfo extends Schema.Class<ProjectInfo>('ProjectInfo')({
  id: ProjectId,
  name: Text,
  /** Its checkout, on the engine's host. */
  path: Text,
  origin: Schema.Literals(['registered', 'cloned']),
  /** The remote it was cloned from. */
  url: Schema.OptionFromNullOr(Text),
  /** Its Base branch. */
  base: Text,
  /** Its settings exist (§10.1): `init` has run. */
  setUp: Schema.Boolean,
  /** The user trusts it, so its agents load its own Pi settings and packages (§12.1, §20.2). */
  trusted: Schema.Boolean,
}) {}

/** A project's run, as its sidebar row says it (§18.3): Idle, Running, or Waiting on the maintainer. */
export const ProjectRunState = Schema.TaggedUnion({
  idle: {},
  running: { run: RunId, overnight: Schema.Boolean },
  waiting: { run: RunId, overnight: Schema.Boolean, needsYou: Ordinal },
})
export type ProjectRunState = typeof ProjectRunState.Type

/** A project's row in the sidebar. */
export class ProjectStatus extends Schema.Class<ProjectStatus>('ProjectStatus')(
  {
    project: ProjectId,
    name: Text,
    base: Text,
    setUp: Schema.Boolean,
    /** The user trusts it (§12.1, §20.2). */
    trusted: Schema.Boolean,
    run: ProjectRunState,
    /** Tickets ready to run. */
    ready: Count,
  },
) {}

/**
 * One of the usage windows of a project's provider account, its latest figure as the model proxy read
 * it from the provider's responses (§12.9, H90): the title bar shows them (§18.3).
 */
export class UsageWindow extends Schema.Class<UsageWindow>('UsageWindow')({
  provider: ProviderName,
  /** `five_hour`, `seven_day`, … as the provider names it. */
  window: Text,
  /** The share of the window used, from 0 to 1. */
  utilization: Utilization,
  resetsAt: Schema.OptionFromNullOr(Moment),
}) {}

/** The usage stream's items: the windows' latest figures, then each window as it moves, whole. */
export const UsageWindowItem = streamItem(
  Schema.Array(UsageWindow),
  UsageWindow,
)
export type UsageWindowItem = typeof UsageWindowItem.Type

/** What `init` wrote, in order. */
export class Initialized extends Schema.Class<Initialized>('Initialized')({
  written: Schema.Array(Text),
}) {}

/** The project couldn't be added: the path isn't a checkout, the clone failed. */
export class AddFailed extends Schema.TaggedError<AddFailed>()('AddFailed', {
  reason: Text,
}) {}

/** The folder couldn't be listed: it isn't there, isn't a folder, or can't be read. */
export class FolderUnreadable extends Schema.TaggedError<FolderUnreadable>()(
  'FolderUnreadable',
  { path: Text, reason: Text },
) {}

/** `init` failed; it lists what it had written (H62), and the project is as it was or set up. */
export class InitFailed extends Schema.TaggedError<InitFailed>()('InitFailed', {
  reason: Text,
  written: Schema.Array(Text),
}) {}

/** The settings given aren't valid: every problem, as the settings file's would be. */
export class InvalidSettings extends Schema.TaggedError<InvalidSettings>()(
  'InvalidSettings',
  { problems: Schema.NonEmptyArray(Text) },
) {}

/** A project's settings, named once in the JSON Schema. */
const Settings = ProjectSettings.annotate({ identifier: 'ProjectSettings' })

/** The patch to the project rows: a removed project by its ID. */
export const ProjectStatusPatch = keyedPatch(ProjectStatus, ProjectId)

/** The project status stream's items: the rows, then patches to them. */
export const ProjectStatusItem = streamItem(
  Schema.Array(ProjectStatus),
  ProjectStatusPatch,
)
export type ProjectStatusItem = typeof ProjectStatusItem.Type

export const ProjectRpcs = RpcGroup.make(
  Rpc.make('projects.add', {
    payload: { source: ProjectSource, name: optional(Text) },
    success: ProjectInfo,
    error: AddFailed,
  }),
  /**
   * A folder's subfolders on the engine's host, each marked where it is a git checkout, for a client
   * to browse for the checkout to add: the engine's home folder where no path is given.
   */
  Rpc.make('projects.folders', {
    payload: { path: optional(Text) },
    success: FolderListing,
    error: FolderUnreadable,
  }),
  Rpc.make('projects.list', { success: Schema.Array(ProjectInfo) }),
  /** Forgets the project; a registered checkout stays where it is. */
  Rpc.make('projects.remove', {
    payload: { project: ProjectId },
    error: ProjectNotFound,
  }),
  /**
   * Gives or takes back the user's trust in the project (§12.1, §20.2): its agents started from then
   * on load its own Pi settings and packages only while it is trusted. The maintainer's alone: no
   * agent's control tool asks it.
   */
  Rpc.make('projects.trust', {
    payload: { project: ProjectId, trusted: Schema.Boolean },
    error: ProjectNotFound,
  }),
  Rpc.make('projects.settings.get', {
    payload: { project: ProjectId },
    success: Settings,
    error: ProjectNotFound,
  }),
  Rpc.make('projects.settings.set', {
    payload: { project: ProjectId, settings: Settings },
    error: Schema.Union([ProjectNotFound, InvalidSettings]),
  }),
  Rpc.make('projects.init', {
    payload: { project: ProjectId },
    success: Initialized,
    error: Schema.Union([ProjectNotFound, InitFailed]),
  }),
  Rpc.make('projects.watchStatus', {
    payload: { resume },
    success: ProjectStatusItem,
    stream: true,
  }),
  /**
   * The project's provider account's usage windows (§12.9, H90), for the title bar (§18.3): the model
   * proxy's latest figure of each, then each window as it moves. A window is named by its provider
   * and its name, one account to a provider.
   */
  Rpc.make('projects.watchUsage', {
    payload: { project: ProjectId, resume },
    success: UsageWindowItem,
    error: ProjectNotFound,
    stream: true,
  }),
)
