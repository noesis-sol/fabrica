import { Data } from 'effect'

import { type UpdateFailure, describeFailure } from '@fabrica/engine/update'

// Why the app didn't install or update an engine on a host (spec §9.2, §22.4): one tagged union, made by
// its constructors, each step failing with its own. A release's own failures, its signature, its sums,
// its unpacking and its launcher, are the engine's update's (`UpdateFailure`), whether the app or the
// host found them, so `fabrica engine update` and the app say them in the same words.

/** Why the host can't run an engine: what the install script refuses it for, too (scripts/install.sh). */
export type HostRefusal = Data.TaggedEnum<{
  /** No engine distribution for the host's system or CPU. */
  NoTarget: { readonly kernel: string; readonly machine: string }
  /** The engine's Node needs macOS 13.5 or later. */
  MacosTooOld: { readonly version: string }
  /** The engine is built against glibc; musl (Alpine) is out of scope (§4). */
  Musl: {}
  /** The engine's Node needs glibc 2.28 or later. */
  GlibcTooOld: { readonly version: string }
  /** The engine's Node links libatomic.so.1, which slim images leave out. */
  NoLibatomic: {}
  /** An x64 CPU without what a component of the engine needs (§22.4). */
  CpuLacks: { readonly component: string; readonly flag: string }
  /** A tool the install runs on the host isn't there. */
  NoTool: { readonly tool: string }
}>
export const HostRefusal = Data.taggedEnum<HostRefusal>()

export type InstallFailure = Data.TaggedEnum<{
  /** The host couldn't be reached, or a command of the install couldn't be run there. */
  Unreachable: { readonly reason: string }
  /** The host's answer to the check couldn't be read. */
  Unreadable: { readonly said: string }
  /** The host can't run an engine. */
  HostRefused: { readonly refusal: HostRefusal }
  /** The distribution offered holds no engine for the host's target: another architecture's, or system's. */
  ArchitectureMismatch: {
    readonly target: string
    readonly offered: ReadonlyArray<string>
  }
  /** A step of the release's failed: its signature, a download, its sum, unpacking it, its launcher. */
  Release: { readonly failure: UpdateFailure }
  /** The host isn't as the user saw it when they agreed: its engine changed since the check. */
  ConsentStale: { readonly consented: string; readonly found: string }
  /** `fabrica service install` failed on the host. */
  ServiceFailed: { readonly said: string }
}>
export const InstallFailure = Data.taggedEnum<InstallFailure>()

/** What a host refusal says, in words. */
export const describeRefusal = HostRefusal.$match({
  NoTarget: ({ kernel, machine }) =>
    `there is no engine distribution for ${kernel} ${machine}: releases have macOS and Linux, arm64 and x64`,
  MacosTooOld: ({ version }) =>
    `the engine needs macOS 13.5 or later, and the host has macOS ${version}`,
  Musl: () =>
    "the engine needs glibc 2.28 or later, and the host's C library is musl (Alpine): install it on a glibc distribution, or in a container of one",
  GlibcTooOld: ({ version }) =>
    `the engine needs glibc 2.28 or later, and the host has glibc ${version}`,
  NoLibatomic: () =>
    "the engine's Node needs libatomic.so.1, which the host hasn't: install it (apt-get install libatomic1, dnf install libatomic, or zypper install libatomic1) and try again",
  CpuLacks: ({ component, flag }) =>
    `${component}, in the engine, needs an x64 CPU with ${flag.toUpperCase()}, and the host's has none`,
  NoTool: ({ tool }) =>
    `the install needs ${tool} on the host, and it isn't there`,
})

/** What an install failure says, in words. */
export const describeInstallFailure = InstallFailure.$match({
  Unreachable: ({ reason }) => reason,
  Unreadable: ({ said }) =>
    `the host's answer to the check couldn't be read${said.trim() === '' ? '' : `: ${said.trim()}`}`,
  HostRefused: ({ refusal }) =>
    `${describeRefusal(refusal)}. Nothing was installed`,
  ArchitectureMismatch: ({ target, offered }) =>
    `the engine offered is for ${offered.length === 0 ? 'no host' : offered.join(', ')}, and the host is ${target}: nothing was installed`,
  Release: ({ failure }) => describeFailure(failure),
  ConsentStale: ({ consented, found }) =>
    `the host's engine changed since it was checked (you agreed to ${consented}; it now asks for ${found}): check it again`,
  ServiceFailed: ({ said }) =>
    `the engine was installed, but its login service wasn't: ${said}`,
})
