import { Effect, Latch, Match } from 'effect'
import { RpcClient } from 'effect/rpc'

// The requests a protocol error ends, interrupted at the engine (fab-mgi.94). On a protocol error,
// a lost connection or a frame the client can't read (a line longer than the NDJSON parser's
// buffer), Effect's client fails every request in flight with it and forgets them, telling the
// engine nothing. Over a lost connection the engine ends them as the connection closes; after an
// unreadable frame the connection stays open, and the engine's side of a watched stream ran on, its
// chunks unacknowledged, for as long as the connection lasted. So the client's protocol keeps the
// requests each client has in flight and, on a protocol error, sends the engine an `Interrupt` for
// each: over the open connection it ends them, and over a lost one the send fails, which is ignored.
// Effect's client fails the requests in its own table as it walks it, so a request made while it
// does is failed with the error too: the client's calls wait for `settled` before they are made.

export interface ProtocolErrors {
  /** The protocol, sending the engine an `Interrupt` for every request in flight a protocol error ends. */
  readonly protocol: RpcClient.Protocol['Service']
  /** Done at once, or, while a protocol error is failing the requests in flight, once it has. */
  readonly settled: Effect.Effect<void>
}

/** `protocol`, interrupting at the engine the requests its errors end. */
export const interruptingOnProtocolErrors = Effect.fnUntraced(function* (
  protocol: RpcClient.Protocol['Service'],
) {
  const idle = yield* Latch.make(true)
  /** The requests each client has in flight, by its id. */
  const inFlight = new Map<number, Set<string | number>>()
  const requestsOf = (clientId: number): Set<string | number> => {
    const requests = inFlight.get(clientId) ?? new Set<string | number>()
    inFlight.set(clientId, requests)
    return requests
  }

  const send: RpcClient.Protocol['Service']['send'] = (
    clientId,
    request,
    transferables,
  ) =>
    Effect.suspend(() => {
      const sent = protocol.send(clientId, request, transferables)
      return Match.valueTags(request, {
        Request: ({ id }) => {
          const requests = requestsOf(clientId)
          requests.add(id)
          return Effect.tapError(sent, () =>
            Effect.sync(() => requests.delete(id)),
          )
        },
        Interrupt: ({ requestId }) => {
          requestsOf(clientId).delete(requestId)
          return sent
        },
        Ack: () => sent,
        Ping: () => sent,
        Eof: () => sent,
      })
    })

  /** Interrupts at the engine every request client `clientId` has in flight, forgetting them. */
  const interruptAll = (clientId: number) =>
    Effect.suspend(() => {
      const requests = [...requestsOf(clientId)]
      inFlight.delete(clientId)
      return Effect.forEach(
        requests,
        requestId =>
          Effect.ignore(
            protocol.send(clientId, { _tag: 'Interrupt', requestId }),
          ),
        { discard: true },
      )
    })

  return {
    protocol: RpcClient.Protocol.of({
      ...protocol,
      send,
      run: (clientId, write) =>
        protocol.run(clientId, response =>
          Match.valueTags(response, {
            Exit: ({ requestId }) => {
              requestsOf(clientId).delete(requestId)
              return write(response)
            },
            ClientProtocolError: () =>
              idle.close.pipe(
                Effect.andThen(write(response)),
                Effect.andThen(interruptAll(clientId)),
                Effect.ensuring(idle.open),
              ),
            Chunk: () => write(response),
            Defect: () => write(response),
            Pong: () => write(response),
            Request: () => write(response),
          }),
        ),
    }),
    settled: idle.await,
  } satisfies ProtocolErrors
})
