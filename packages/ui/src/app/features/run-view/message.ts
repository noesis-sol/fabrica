import { Schema } from 'effect'

import { RunId } from '@fabrica/contracts'

import { EngineProject } from '../../engine-project'
import { RunViewItem, itemsOf } from '../../streams'

// The run view's Messages (spec §8.3, §18.3): the scoped project's run view, under All projects every
// project's run going.

export const messages = {
  ReceivedRunView: { project: EngineProject, items: itemsOf(RunViewItem) },
  /** The project's run view ended: no run, or the project gone. */
  EndedRunView: { project: EngineProject, reason: Schema.String },
  /** The pause after the project's run view ended NoRun while its row showed `run` going. */
  WaitedToRewatchRunView: { project: EngineProject, run: RunId },
}
