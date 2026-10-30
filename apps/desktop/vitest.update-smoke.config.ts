import { defineConfig } from 'vitest/config'

import { smokeHost } from './vitest.smoke.config.ts'

// The published app's update test (spec §22.2, §22.5), test/update-smoke.test.ts, run on an earlier
// release's AppImage once a release is published: `FABRICA_UPDATE_APP=<its AppImage>
// FABRICA_UPDATE_VERSION=<the release's version> pnpm --filter @fabrica/desktop smoke:update`, as
// .github/workflows/release.yml's `update` job runs it. It is not one of the unit suite's
// (vitest.config.ts leaves it out): it needs a published release, and downloads it.
//
// What it is given is read here, as the smoke test's config reads it: the app, the version, and the
// host's few variables the app can't start without.
export default defineConfig({
  test: {
    name: 'update-smoke',
    include: ['test/update-smoke.test.ts'],
    // Two launches, and the release's download between them.
    testTimeout: 20 * 60_000,
    hookTimeout: 60_000,
    provide: {
      updateApp: process.env['FABRICA_UPDATE_APP'] ?? '',
      updateVersion: process.env['FABRICA_UPDATE_VERSION'] ?? '',
      smokeHost,
    },
  },
})
