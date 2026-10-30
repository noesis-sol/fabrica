import { Schema } from 'effect'

import { EngineProject } from '../../engine-project'

// The scope's Messages (spec §18.3).

export const messages = {
  /** A project chosen in the sidebar, named with its engine, or none for every project. */
  SelectedScope: { project: Schema.Option(EngineProject) },
}
