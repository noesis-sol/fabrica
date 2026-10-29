import { defineConfig } from 'electron-vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {
    // A sandboxed preload runs as a classic script, so it is built as CommonJS.
    build: { rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    plugins: [tailwindcss(), foldkit()],
  },
})
