import type { MessageEvent as MainMessageEvent } from 'electron'

import type { PortEnd } from '@fabrica/client'

// The connection process's end of a page's port: Electron's MessagePortMain, an event emitter
// whose messages arrive as events carrying their data.

/** As much of a `MessagePortMain` as the relay uses. */
export interface MainPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: MainMessageEvent) => void): this
  on(event: 'close', listener: () => void): this
  off(event: 'message', listener: (event: MainMessageEvent) => void): this
  off(event: 'close', listener: () => void): this
  start(): void
}

/** A `MessagePortMain` (or anything shaped like one) as a `PortEnd`. */
export const mainPortEnd = (port: MainPort): PortEnd => ({
  post: message => port.postMessage(message),
  listen: ({ onMessage, onClose }) => {
    const message = (event: MainMessageEvent) => onMessage(event.data)
    port.on('message', message)
    port.on('close', onClose)
    port.start()
    return () => {
      port.off('message', message)
      port.off('close', onClose)
    }
  },
})
