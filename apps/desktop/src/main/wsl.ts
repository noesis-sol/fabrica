import { Data, Effect, Option } from 'effect'
import { spawn } from 'node:child_process'

import { UbuntuInstall, type WslDistro, WslSearch } from '@fabrica/client'
import {
  type Held,
  type WslRunner,
  findDistribution,
  holdDistribution,
  wslEnv,
  wslInstallArguments,
} from '@fabrica/client/node'

import { ConnectionTarget } from '../connection/target'

// The Windows app's engine in WSL2 (spec §7.6, H31), one more host: the distribution found, or Ubuntu
// installed where there is none, in a console window of its own, where WSL asks for the new user's
// name and password; the engine checked and installed there as on any host (`engine-install.ts`), run
// through `wsl.exe -d <distro> --exec`, its login service a systemd user unit only where the
// distribution's systemd runs (the bridge starts the engine otherwise); and the engine reached through
// `wsl.exe -d <distro> -- fabrica bridge` in the connection process, while a detached wsl.exe holds the
// distribution for as long as the engine answers, since WSL shuts down a distribution no Windows
// process holds (fab-mgi.16). The app reaches it where this machine runs no engine of its own: at
// launch, the known engine in WSL2 kept last, and once Add engine has installed one, or found one up
// to date, that one, which the page keeps among the known engines at its first hello.

/** How `wsl.exe --install` ended: its exit code, or the reason it didn't run. */
type Ended = Data.TaggedEnum<{
  Exited: { readonly code: number | null }
  NotRun: { readonly reason: string }
}>
const Ended = Data.taggedEnum<Ended>()

/** Runs `wsl.exe --install -d Ubuntu` in a console window of its own, to its end. */
const runInstall = (runner: WslRunner) =>
  Effect.callback<Ended>(resume => {
    // Detached, a console program gets a console window of its own on Windows.
    const child = spawn(runner.wsl ?? 'wsl.exe', [...wslInstallArguments], {
      env: wslEnv(runner.env),
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', error =>
      resume(Effect.succeed(Ended.NotRun({ reason: error.message }))),
    )
    child.once('exit', code => resume(Effect.succeed(Ended.Exited({ code }))))
  })

/**
 * Installs Ubuntu in WSL, WSL itself included where it isn't there, as the user agreed to, and looks
 * for the distribution again once the install has ended.
 */
export const installUbuntu = Effect.fn('Wsl.installUbuntu')(function* (
  runner: WslRunner,
) {
  const ended = yield* runInstall(runner)
  const found = yield* findDistribution(runner)
  return WslSearch.match(found, {
    Found: ({ distro }): UbuntuInstall =>
      UbuntuInstall.cases.Ready.make({ distro }),
    None: (): UbuntuInstall =>
      UbuntuInstall.cases.Unfinished.make({
        reason: Ended.$match(ended, {
          Exited: ({ code }) =>
            code === 0
              ? 'WSL installed, but Ubuntu is not ready yet: restart Windows if WSL asked to, open Ubuntu once to set up its user, then try again'
              : `wsl.exe --install -d Ubuntu ended with ${code ?? 'a signal'}`,
          NotRun: ({ reason }) => `couldn't run wsl.exe: ${reason}`,
        }),
      }),
    Unavailable: ({ reason }): UbuntuInstall =>
      UbuntuInstall.cases.Unfinished.make({
        reason: `couldn't run wsl.exe: ${reason}`,
      }),
  })
})

/**
 * The connection process's target for the engine in `distro`, and its keep-alive, started as the app
 * connects (none where wsl.exe couldn't start it): the bridge starts the engine where it isn't running,
 * and the keep-alive holds the distribution while it runs, after the app has gone too.
 */
export const reachWslEngine = Effect.fn('Wsl.reachEngine')(function* (
  runner: WslRunner & { readonly distro: WslDistro },
) {
  const held = yield* holdDistribution(runner).pipe(
    Effect.map(Option.some),
    Effect.catch(unavailable =>
      Effect.as(
        Effect.logWarning(
          `WSL ${runner.distro} can't be kept running: ${unavailable.message}`,
        ),
        Option.none<Held>(),
      ),
    ),
  )
  return {
    target: ConnectionTarget.cases.Wsl.make({ distro: runner.distro }),
    held,
  }
})

/**
 * The distribution whose engine the app reaches at launch: where this machine runs no engine the app
 * can reach (`local` is Unavailable, as on Windows), the known engine in WSL2 kept last (`kept`, the
 * app state's `keptWslDistro`).
 */
export const launchDistro = ({
  local,
  kept,
}: {
  readonly local: ConnectionTarget
  readonly kept: Option.Option<WslDistro>
}): Option.Option<WslDistro> =>
  ConnectionTarget.guards.Unavailable(local) ? kept : Option.none()
