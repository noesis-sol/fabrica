import type { ProjectTrustEventResult } from '@earendil-works/pi-coding-agent'

// The extension's part in Pi's `project_trust` step (spec §12.1, §20.2), which runs before a
// project's own Pi resources load (its `.pi/` extensions, settings and packages, and its
// `.agents/skills`): refused until the user trusts the project, and never remembered in Pi's own
// trust store, so the engine's word holds each time an agent starts.

/** Pi's trust decision for the project. */
export const projectTrust = (trusted: boolean): ProjectTrustEventResult => ({
  trusted: trusted ? 'yes' : 'no',
  remember: false,
})
