import { Option, Schema } from 'effect'

// A WSL2 distribution as a host (spec §7.6, H31), in what the renderer checks as the connection process
// does: the distribution's name, as `wsl.exe -d` takes it, and the warning about a checkout on a
// Windows drive, which WSL mounts under `/mnt/<letter>` over a file system where git is slow and POSIX
// semantics don't hold. It has no Node in it; the bridge and the search are `transports/wsl.ts`.

/** A WSL distribution's name: letters, digits, `.`, `_` and `-`, as WSL allows, never starting with `-`. */
export const WslDistro = Schema.String.check(
  Schema.isPattern(/^(?!-)[A-Za-z0-9._-]+$/u),
)
export type WslDistro = typeof WslDistro.Type

/** The Windows drive `path` is on, where WSL mounts it under `/mnt/<letter>`: `C`. */
export const windowsDriveOf = (path: string): Option.Option<string> => {
  const found = /^\/mnt\/([A-Za-z])(?:\/|$)/u.exec(path)
  return Option.map(Option.fromNullishOr(found?.[1]), drive =>
    drive.toUpperCase(),
  )
}

/** The warning for a checkout at `path` in a WSL2 distribution: none where it is in Linux's own file system. */
export const windowsDriveWarning = (path: string): Option.Option<string> =>
  Option.map(
    windowsDriveOf(path),
    drive =>
      `${path} is on the Windows drive ${drive}:, where git is slow and POSIX file semantics don't hold: clone the project into the distribution's own file system, such as under ~/`,
  )
