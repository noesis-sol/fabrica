import { defineConfig } from 'electron-vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

// The workspace's packages are TypeScript sources, so main bundles them rather than loading them
// from node_modules at run time.
const workspacePackages = [
  '@fabrica/contracts',
  '@fabrica/engine',
  '@fabrica/ui',
]

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspacePackages } },
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
