import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import { TalkRpcs, decodeEngineSettings } from '@fabrica/contracts'

import { storedEngineSettings } from '../engine/database'
import { EngineFiles } from '../engine/paths'
import { EngineScopes } from '../engine/scopes'
import { Talks, layer as talksLayer } from '../talks'

// The Talks group's handlers (spec §8.1, §15.4) on the Talks service, which this file provides on the
// daemon's projects, its talks' agents and modes: talks' agents live in the engine's agents scope,
// and a talk's transcript crosses once per `stream_flush`, the engine's setting as the talk opens.

/** The Talks service on the daemon's services. */
const daemonTalks = Layer.unwrap(
  Effect.gen(function* () {
    const [files, scopes, sql] = yield* Effect.all([
      EngineFiles,
      EngineScopes,
      SqlClient.SqlClient,
    ])
    const flush = storedEngineSettings().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      // Stored settings that don't decode are the engine's to report; a talk crosses as the default does.
      Effect.catch(() => Effect.orDie(decodeEngineSettings({}))),
      Effect.map(settings => settings.stream_flush),
    )
    return talksLayer({ data: files.data, scope: scopes.agents, flush })
  }),
)

/** The Talks group's handlers. */
export const talksHandlers = TalkRpcs.toLayer(
  Effect.gen(function* () {
    const talks = yield* Talks
    return TalkRpcs.of({
      'talk.open': ({ project, context, model }) =>
        talks.open({ project, context, model }),
      'talk.send': ({ talk, text }) => talks.send({ talk, text }),
      'talk.close': ({ talk }) => talks.close(talk),
      'talk.watchTranscript': ({ talk, resume }) =>
        talks.watchTranscript({ talk, resume }),
    })
  }),
).pipe(Layer.provide(daemonTalks))
