import { Context, Option } from 'effect'
import type { Rpc } from 'effect/rpc'

import type { ClientHello } from '@fabrica/contracts'

// Who a connected client is (spec §8.5): the name it gives in its hello, kept on its connection, so the
// engine can say which client answered first.

/** The name a connection's client gave in its hello. */
export class HelloName extends Context.Service<
  HelloName,
  ClientHello['name']
>()('@fabrica/engine/rpc/HelloName') {}

/** Keeps the client's name on its connection. */
export const nameClient = (
  client: Rpc.ServerClient,
  hello: ClientHello,
): void => {
  client.annotate(HelloName, hello.name)
}

/** The client's name: the one its hello gave, else its connection's number. */
export const clientName = (client: Rpc.ServerClient): ClientHello['name'] =>
  Option.getOrElse(
    Context.getOption(client.annotations, HelloName),
    () => `client ${client.id}`,
  )
