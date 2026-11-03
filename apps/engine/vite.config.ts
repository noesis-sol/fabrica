import { defineConfig } from 'vite'

// The engine ships as one Node bundle (spec §22.1): every dependency is bundled in, but DuckDB, whose
// native library is loaded from its own package where the engine's host has it (§21, §22.4).
// pi-ai's provider APIs are dynamic imports, which stay in the one file: the distribution ships
// `main.js` alone.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node26',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  ssr: {
    noExternal: true,
    external: ['@duckdb/node-api'],
    target: 'node',
  },
})
