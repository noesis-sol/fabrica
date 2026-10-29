import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { ModelName } from '../events'
import { ProjectId, SessionId, TalkId, TicketId } from '../ids'
import { ModelChoice } from '../settings'
import { Text } from '../ticket'
import { optional } from './common'
import { ProjectNotFound } from './errors'
import { resume } from './stream'
import { TranscriptItem } from './transcript'

// The Talks group (spec §8.1, §15.4): Pi sessions the engine runs with the maintainer, in a mode with
// its context; their transcripts stream to a client's chat pane. The run talk is one per project,
// kept across the app's restarts: opening it again gives the same talk.

/** What a talk is opened on. */
export const TalkContext = Schema.TaggedUnion({
  /** Refine a spec before its breakdown (§15.5): its path in the project. */
  refine: { spec: Text },
  /** Talk a feature through, filing an epic and its tickets. */
  feature: { text: Schema.OptionFromNullOr(Text) },
  /** The answer talk (§15.3): these questions, or every open one in scope when none is named. */
  answer: { questions: Schema.Array(TicketId) },
  /** The console's conversation with the orchestrator (H44). */
  run: {},
})
export type TalkContext = typeof TalkContext.Type

/** A talk's mode: its context's tag. */
export type TalkMode = TalkContext['_tag']

/** A talk opened, or the run talk found. */
export class OpenedTalk extends Schema.Class<OpenedTalk>('OpenedTalk')({
  talk: TalkId,
  session: SessionId,
  model: ModelName,
}) {}

/**
 * The talk couldn't be opened, in words: no model for it, its mode not in this release, its agent
 * refused to start.
 */
export class TalkNotOpened extends Schema.TaggedError<TalkNotOpened>()(
  'TalkNotOpened',
  { reason: Text },
) {}

/** No open talk with that ID. */
export class TalkNotFound extends Schema.TaggedError<TalkNotFound>()(
  'TalkNotFound',
  { talk: TalkId },
) {}

export const TalkRpcs = RpcGroup.make(
  Rpc.make('talk.open', {
    payload: {
      project: ProjectId,
      context: TalkContext,
      /** The project's model unless given (§15.4). */
      model: optional(ModelChoice),
    },
    success: OpenedTalk,
    error: Schema.Union([ProjectNotFound, TalkNotOpened]),
  }),
  Rpc.make('talk.send', {
    payload: { talk: TalkId, text: Text },
    error: TalkNotFound,
  }),
  Rpc.make('talk.close', { payload: { talk: TalkId }, error: TalkNotFound }),
  Rpc.make('talk.watchTranscript', {
    payload: { talk: TalkId, resume },
    success: TranscriptItem,
    error: TalkNotFound,
    stream: true,
  }),
)
