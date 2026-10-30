import { Option, Result } from 'effect'

import {
  EngineAddress,
  type TlsEndpoint,
  tlsEndpointText,
} from '@fabrica/client'
import { type HostPlaces, enginePaths } from '@fabrica/engine/paths'

import { ConnectionTarget } from '../connection/target'

// Main's part in the app's connection to its engine (spec §5, §8.2): it starts the connection process
// and, at each load of a page, makes a port pair and hands one end to the page and the other, with
// the engine to reach, to the connection process; it then leaves the data path. A connection process
// that exits is started again after a pause, and every page it served gets a new port; so does every
// page when the app's engine changes (the Windows app's in WSL2, once Add engine has installed it). A
// known engine on another host (§9.1) has a connection of its own, whose port the page asks for at
// each attempt; main keeps the newest it relayed for each page and engine, and relays it again, handed
// to the page under the same request, when the connection process starts anew, the old one dead with
// the process that relayed it.

/** The engine the app reaches on this machine: its local socket, where the engine runs here (§4). */
export const localTarget = (host: HostPlaces): ConnectionTarget =>
  Result.match(enginePaths(host), {
    onSuccess: paths =>
      ConnectionTarget.cases.LocalSocket.make({ path: paths.socket }),
    onFailure: unsupported =>
      ConnectionTarget.cases.Unavailable.make({ reason: unsupported.message }),
  })

/** What a connection to an engine over TLS the app hasn't paired with says. */
export const unpaired = (endpoint: TlsEndpoint): string =>
  `the app hasn't paired with the engine at ${tlsEndpointText(endpoint)}: add it again with a pairing token`

/**
 * The engine a known engine's address names, `local` for this machine's; one over TLS is refused here,
 * its target, with the token main keeps for it, being its pairing's (./pairing).
 */
export const knownTarget = (
  address: EngineAddress,
  local: ConnectionTarget,
): ConnectionTarget =>
  EngineAddress.match(address, {
    Local: () => local,
    Ssh: ({ destination }) => ConnectionTarget.cases.Ssh.make({ destination }),
    Wsl: ({ distro }) => ConnectionTarget.cases.Wsl.make({ distro }),
    Tls: endpoint =>
      ConnectionTarget.cases.Refused.make({ reason: unpaired(endpoint) }),
  })

/** A known engine's address as the broker keys the ports it relays to it: one per way of reaching it. */
export const addressKey = (address: EngineAddress): string =>
  EngineAddress.match(address, {
    Local: () => 'local',
    Ssh: ({ destination }) => `ssh ${destination}`,
    Wsl: ({ distro }) => `wsl ${distro}`,
    Tls: ({ host, port, fingerprint }) => `tls ${host}:${port} ${fingerprint}`,
  })

/** The connection process, as main reaches it. */
export interface ConnectionProcess<Port> {
  /** Hands it one end of a page's port, with the engine to relay it to. */
  readonly relay: (target: ConnectionTarget, port: Port) => void
  /** Hands it a message without a port: the page's answer to what its ssh asked, or main's request. */
  readonly post: (message: unknown) => void
}

/** A page, as the broker sees it. */
export interface BrokeredPage<Port> {
  /** The page's ID, which a known engine's port names the page by. */
  readonly id: number
  /** Calls `listener` at each load of the page, its first included. */
  readonly onLoad: (listener: () => void) => void
  /** Calls `listener` as the page moves to a new document, a reload's included, before its scripts run. */
  readonly onNavigate: (listener: () => void) => void
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
  /** The engine the pages reach until `retarget` names another. */
  readonly target: ConnectionTarget
}

/** A port to a known engine a page asked for (§9.1). */
export interface KnownConnection<Port> {
  /** The page that asked, by its ID. */
  readonly page: number
  /** The engine's address, as `addressKey` keys it: the newest port for each page and engine is kept. */
  readonly engine: string
  /** The engine to relay it to. */
  readonly target: ConnectionTarget
  /** Hands the page its end, under the request it answers. */
  readonly send: (port: Port) => void
}

/**
 * The broker: `attach` gives a page a port at each of its loads, until it has gone; `connect` relays a
 * port to a known engine's target for the page that asked, and again after each restart of the
 * connection process, until the page asks for another to the engine, moves to a new document or goes;
 * `post` reaches the connection process running, `ask` the one running or started for it; `retarget`
 * gives every page a port to another engine.
 */
export const makeBroker = <Port>(host: BrokerHost<Port>) => {
  let child: Option.Option<ConnectionProcess<Port>> = Option.none()
  let target = host.target
  const pages = new Set<BrokeredPage<Port>>()
  // Each page's known engines' newest ports, by engine, with the connection process each went through.
  const known = new Map<
    number,
    Map<
      string,
      {
        readonly connection: KnownConnection<Port>
        through: ConnectionProcess<Port>
      }
    >
  >()

  const connection = (): ConnectionProcess<Port> =>
    Option.getOrElse(child, () => {
      const started = host.spawn(() => {
        child = Option.none()
        host.afterExit(() => {
          for (const page of pages) {
            broker(page)
          }
          // Those relayed since the exit went through the process started for them, alive still.
          for (const engines of known.values()) {
            for (const kept of engines.values()) {
              if (kept.through === started) {
                kept.through = relay(
                  kept.connection.target,
                  kept.connection.send,
                )
              }
            }
          }
        })
      })
      child = Option.some(started)
      return started
    })

  /** A new port pair: one end relayed to `to`, the other handed to `send`; the process it went through. */
  const relay = (
    to: ConnectionTarget,
    send: (port: Port) => void,
  ): ConnectionProcess<Port> => {
    const { page: pageEnd, relay: relayEnd } = host.channel()
    const through = connection()
    through.relay(to, relayEnd)
    send(pageEnd)
    return through
  }

  const broker = (page: BrokeredPage<Port>): void => {
    relay(target, page.send)
  }

  const forget = (page: BrokeredPage<Port>): void => {
    known.delete(page.id)
  }

  return {
    /** Hands the connection process `message` while it runs; nothing once it has exited. */
    post: (message: unknown): void => {
      Option.map(child, running => running.post(message))
    },
    /** Hands the connection process `message`, starting it where it isn't running. */
    ask: (message: unknown): void => connection().post(message),
    connect: (asked: KnownConnection<Port>): void => {
      const through = relay(asked.target, asked.send)
      const engines = known.get(asked.page) ?? new Map()
      engines.set(asked.engine, { connection: asked, through })
      known.set(asked.page, engines)
    },
    /** Has every page reach `next` from now on, each through a new port. */
    retarget: (next: ConnectionTarget): void => {
      target = next
      for (const page of pages) {
        broker(page)
      }
    },
    attach: (page: BrokeredPage<Port>): void => {
      page.onLoad(() => {
        pages.add(page)
        broker(page)
      })
      page.onNavigate(() => forget(page))
      page.onGone(() => {
        pages.delete(page)
        forget(page)
      })
    },
  }
}
