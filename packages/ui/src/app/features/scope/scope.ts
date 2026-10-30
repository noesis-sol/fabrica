import { Option, Schema } from 'effect'
import { modifyFields } from 'foldkit/struct'

import { EngineProject } from '../../engine-project'
import { scopeEngine } from '../../engine-route'
import { type Handlers, type Return, andThen } from '../../feature'
import type { Model } from '../../model'
import { foldRequests } from '../attention/attention'
import * as BacklogFeature from '../backlog/backlog'
import { rescopeScreen } from '../screen/screen'
import { scopeTalkPanel } from '../talks/talks'
import type { messages } from './message'

// The scope (spec §18.3): the project the sidebar chose, named with its engine, or every project. A new
// scope starts its streams' values afresh, and the screen shown and the talk panel follow it.

/** Selecting the scope already chosen keeps the Model: its streams aren't subscribed again. */
const sameScope = Schema.toEquivalence(Schema.Option(EngineProject))

/** The scope now `project`. */
export const selectScope = (
  model: Model,
  project: Option.Option<EngineProject>,
): Return => {
  if (sameScope(model.scope, project)) {
    return { model }
  }
  const scoped = foldRequests(
    modifyFields(BacklogFeature.opened(model), {
      scope: () => project,
      runView: () => Option.none(),
      runViews: () => [],
      events: () => [],
      attention: () => Option.none(),
      engineAttention: () => [],
      focusedRequest: () => Option.none(),
      backlog: () => Option.none(),
      usage: () => Option.none(),
      // The load is the scoped project's engine's host's: another engine's is read afresh.
      load: load =>
        scopeEngine(project) === scopeEngine(model.scope)
          ? load
          : Option.none(),
    }),
    [],
  )
  return andThen(andThen(scoped, rescopeScreen), scopeTalkPanel)
}

export const update = (model: Model): Handlers<keyof typeof messages> => ({
  SelectedScope: ({ project }) => selectScope(model, project),
})
