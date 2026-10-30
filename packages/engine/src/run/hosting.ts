import {
  Context,
  Data,
  type DateTime,
  type Effect,
  Layer,
  type Option,
} from 'effect'

import type {
  Attention,
  CheckOwnPasses,
  ControlServer,
  layer as controlLayer,
} from '../control'
import type { RunLog } from '../runlog'
import type { KeepAwakeHost } from '../time'
import type { WorkGraph } from '../workgraph'
import type { runProject } from './loop'

// What the engine's runs run on (spec §7.3, §12, §13): the services a run needs beside its own log, its
// project's work graph and the control server, `check_own` passes and attention requests on it (the agents, the model
// proxy, the checks, git and its worktrees, the battery, the zone its records are dated in), and the host's shares for its workers. The daemon is given them as it starts; where it isn't, it
// refuses every run, saying why.

/** The services a run runs on, which each run is given; its log, work graph, what is on it and its attention requests aside. */
export type RunServices =
  | Exclude<
      | Effect.Services<ReturnType<typeof runProject>>
      | Layer.Services<typeof controlLayer>,
      RunLog | WorkGraph | ControlServer | CheckOwnPasses | Attention
    >
  | DateTime.CurrentTimeZone

/** What the engine's runs run on, or why it can't run one. */
export type RunHostingShape = Data.TaggedEnum<{
  Ready: {
    readonly services: Context.Context<RunServices>
    /** The folder the workers' control sockets are made in. */
    readonly sockets: string
    /** A worker's and a check's share of the machine's cores, at least 1. */
    readonly cores: number
    /** `worker_nice`; none for the engine's own priority. */
    readonly nice: Option.Option<number>
    /** The engine's host, which its runs keep from idle sleep. */
    readonly keepAwakeHost: KeepAwakeHost
    /** The engine's environment, for the FABRICA_ variables of settings (§13.13). */
    readonly environment: Readonly<Record<string, string | undefined>>
  }
  Refused: { readonly reason: string }
}>
export const RunHostingShape = Data.taggedEnum<RunHostingShape>()

export class RunHosting extends Context.Service<RunHosting, RunHostingShape>()(
  '@fabrica/engine/RunHosting',
) {}

/** Hosting that refuses every run, for `reason`. */
export const refusingRuns = (reason: string): Layer.Layer<RunHosting> =>
  Layer.succeed(RunHosting)(RunHostingShape.Refused({ reason }))
