import { Duration, Effect, Option } from 'effect'
import type { HttpClient } from 'effect/http'
import { randomBytes } from 'node:crypto'
import * as NodePath from 'node:path'

import {
  LAUNCHER,
  UpdateFailure,
  compareReleases,
  distributionName,
  installPlaces,
  versionFolder,
  versionLine,
} from '@fabrica/engine/update'

import {
  Delivery,
  type DistributionSource,
  type Offered,
  deliveryOf,
  offeredFor,
} from './distribution'
import { InstallFailure, describeInstallFailure } from './failure'
import {
  CheckAnswer,
  type EngineInstalled,
  type HostCheck,
  InstallAnswer,
  InstallConsent,
  InstallPlan,
} from './outcome'
import {
  type HostFacts,
  type Judged,
  engineRelease,
  judgeHost,
  parseProbe,
  probeScript,
} from './probe'
import { type HostShell, type ShellFailed, runScript, upload } from './shell'

// Installing and updating an engine on a host from the app (spec §9.2, §8.4, H22), through the host's
// shell (`shell.ts`): over SSH, in WSL2 through wsl.exe, or on this machine. The check probes the host
// (its system, its CPU, the engine there and its version), verifies the release's signed checksums.txt
// and finds its engine for the host's target, and proposes a plan: install it, update an older engine,
// nothing where it is there already, or the app's own update where the host's is the later. The install
// takes the plan the user agreed to, checks the host again and refuses where it changed; then, in a
// folder of its own beside the engine's versions (never /tmp, which hardened hosts mount noexec), has
// the archive sent or downloaded, checks its SHA-256 against the verified sum, unpacks it, runs its
// launcher's `--version` in its folder, renames the version's folder into
// `~/.local/share/fabrica/engine/<version>/` and the `~/.local/bin/fabrica` link over the old one, as
// the install script and `fabrica engine update` do. Last it runs `fabrica service install`, which
// installs the login service and (re)starts the engine from the link. On an update the old engine is
// asked to stop first (`fabrica engine stop`, which winds its runs down), and the service manager
// stops an engine it runs with SIGTERM, which winds them down too, before it starts the new one.

/** How long each step has on the host. */
const PROBE_TIME = Duration.minutes(1)
const STAGE_TIME = Duration.seconds(30)
const UPLOAD_TIME = Duration.minutes(30)
const PLACE_TIME = Duration.minutes(30)
/** The service manager waits up to two minutes on the engine's wind-down before it starts the new one. */
const SERVICE_TIME = Duration.minutes(5)

/** The archive's name in the install's folder on the host. */
const ARCHIVE_FILE = 'archive.tar.gz'

const unreachable = (failed: ShellFailed) =>
  InstallFailure.Unreachable({ reason: failed.message })

/** What a command said where it failed: its stderr, else its stdout, else its exit code. */
const saidBy = (ran: {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}): string =>
  [ran.stderr.trim(), ran.stdout.trim()].find(text => text !== '') ??
  `it exited ${ran.code}`

/** The host's facts, and the host judged. */
const probe = Effect.fn('EngineInstall.probe')(function* () {
  const ran = yield* runScript({
    script: probeScript,
    args: [],
    timeLimit: PROBE_TIME,
  }).pipe(Effect.mapError(unreachable))
  const facts = yield* Option.match(parseProbe(ran.stdout), {
    onNone: () => Effect.fail(InstallFailure.Unreadable({ said: saidBy(ran) })),
    onSome: Effect.succeed,
  })
  const judged = yield* Effect.fromResult(judgeHost(facts)).pipe(
    Effect.mapError(refusal => InstallFailure.HostRefused({ refusal })),
  )
  return { facts, judged }
})

/** What the check found, for the install to work from. */
interface Checked {
  readonly facts: HostFacts
  readonly judged: Judged
  readonly offered: Offered
  readonly check: HostCheck
}

/** The plan for the host's engine, and what was noted about it. */
const planFor = (
  facts: HostFacts,
  offered: Offered,
): { readonly plan: InstallPlan; readonly notes: ReadonlyArray<string> } => {
  const to = offered.version
  const install = InstallPlan.cases.Install.make({ to })
  return Option.match(facts.engine, {
    onNone: () => ({ plan: install, notes: [] }),
    onSome: said =>
      Option.match(engineRelease(said), {
        onNone: () => ({
          plan: install,
          notes: [
            `~/.local/bin/fabrica is there, but its --version says '${said}': the install replaces it.`,
          ],
        }),
        onSome: there => {
          const order = compareReleases(there, to)
          return {
            plan:
              order === 0
                ? InstallPlan.cases.Current.make({ version: there })
                : order < 0
                  ? InstallPlan.cases.Update.make({ from: there, to })
                  : InstallPlan.cases.Newer.make({ there, offered: to }),
            notes: [],
          }
        },
      }),
  })
}

const checked = Effect.fn('EngineInstall.checked')(function* (
  source: DistributionSource,
) {
  const { facts, judged } = yield* probe()
  const offered = yield* offeredFor({ source, target: judged.target })
  const { plan, notes } = planFor(facts, offered)
  return {
    facts,
    judged,
    offered,
    check: {
      host: judged.description,
      target: judged.target,
      plan,
      notes: [...judged.notes, ...notes],
    },
  } satisfies Checked
})

/** Checks the host: what it is, the engine there, and what installing `source`'s engine would do. */
export const checkHost = (
  source: DistributionSource,
): Effect.Effect<
  HostCheck,
  InstallFailure,
  HostShell | HttpClient.HttpClient
> => Effect.scoped(checked(source)).pipe(Effect.map(({ check }) => check))

/** A plan in words, as the user agreed to it or the host now asks for it. */
const planWords = InstallPlan.match({
  Install: ({ to }) => `installing ${to}`,
  Update: ({ from, to }) => `updating ${from} to ${to}`,
  Current: ({ version }) => `nothing: ${version} is there`,
  Newer: ({ there }) => `nothing: ${there}, a later engine, is there`,
})

const consentWords = InstallConsent.match({
  Install: ({ to }) => `installing ${to}`,
  Update: ({ from, to }) => `updating ${from} to ${to}`,
})

/** Whether the plan the host asks for now is the one the user agreed to. */
const agreed = (consent: InstallConsent, plan: InstallPlan): boolean =>
  InstallConsent.match(consent, {
    Install: ({ to }) => InstallPlan.guards.Install(plan) && plan.to === to,
    Update: ({ from, to }) =>
      InstallPlan.guards.Update(plan) && plan.from === from && plan.to === to,
  })

/**
 * Whether the engine is installed as a login service: always (a host's own login session keeps it), or
 * only where the user's systemd answers (a WSL2 distribution without systemd starts the engine through
 * the bridge at each connection instead, spec §7.6).
 */
export type LoginServiceUse = 'always' | 'where-systemd-runs'

/** What the install says where it installs no login service. */
export const noServiceWords =
  "systemd isn't running here, so no login service is installed: the engine starts when the app connects"

/** Makes the install's folder beside the engine's versions, private to the user. */
const stageScript = String.raw`set -eu
mkdir -p "$1"
mkdir -m 700 "$2"
`

/** Removes the install's folder, whatever is left in it. */
const cleanScript = String.raw`rm -rf -- "$1"
`

/**
 * Has the archive $9 in the stage $1 (downloaded from $8 where given, else sent there already), checks
 * its SHA-256 against $5, unpacks it, runs the launcher $6 of its folder $4 with `--version` in that
 * folder, stdout alone read, against $7, then renames the folder into the version's place $2 and the
 * link $3 over the old one. Prints `placed=<launcher>`, or `failed=<step>` and `detail=<what>`.
 */
const placeScript = String.raw`set -u
fail() {
  printf 'failed=%s\n' "$1"
  printf 'detail=%s\n' "$(printf '%s' "$2" | tr '\r\n' '  ' | cut -c 1-2000)"
  exit 1
}
stage=$1
file=$9
if [ -n "$8" ]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$file" "$8" </dev/null 2>"$stage/err" || fail download "$(cat "$stage/err")"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$file" "$8" </dev/null 2>"$stage/err" || fail download "$(cat "$stage/err")"
  else
    fail download "neither curl nor wget is here"
  fi
fi
[ -f "$file" ] || fail download "the archive isn't there"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$file" | awk '{ print $1 }')"
else
  got="$(shasum -a 256 "$file" | awk '{ print $1 }')"
fi
[ "$got" = "$5" ] || fail checksum "$got"
mkdir "$stage/x" || fail place "$stage/x"
tar -xzf "$file" -C "$stage/x" </dev/null 2>"$stage/err" || fail unpack "$(cat "$stage/err")"
new="$stage/x/$4"
[ -f "$new/$6" ] && [ -x "$new/$6" ] || fail launcher "$4/$6"
status=0
said="$(cd "$new" && "$new/$6" --version </dev/null 2>"$stage/err")" || status=$?
[ "$status" -eq 0 ] || fail run "it exited $status: $(cat "$stage/err")"
[ "$said" = "$7" ] || fail version "$said"
target=$2
links="$(dirname "$3")"
mkdir -p "$(dirname "$target")" "$links" || fail place "$links"
if [ -e "$target" ] || [ -L "$target" ]; then
  mv "$target" "$stage/old" || fail place "$target"
fi
if ! mv "$new" "$target"; then
  [ ! -e "$stage/old" ] || mv "$stage/old" "$target"
  fail place "$target"
fi
temporary="$links/.fabrica-install-$$"
ln -s "$target/$6" "$temporary" || fail place "$temporary"
if ! mv -f "$temporary" "$3"; then
  rm -f "$temporary"
  fail place "$3"
fi
printf 'placed=%s\n' "$target/$6"
`

/**
 * Asks the engine $1 (the old version's launcher, where this is an update) to wind its runs down and
 * stop, then installs the login service from the link $2, which (re)starts the engine from it. Where
 * $3 is `where-systemd-runs` and the user's systemd doesn't answer, it installs none, and says so.
 */
const serviceScript = String.raw`set -u
if [ -n "$1" ] && [ -x "$1" ]; then
  "$1" engine stop </dev/null >/dev/null 2>&1 || true
fi
if [ "$3" = where-systemd-runs ] && ! { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment </dev/null >/dev/null 2>&1; }; then
  printf '%s\n' "${noServiceWords}"
  exit 0
fi
exec "$2" service install </dev/null
`

/** The `name=value` lines of a script's stdout. */
const linesOf = (stdout: string): ReadonlyMap<string, string> =>
  new Map(
    stdout.split('\n').flatMap(line => {
      const equals = line.indexOf('=')
      return equals <= 0
        ? []
        : [[line.slice(0, equals), line.slice(equals + 1)] as const]
    }),
  )

/** The release failure the place script's `failed=` line names. */
const placeFailure = ({
  step,
  detail,
  offered,
  url,
}: {
  readonly step: string
  readonly detail: string
  readonly offered: Offered
  readonly url: string
}): Option.Option<UpdateFailure> => {
  const archive = offered.archive.name
  switch (step) {
    case 'download':
      return Option.some(UpdateFailure.DownloadFailed({ url, message: detail }))
    case 'checksum':
      return Option.some(
        UpdateFailure.ChecksumMismatch({
          archive,
          want: offered.archive.sha256,
          got: detail,
        }),
      )
    case 'unpack':
      return Option.some(
        UpdateFailure.UnpackFailed({ archive, message: detail }),
      )
    case 'launcher':
      return Option.some(UpdateFailure.NoLauncher({ path: detail }))
    case 'run':
      return Option.some(UpdateFailure.WontRun({ message: detail }))
    case 'version':
      return Option.some(
        UpdateFailure.WrongVersion({
          said: detail,
          want: versionLine(offered.version),
        }),
      )
    case 'place':
      return Option.some(
        UpdateFailure.PlaceFailed({
          path: detail,
          message: "the host couldn't write it",
        }),
      )
    default:
      return Option.none()
  }
}

/** Places the offered engine on the host from the stage: delivered, checked, unpacked and linked. */
const place = Effect.fn('EngineInstall.place')(function* ({
  source,
  found,
  stage,
}: {
  readonly source: DistributionSource
  readonly found: Checked
  readonly stage: string
}) {
  const { facts, offered } = found
  const places = installPlaces(facts.home)
  const ranStage = yield* runScript({
    script: stageScript,
    args: [places.engines, stage],
    timeLimit: STAGE_TIME,
  }).pipe(Effect.mapError(unreachable))
  if (ranStage.code !== 0) {
    return yield* Effect.fail(
      InstallFailure.Release({
        failure: UpdateFailure.PlaceFailed({
          path: stage,
          message: saidBy(ranStage),
        }),
      }),
    )
  }
  const delivery = yield* deliveryOf({
    source,
    offered,
    hostDownloads: facts.downloader !== 'none',
  })
  const archive = NodePath.posix.join(stage, ARCHIVE_FILE)
  const url = yield* Delivery.$match(delivery, {
    Download: ({ url }) => Effect.succeed(url),
    Upload: ({ file }) =>
      upload({
        file,
        to: archive,
        timeLimit: UPLOAD_TIME,
      }).pipe(
        Effect.mapError(unreachable),
        Effect.flatMap(ran =>
          ran.code === 0
            ? Effect.succeed('')
            : Effect.fail(
                InstallFailure.Unreachable({
                  reason: `couldn't send the archive to the host: ${saidBy(ran)}`,
                }),
              ),
        ),
      ),
  })
  const version = offered.version
  const ran = yield* runScript({
    script: placeScript,
    args: [
      stage,
      versionFolder({ places, version }),
      places.link,
      distributionName({ version, target: found.judged.target }),
      offered.archive.sha256,
      LAUNCHER,
      versionLine(version),
      url,
      archive,
    ],
    timeLimit: PLACE_TIME,
  }).pipe(Effect.mapError(unreachable))
  const said = linesOf(ran.stdout)
  const placed = said.get('placed')
  if (ran.code === 0 && placed !== undefined) {
    return { places, launcher: placed }
  }
  const failure = placeFailure({
    step: said.get('failed') ?? '',
    detail: said.get('detail') ?? '',
    offered,
    url: url === '' ? offered.archive.name : url,
  })
  return yield* Effect.fail(
    Option.match(failure, {
      onNone: () => InstallFailure.Unreadable({ said: saidBy(ran) }),
      onSome: failure => InstallFailure.Release({ failure }),
    }),
  )
})

/**
 * Installs or updates the engine on the host from `source`, as `consent` agreed: the host checked
 * again first, and nothing done where its plan isn't the one agreed to.
 */
export const installEngine = ({
  source,
  consent,
  loginService = 'always',
}: {
  readonly source: DistributionSource
  readonly consent: InstallConsent
  /** `always` unless given. */
  readonly loginService?: LoginServiceUse
}): Effect.Effect<
  EngineInstalled,
  InstallFailure,
  HostShell | HttpClient.HttpClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const found = yield* checked(source)
      if (!agreed(consent, found.check.plan)) {
        return yield* Effect.fail(
          InstallFailure.ConsentStale({
            consented: consentWords(consent),
            found: planWords(found.check.plan),
          }),
        )
      }
      const places = installPlaces(found.facts.home)
      const stage = NodePath.posix.join(
        places.engines,
        `.install-${randomBytes(6).toString('hex')}`,
      )
      const placed = yield* place({ source, found, stage }).pipe(
        Effect.ensuring(
          runScript({
            script: cleanScript,
            args: [stage],
            timeLimit: STAGE_TIME,
          }).pipe(Effect.ignore),
        ),
      )
      const old = InstallConsent.match(consent, {
        Install: () => '',
        Update: ({ from }) =>
          NodePath.posix.join(
            versionFolder({ places, version: from }),
            LAUNCHER,
          ),
      })
      const service = yield* runScript({
        script: serviceScript,
        args: [old, places.link, loginService],
        timeLimit: SERVICE_TIME,
      }).pipe(Effect.mapError(unreachable))
      if (service.code !== 0) {
        return yield* Effect.fail(
          InstallFailure.ServiceFailed({ said: saidBy(service) }),
        )
      }
      return {
        version: found.offered.version,
        launcher: placed.launcher,
        service: service.stdout.trim(),
      } satisfies EngineInstalled
    }),
  )

/** A check's answer for the app: what it found, or its failure in words. */
export const answerCheck = <R>(
  check: Effect.Effect<HostCheck, InstallFailure, R>,
): Effect.Effect<CheckAnswer, never, R> =>
  check.pipe(
    Effect.map(found => CheckAnswer.cases.Checked.make({ check: found })),
    Effect.catch(failure =>
      Effect.succeed(
        CheckAnswer.cases.Failed.make({
          reason: describeInstallFailure(failure),
        }),
      ),
    ),
  )

/** An install's answer for the app: what it installed, or its failure in words. */
export const answerInstall = <R>(
  install: Effect.Effect<EngineInstalled, InstallFailure, R>,
): Effect.Effect<InstallAnswer, never, R> =>
  install.pipe(
    Effect.map(installed => InstallAnswer.cases.Installed.make({ installed })),
    Effect.catch(failure =>
      Effect.succeed(
        InstallAnswer.cases.Failed.make({
          reason: describeInstallFailure(failure),
        }),
      ),
    ),
  )
