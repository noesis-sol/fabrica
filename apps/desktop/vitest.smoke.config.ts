import { defineConfig } from 'vitest/config'

// The packaged app's smoke test (spec §22.3, §24), test/smoke.test.ts, run on one artifact's app:
// `FABRICA_SMOKE_APP=<its executable> pnpm --filter @fabrica/desktop smoke`, as .github/workflows/app.yml
// runs it on each artifact it builds. It is not one of the unit suite's (vitest.config.ts leaves it
// out): it needs a packaged app.
//
// It runs on a developer's Mac as on CI's, an unsigned build too (fab-mgi.104): `pnpm --filter
// @fabrica/desktop run package --arm64` with CSC_IDENTITY_AUTO_DISCOVERY=false, then FABRICA_SMOKE_APP
// naming dist/mac-arm64/Fabrica.app/Contents/MacOS/Fabrica. The fuses leave Playwright's --inspect and
// --remote-debugging-port on. A local run used to fail where another Fabrica was open, the user's own or
// another run's: on macOS the app's data folder is the user's whatever HOME says, and the other instance
// held the single-instance lock in it, so the app under test quit at launch, or waited on a holder that
// didn't answer; packaged-app.ts now gives it a folder of the test's. One open from the same copy of the
// app still fails the last step, its processes being under the app's folder.
//
// The test reads nothing of the host's environment itself (spec §24): what it is given is read here, the
// app's executable and the few variables the app can't start without, the display's on Linux, and on
// Windows the system's own (there is no engine on Windows to keep from the host's PATH, §7.6).
const hostVariables =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec']
    : ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']

/** The host's variables the app can't start without, which the update test's config provides too. */
export const smokeHost: Record<string, string> = {}
for (const name of hostVariables) {
  const value = process.env[name]
  if (value !== undefined && value !== '') {
    smokeHost[name] = value
  }
}

export default defineConfig({
  test: {
    name: 'smoke',
    include: ['test/smoke.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    provide: {
      smokeApp: process.env['FABRICA_SMOKE_APP'] ?? '',
      smokeHost,
    },
  },
})
