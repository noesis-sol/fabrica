import { Option } from 'effect'
import { availableParallelism } from 'node:os'

// How many test files run side by side (spec §24, H55, H88): as many as the run's share of the cores
// (`FABRICA_CORES`), every core on CI, half the machine's elsewhere. tutti's suite ran one file at a
// time on one of ten cores (224 s), and in parallel took 51–70 s; at every core, timing-sensitive
// tests failed. The root Vitest config and the rerun script both count their workers here.
//
// This module is loaded by Node itself (scripts/test-rerun.ts) as well as by Vite: it imports no
// relative module.

/** What the worker count is decided from, read once from the process (`workerFactsOfProcess`). */
export interface WorkerFacts {
  /** `FABRICA_CORES` as the environment gives it. */
  readonly fabricaCores: Option.Option<string>
  /** `CI` as the environment gives it. */
  readonly ci: Option.Option<string>
  /** The machine's cores: `os.availableParallelism()`. */
  readonly machineCores: number
}

/** The cores a `FABRICA_CORES` value names: a whole number from 1; none for other text. */
export const parseCores = (text: string): Option.Option<number> =>
  /^[1-9][0-9]*$/u.test(text.trim())
    ? Option.some(Number(text.trim()))
    : Option.none()

/** Whether a `CI` value says the run is on CI: any value but empty, `0` and `false`. */
export const isCi = (text: string): boolean =>
  !['', '0', 'false'].includes(text.trim().toLowerCase())

/** The number of test files that run side by side. */
export const testWorkers = (facts: WorkerFacts): number =>
  Option.getOrElse(Option.flatMap(facts.fabricaCores, parseCores), () =>
    Option.exists(facts.ci, isCi)
      ? Math.max(1, facts.machineCores)
      : Math.max(1, Math.floor(facts.machineCores / 2)),
  )

/** The facts as this process has them: the one place the test runner reads them. */
export const workerFactsOfProcess = (): WorkerFacts => ({
  fabricaCores: Option.fromNullishOr(process.env['FABRICA_CORES']),
  ci: Option.fromNullishOr(process.env['CI']),
  machineCores: availableParallelism(),
})
