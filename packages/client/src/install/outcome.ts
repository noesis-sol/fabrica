import { Option, Schema } from 'effect'

import { ReleaseVersion } from '@fabrica/contracts'

import { SshDestination } from '../destination'
import { WslDistro } from '../wsl-host'

// What installing an engine on a host comes to (spec §9.2, §8.4), as the app's renderer asks for it and
// shows it: the host to install on, what its check found and proposes, the user's consent to it, and
// the outcome. Each crosses from the app's main process to the renderer and is decoded there, so this
// module has no Node in it; the steps themselves are `@fabrica/client/install`'s.

/** The host an engine is installed on: this machine, one reached through SSH, or a WSL2 distribution. */
export const EngineHost = Schema.TaggedUnion({
  Local: {},
  Ssh: { destination: SshDestination },
  Wsl: { distro: WslDistro },
})
export type EngineHost = typeof EngineHost.Type

/** What the check proposes, from the host's engine and the release offered. */
export const InstallPlan = Schema.TaggedUnion({
  /** No engine there: install the one offered. */
  Install: { to: ReleaseVersion },
  /** An older engine there: update it, with the user's consent. */
  Update: { from: ReleaseVersion, to: ReleaseVersion },
  /** The engine offered is there already. */
  Current: { version: ReleaseVersion },
  /** A later engine is there than the one offered: the app is the one to update. */
  Newer: { there: ReleaseVersion, offered: ReleaseVersion },
})
export type InstallPlan = typeof InstallPlan.Type

/** What the check of a host found. */
export const HostCheck = Schema.Struct({
  /** The host's system, in words: `Linux x86_64, glibc 2.39`. */
  host: Schema.String,
  /** The engine target it runs: `linux-x64`. */
  target: Schema.String,
  plan: InstallPlan,
  /** What the check couldn't tell, and went on without. */
  notes: Schema.Array(Schema.String),
})
export type HostCheck = typeof HostCheck.Type

/** What the user agreed to: a plan that installs something. */
export const InstallConsent = Schema.TaggedUnion({
  Install: { to: ReleaseVersion },
  Update: { from: ReleaseVersion, to: ReleaseVersion },
})
export type InstallConsent = typeof InstallConsent.Type

/** An engine installed and started. */
export const EngineInstalled = Schema.Struct({
  version: ReleaseVersion,
  /** Its `fabrica`, in its version's folder on the host. */
  launcher: Schema.String,
  /** What `fabrica service install` said: the service, and the linger where it couldn't enable it. */
  service: Schema.String,
})
export type EngineInstalled = typeof EngineInstalled.Type

/** A check's answer: what it found, or why it couldn't, in words. */
export const CheckAnswer = Schema.TaggedUnion({
  Checked: { check: HostCheck },
  Failed: { reason: Schema.String },
})
export type CheckAnswer = typeof CheckAnswer.Type

/** An install's answer: what it installed, or why it didn't, in words. */
export const InstallAnswer = Schema.TaggedUnion({
  Installed: { installed: EngineInstalled },
  Failed: { reason: Schema.String },
})
export type InstallAnswer = typeof InstallAnswer.Type

/** What a plan installs, as the user agrees to it; none for a plan that installs nothing. */
export const consentFor = (plan: InstallPlan): Option.Option<InstallConsent> =>
  InstallPlan.match(plan, {
    Install: ({ to }) => Option.some(InstallConsent.cases.Install.make({ to })),
    Update: ({ from, to }) =>
      Option.some(InstallConsent.cases.Update.make({ from, to })),
    Current: () => Option.none(),
    Newer: () => Option.none(),
  })
