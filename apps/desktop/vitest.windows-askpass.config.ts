import { defineConfig } from 'vitest/config'

import { smokeHost } from './vitest.smoke.config.ts'

// The Windows app's `SSH_ASKPASS` helper's test (spec §9.1), test/windows-askpass.test.ts, on an installed
// app's resources and a stub ssh built from test/stub-ssh.c: `FABRICA_ASKPASS_RESOURCES=<resources>
// FABRICA_ASKPASS_STUB_SSH=<stub> pnpm --filter @fabrica/desktop test:windows-askpass`, as
// .github/workflows/app.yml runs it on Windows. It is not one of the unit suite's (vitest.config.ts leaves
// it out): it needs the built helper, which only Windows builds.
//
// The test reads nothing of the host's environment itself (spec §24): what it is given is read here.
export default defineConfig({
  test: {
    name: 'windows-askpass',
    include: ['test/windows-askpass.test.ts'],
    testTimeout: 60_000,
    provide: {
      askpassResources: process.env['FABRICA_ASKPASS_RESOURCES'] ?? '',
      askpassStubSsh: process.env['FABRICA_ASKPASS_STUB_SSH'] ?? '',
      askpassHost: smokeHost,
    },
  },
})
