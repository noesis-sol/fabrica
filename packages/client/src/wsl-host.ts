import { Option, Schema } from 'effect'

// A WSL2 distribution as a host (spec §7.6, H31), in what the renderer checks as the connection process
// does: the distribution's name, as `wsl.exe -d` takes it, what the search for one and the install of
// Ubuntu came to, as they cross from the app's main process to the renderer, and the warning about a
// checkout on a Windows drive, which WSL mounts under `/mnt/<letter>` over a file system where git is
// slow and POSIX semantics don't hold. It has no Node in it; the bridge and the search are
// `transports/wsl.ts`.

/** A WSL distribution's name: letters, digits, `.`, `_` and `-`, as WSL allows, never starting with `-`. */
export const WslDistro = Schema.String.check(
  Schema.isPattern(/^(?!-)[A-Za-z0-9._-]+$/u),
)
export type WslDistro = typeof WslDistro.Type

/** What the search for a distribution to run the engine in found. */
export const WslSearch = Schema.TaggedUnion({
  /** The WSL2 distribution to run the engine in. */
  Found: { distro: WslDistro },
  /** No WSL2 distribution, or no WSL: offer `wsl --install -d Ubuntu`. `wsl1` names WSL 1 ones there. */
  None: { wsl1: Schema.Array(WslDistro) },
  /** wsl.exe couldn't be run, so neither can its install: why. */
  Unavailable: { reason: Schema.String },
})
export type WslSearch = typeof WslSearch.Type

/** What installing Ubuntu came to. */
export const UbuntuInstall = Schema.TaggedUnion({
  /** The distribution to run the engine in, found once the install had ended. */
  Ready: { distro: WslDistro },
  /** None was found after it: why, in words. */
  Unfinished: { reason: Schema.String },
})
export type UbuntuInstall = typeof UbuntuInstall.Type

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
