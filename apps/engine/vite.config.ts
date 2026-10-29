import { defineConfig } from 'vite'

// The engine ships as one Node bundle (spec §22.1): every dependency is bundled in.
export default defineConfig({
  build: {
    ssr: 'src/main.ts',
    target: 'node26',
    outDir: 'dist',
    emptyOutDir: true,
  },
  ssr: {
    noExternal: true,
    target: 'node',
  },
})
