import { Option, Result } from 'effect'

import { type HostPlaces, enginePaths } from '@fabrica/engine/paths'

import { ConnectionTarget } from '../connection/target'

// Main's part in the app's connection to its engine (spec §5, §8.2): it starts the connection process
// and, at each load of a page, makes a port pair and hands one end to the page and the other, with
// the engine to reach, to the connection process; it then leaves the data path. A connection process
// that exits is started again after a pause, and every page it served gets a new port.

/** The engine the app reaches on this machine: its local socket, where the engine runs here (§4). */
export const localTarget = (host: HostPlaces): ConnectionTarget =>
  Result.match(enginePaths(host), {
    onSuccess: paths =>
      ConnectionTarget.cases.LocalSocket.make({ path: paths.socket }),
    onFailure: unsupported =>
      ConnectionTarget.cases.Unavailable.make({ reason: unsupported.message }),
  })

/** The connection process, as main reaches it. */
export interface ConnectionProcess<Port> {
  /** Hands it one end of a page's port, with the engine to relay it to. */
  readonly relay: (target: ConnectionTarget, port: Port) => void
}

/** A page, as the broker sees it. */
export interface BrokeredPage<Port> {
  /** Calls `listener` at each load of the page, its first included. */
  readonly onLoad: (listener: () => void) => void
  /** Calls `listener` once the page has gone for good. */
  readonly onGone: (listener: () => void) => void
  /** Hands the page its end of a port. */
  readonly send: (port: Port) => void
}

/** What the broker needs of Electron. */
export interface BrokerHost<Port> {
  /** Starts the connection process; `onExit` is called once it has exited. */
  readonly spawn: (onExit: () => void) => ConnectionProcess<Port>
  /** Runs `restart` after the pause that follows the connection process's exit. */
  readonly afterExit: (restart: () => void) => void
  /** A new port pair: one end for the page, one for the connection process. */
  readonly channel: () => { readonly page: Port; readonly relay: Port }
  readonly target: ConnectionTarget
}

/** The broker: `attach` gives a page a port at each of its loads, until it has gone. */
export const makeBroker = <Port>(host: BrokerHost<Port>) => {
  let child: Option.Option<ConnectionProcess<Port>> = Option.none()
  const pages = new Set<BrokeredPage<Port>>()

  const connection = (): ConnectionProcess<Port> =>
    Option.getOrElse(child, () => {
      const started = host.spawn(() => {
        child = Option.none()
        host.afterExit(() => {
          for (const page of pages) {
            broker(page)
          }
        })
      })
      child = Option.some(started)
      return started
    })

  const broker = (page: BrokeredPage<Port>): void => {
    const { page: pageEnd, relay } = host.channel()
    connection().relay(host.target, relay)
    page.send(pageEnd)
  }

  return {
    attach: (page: BrokeredPage<Port>): void => {
      page.onLoad(() => {
        pages.add(page)
        broker(page)
      })
      page.onGone(() => pages.delete(page))
    },
  }
}
