// The environment variable naming the file `rerun-reporter.ts` writes its report to, for
// scripts/test-rerun.ts. A module of its own, importing nothing: the reporter loads in Vitest's main
// process, where Vite's module runner can't load `effect`.
export const reportVariable = 'FABRICA_RERUN_REPORT'
