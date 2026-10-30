import { Effect } from 'effect'

import { AttentionRpcs } from '@fabrica/contracts'

import { AttentionRequests } from '../attention/service'
import { clientName } from './clients'

// The Attention group's handlers (spec §8.1, §15.1, §8.5) on the engine's attention requests: what
// waits on the maintainer, listed and watched by every client, and their answers, each named by the
// client that gave it, so the first wins and the others hear who answered and when.

/** The Attention group's handlers, on the attention requests in context: the daemon's. */
export const attentionHandlers = AttentionRpcs.toLayer(
  Effect.map(AttentionRequests, attention =>
    AttentionRpcs.of({
      'attention.list': ({ project }) => attention.list(project),
      'attention.answer': ({ answer }, { client }) =>
        attention.answer({ answer, by: clientName(client) }),
      'attention.watch': ({ project, resume }) =>
        attention.watch({ project, resume }),
    }),
  ),
)
