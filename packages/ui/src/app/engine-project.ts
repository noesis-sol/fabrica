import { Schema } from 'effect'

import {
  AttentionRef,
  type AttentionRequest,
  ProjectId,
  attentionKey,
} from '@fabrica/contracts'

// A project as the console names it (spec §9.1, §18.3): its ID and the name of the engine that holds
// it. A project's ID is a slug of its name, so the same repository added on two engines has one ID on
// both: the console's scope, its sidebar's rows, its requests and every lookup by project name the
// engine with it, and two projects are the same only where both are. An attention request's ref is named
// with its engine too, since one project ID and ticket can be open on two engines.

/** A project and the name of the engine holding it, as the app's known engines name it. */
export const EngineProject = Schema.Struct({
  engine: Schema.String,
  project: ProjectId,
})
export type EngineProject = typeof EngineProject.Type

/** Whether two projects are the same: one ID on one engine. */
export const sameProject = Schema.toEquivalence(EngineProject)

/** A project's key, for a keyed element or an entry's ID: its engine's name and its ID. */
export const projectKey = ({ engine, project }: EngineProject): string =>
  `${engine}/${project}`

/** An attention request's ref and the name of the engine it is open on. */
export const EngineAttentionRef = Schema.Struct({
  engine: Schema.String,
  ref: AttentionRef,
})
export type EngineAttentionRef = typeof EngineAttentionRef.Type

/** Whether `ref` names `request`, open on the engine named `engine`: one key on one engine. */
export const namesRequest = (
  ref: EngineAttentionRef,
  {
    engine,
    request,
  }: { readonly engine: string; readonly request: AttentionRequest },
): boolean =>
  ref.engine === engine && attentionKey(ref.ref) === attentionKey(request)
