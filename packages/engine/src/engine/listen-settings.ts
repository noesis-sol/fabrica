import { Option } from 'effect'
import * as NodePath from 'node:path'

import type { ListenAddress } from '@fabrica/contracts'

// The TLS listener's settings (spec §9.3), apart from the engine's serving: the update's relaunch gives
// them to the release it starts, and the app's main process imports that, without the engine and its
// DuckDB.

/** The TLS listener's settings (§9.3), as the engine's settings and `fabrica serve`'s flags name them. */
export interface ListenSettings {
  readonly listen: Option.Option<ListenAddress>
  /** The certificate's PEM file; none: the engine's own. */
  readonly listen_certificate: Option.Option<string>
  /** Its private key's PEM file. */
  readonly listen_key: Option.Option<string>
}

/** The listener's settings with their files' paths absolute: a relative path is taken from where the engine runs. */
export const absoluteListenPaths = (
  settings: ListenSettings,
): ListenSettings => {
  const absolute = Option.map((path: string) => NodePath.resolve(path))
  return {
    listen: settings.listen,
    listen_certificate: absolute(settings.listen_certificate),
    listen_key: absolute(settings.listen_key),
  }
}
