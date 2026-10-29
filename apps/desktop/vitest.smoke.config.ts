import { defineConfig } from 'vitest/config'

// The packaged app's smoke test (spec §22.3, §24), test/smoke.test.ts, run on one artifact's app:
// `FABRICA_SMOKE_APP=<its executable> pnpm --filter @fabrica/desktop smoke`, as .github/workflows/app.yml
// runs it on each artifact it builds. It is not one of the unit suite's (vitest.config.ts leaves it
// out): it needs a packaged app.
//
// The test reads nothing of the host's environment itself (spec §24): what it is given is read here, the
// app's executable and the few variables the app can't start without, the display's on Linux, and on
// Windows the system's own (there is no engine on Windows to keep from the host's PATH, §7.6).
const hostVariables =
  process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec']
    : ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']

const smokeHost: Record<string, string> = {}
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
