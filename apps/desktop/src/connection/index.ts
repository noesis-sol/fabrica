import { Effect, Option, Schema } from 'effect'
import { tmpdir } from 'node:os'

import { SshPromptAnswer } from '@fabrica/client'

import { askpassNodeOf } from './askpass'
import {
  FingerprintRead,
  FingerprintRequest,
  readFingerprint,
} from './fingerprint'
import { mainPortEnd } from './port'
import { makeAskedPrompts } from './prompts'
import { relay } from './relay'
import { ConnectionTarget } from './target'
import { type TransportHost, engineSocket, refusalOf } from './transports'

// The connection process (spec §5, §8.2), Electron's utilityProcess: main sends it, for each page it
// brokers, one end of the page's port with the engine to reach, and it relays the port to that
// engine until the port closes. What ssh asks as it connects goes to main, and main's answers come
// back, as messages without a port; so do main's requests for the fingerprint of the certificate an
// engine presents over TLS, at a first pairing, and their answers. It renders nothing and touches no
// repository.

const decodeTarget = Schema.decodeUnknownOption(ConnectionTarget)
const decodeAnswer = Schema.decodeUnknownOption(SshPromptAnswer)
const decodeFingerprintRequest = Schema.decodeUnknownOption(FingerprintRequest)
const encodeFingerprintRead = Schema.encodeSync(FingerprintRead)

const asked = makeAskedPrompts(event => process.parentPort.postMessage(event))

const host: TransportHost = {
  env: process.env,
  askpass: Option.map(askpassNodeOf(process.argv), node => ({
    node,
    folder: tmpdir(),
    prompts: asked.prompts,
  })),
}

process.parentPort.on('message', event => {
  if (event.ports.length === 0) {
    Option.map(decodeAnswer(event.data), asked.answered)
    Option.map(decodeFingerprintRequest(event.data), ({ id, endpoint }) =>
      Effect.runFork(
        readFingerprint(endpoint).pipe(
          Effect.map(answer =>
            process.parentPort.postMessage(
              encodeFingerprintRead(FingerprintRead.make({ id, answer })),
            ),
          ),
        ),
      ),
    )
    return
  }
  const [port] = event.ports
  if (port === undefined || event.ports.length !== 1) {
    return
  }
  Option.match(decodeTarget(event.data), {
    onNone: () => port.close(),
    onSome: target =>
      Effect.runFork(
        relay({
          port: mainPortEnd(port),
          engine: engineSocket(target, host),
          refusal: refusalOf,
        }).pipe(Effect.ensuring(Effect.sync(() => port.close()))),
      ),
  })
})
