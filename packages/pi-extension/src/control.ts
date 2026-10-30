import { Context, Data, Effect, Layer, Option } from 'effect'
import { RpcClient, type RpcClientError, type RpcGroup } from 'effect/rpc'
import type { Socket } from 'effect/socket'

import * as NodeSocket from '@effect/platform-node-shared/NodeSocket'
import {
  ControlRpcs,
  ControlSocketVariable,
  ControlTokenVariable,
  controlTokenClient,
  layerNdjson,
} from '@fabrica/contracts'

import type { ExtensionEnvironment } from './environment'

// The extension's side of the control channel (spec §12.2, §12.3): a client of the control group on
// the agent's own Unix socket, in the Schema RPC protocol (newline-delimited JSON), every request
// carrying the session's token. The socket is opened on the first call.

export class Control extends Context.Service<
  Control,
  RpcClient.RpcClient<
    RpcGroup.Rpcs<typeof ControlRpcs>,
    RpcClientError.RpcClientError
  >
>()('@fabrica/pi-extension/Control') {}

/** The engine gave the agent no control channel: Pi was started without Fabrica's environment. */
export class ControlMissing extends Data.TaggedError('ControlMissing')<{}> {
  override get message() {
    return `no control channel: ${ControlSocketVariable} and ${ControlTokenVariable} must both be set`
  }
}

/** The control client on `socket`, its requests carrying `token`. */
export const layerSocket = ({
  socket,
  token,
}: {
  readonly socket: string
  readonly token: string
}): Layer.Layer<Control, Socket.SocketError> =>
  Layer.effect(Control, RpcClient.make(ControlRpcs)).pipe(
    Layer.provide(
      Layer.mergeAll(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(NodeSocket.layerNet({ path: socket })),
          Layer.provide(layerNdjson),
        ),
        controlTokenClient(token),
      ),
    ),
  )

/** The control client the environment names, or every call failing with `ControlMissing`. */
export const layer = (
  environment: ExtensionEnvironment,
): Layer.Layer<Control, ControlMissing | Socket.SocketError> =>
  Option.match(environment.control, {
    onNone: () => Layer.effect(Control, Effect.fail(new ControlMissing())),
    onSome: layerSocket,
  })
