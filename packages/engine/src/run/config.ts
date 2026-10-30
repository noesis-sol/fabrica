import { Data, type Option } from 'effect'

import type { EngineId, ProjectId, TicketId } from '@fabrica/contracts'

import type { WorktreeHome } from '../git'

// What a run is asked to do and what it runs with (spec §13.1): its mode, its caps, and the project's
// places and the engine's facts, given once where the run starts.

/** Which tickets the run takes (§13.1); spec, feature and overnight runs come later. */
export type RunMode = Data.TaggedEnum<{
  /** The current tickets (`--tickets`, the default). */
  Tickets: {}
  /** One ticket and its descendants (`--ticket <id>`). */
  Ticket: { readonly ticket: TicketId }
}>
export const RunMode = Data.taggedEnum<RunMode>()

/** A run's flags. */
export interface RunOptions {
  readonly mode: RunMode
  /** `--limit N`: the most dispatches; none, no limit (orchestra-5ls7). */
  readonly limit: Option.Option<number>
  /** `--concurrent N`: the most workers at once, the `concurrent` setting's flag. */
  readonly concurrent: Option.Option<number>
}

/** What the run's settings are resolved from beside the project's file (§13.13). */
export interface RunSettingsInputs {
  /** The settings flags given, by setting path, as their text; `--concurrent` is added to them. */
  readonly flags: Readonly<Record<string, string>>
  /** The engine's environment, for the FABRICA_ variables of settings. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The engine's settings as stored; `{}` where it has none. */
  readonly engineSettings: unknown
}

/** What a run of one project works from, read once where it starts. */
export interface RunConfig {
  readonly project: ProjectId
  readonly engine: EngineId
  /** The engine's version, on the `start` record. */
  readonly version: string
  /** The project's checkout: Base is the branch checked out in it. */
  readonly checkout: string
  /** Where the tickets' worktrees are. */
  readonly home: WorktreeHome
  /** The folder the workers' control sockets are made in. */
  readonly sockets: string
  readonly options: RunOptions
  readonly settings: RunSettingsInputs
  /** A worker's and a check's share of the machine's cores, at least 1. */
  readonly cores: number
  /** `worker_nice`; none for the engine's own priority. */
  readonly nice: Option.Option<number>
  /** The user trusts the project, so its agents' Pi may load its own settings and packages (§12.1). */
  readonly projectTrusted: boolean
}
