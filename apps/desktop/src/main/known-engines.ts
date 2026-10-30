import { Effect } from 'effect'

import {
  KeepAnswer,
  type KnownEngine,
  KnownEnginesAnswer,
} from '@fabrica/client'

import type { AppStateFailed, AppStateShape } from './state'

// The known engines as main answers the page for them (spec §9.1): read from the app's state, and one
// kept there once Add engine installed it and the page's connection to it had its first hello. A state
// that can't be read or written is said in words, never a rejected request.

const failureWords = (failure: AppStateFailed): string =>
  `couldn't ${failure.operation}: ${failure.reason}`

/** The engines `state` knows, or why they couldn't be read. */
export const knownEnginesOf = (
  state: AppStateShape,
): Effect.Effect<KnownEnginesAnswer> =>
  state.engines.pipe(
    Effect.map(engines => KnownEnginesAnswer.cases.Read.make({ engines })),
    Effect.catch(failure =>
      Effect.succeed(
        KnownEnginesAnswer.cases.Failed.make({ reason: failureWords(failure) }),
      ),
    ),
  )

/** Keeps `engine` in `state`, replacing the one of its name, or says why it couldn't. */
export const keepEngineIn = (
  state: AppStateShape,
  engine: KnownEngine,
): Effect.Effect<KeepAnswer> =>
  state.saveEngine(engine).pipe(
    Effect.as(KeepAnswer.cases.Kept.make({})),
    Effect.catch(failure =>
      Effect.succeed(
        KeepAnswer.cases.Failed.make({ reason: failureWords(failure) }),
      ),
    ),
  )
