import { defineProject } from 'vitest/config'

import { testLimits } from '../testkit/src/limits.ts'

export default defineProject({
  test: {
    ...testLimits,
    name: 'ui',
    include: ['src/**/*.{test,spec}.ts', 'test/**/*.test.ts'],
    environment: 'happy-dom',
    // The theme tests read the theme's stylesheets and the handoff's themes.css as text (?raw), which
    // Vitest blanks unless it processes them.
    css: { include: [/\/(theme|console)\/[\w-]+\.css/] },
    setupFiles: ['./src/vitest-setup.ts'],
    // Installs Electron, once, before the files that draw in its windows run side by side.
    globalSetup: ['./test/electron.ts'],
    server: {
      deps: {
        inline: ['foldkit', '@foldkit/ui', '@foldkit/devtools'],
      },
    },
  },
})
