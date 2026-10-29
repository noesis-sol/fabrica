import { defineConfig } from 'electron-vite'
import { fileURLToPath } from 'node:url'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

// The workspace's packages are TypeScript sources, so main bundles them rather than loading them
// from node_modules at run time.
const workspacePackages = [
  '@fabrica/client',
  '@fabrica/contracts',
  '@fabrica/engine',
  '@fabrica/ui',
]

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        // Beside main, the connection process (spec §5): the utilityProcess main forks, built from
        // the same sources to out/main/connection.js.
        input: {
          index: fileURLToPath(new URL('src/main/index.ts', import.meta.url)),
          connection: fileURLToPath(
            new URL('src/connection/index.ts', import.meta.url),
          ),
        },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload can't load modules, so everything it imports is bundled into it.
      externalizeDeps: false,
      // A sandboxed preload runs as a classic script, so it is built as CommonJS.
      rollupOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    plugins: [tailwindcss(), foldkit()],
  },
})
