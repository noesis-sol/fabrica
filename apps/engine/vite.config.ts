import { defineConfig } from 'vite'

// The engine ships as one Node bundle (spec §22.1): every dependency is bundled in, but DuckDB, whose
// native library is loaded from its own package where the engine's host has it (§21, §22.4).
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node26',
    outDir: 'dist',
    emptyOutDir: true,
  },
  ssr: {
    noExternal: true,
    external: ['@duckdb/node-api'],
    target: 'node',
  },
})
