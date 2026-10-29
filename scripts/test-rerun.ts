// scripts/test-rerun.ts: `pnpm test`, Vitest with reruns (spec §24, H55, H88). It runs `vitest run`
// with its arguments, then reruns each file's failed tests together in one process, the files side by
// side in as many processes as test workers (`workers.ts`). A test that passes on its rerun prints
// FLAKY: <file> > <test>, and the suite passes; one that fails again prints FAILED: <file> > <test>,
// and the suite fails. Which tests are rerun, and what their reruns say, `rerun.ts` decides.
//
// A rerun's process is this script again, given a `RerunRequest`: it runs Vitest through its Node API
// on the one file, with the first run's options and none of its file filters.
//
// Node runs this file itself (`node scripts/test-rerun.ts`), stripping its types: it imports modules
// by their `.ts` paths, and they import no relative module.

import { Option } from 'effect'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCLI, startVitest } from 'vitest/node'

import { reportVariable } from '../packages/testkit/src/rerun-variable.ts'
import {
  Plan,
  type Rerun,
  type RerunRequest,
  type RunReport,
  decodeRerunRequest,
  decodeRunReport,
  judgeRerun,
  outcomeLine,
  planReruns,
  rerunRequest,
} from '../packages/testkit/src/rerun.ts'
import {
  testWorkers,
  workerFactsOfProcess,
} from '../packages/testkit/src/workers.ts'

const vitest = NodePath.join(
  NodePath.dirname(
    createRequire(import.meta.url).resolve('vitest/package.json'),
  ),
  'vitest.mjs',
)
const reporter = fileURLToPath(
  new URL('../packages/testkit/src/rerun-reporter.ts', import.meta.url),
)
/** The argument before a `RerunRequest` that makes this process a rerun's. */
const rerunFlag = '--fabrica-rerun'
const args = process.argv.slice(2)

interface Ran {
  readonly code: number
  /** What it printed, where it ran quiet. */
  readonly output: string
  readonly report: Option.Option<RunReport>
}

/** Runs Node with `argv`, a Vitest run whose reporter writes to `reportPath`. */
const runVitest = (
  argv: ReadonlyArray<string>,
  reportPath: string,
  quiet: boolean,
): Promise<Ran> =>
  new Promise(resolve => {
    const chunks: Array<Buffer> = []
    const child = spawn(process.execPath, argv, {
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, [reportVariable]: reportPath },
    })
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk))
    const finish = (code: number) =>
      void readFile(reportPath, 'utf8')
        .catch(() => '')
        .then(text =>
          resolve({
            code,
            output: Buffer.concat(chunks).toString('utf8'),
            report: decodeRunReport(text),
          }),
        )
    child.on('error', error => {
      chunks.push(Buffer.from(`${error.message}\n`))
      finish(1)
    })
    child.on('close', code => finish(code ?? 1))
  })

/** `f` over `items`, at most `size` at a time, the results in the items' order. */
const inPool = async <A, B>(
  items: ReadonlyArray<A>,
  size: number,
  f: (item: A, index: number) => Promise<B>,
): Promise<ReadonlyArray<B>> => {
  const results = new Map<number, B>()
  const queue = items.entries()
  const worker = async () => {
    for (const [index, item] of queue) results.set(index, await f(item, index))
  }
  await Promise.all(Array.from({ length: Math.max(1, size) }, worker))
  return items.flatMap((_, index) => {
    const result = results.get(index)
    return result === undefined ? [] : [result]
  })
}

const rerunAll = async (
  reruns: ReadonlyArray<Rerun>,
  reports: string,
): Promise<number> => {
  const cwd = process.cwd()
  console.log(
    `\nRERUN: ${reruns.length} file${reruns.length === 1 ? '' : 's'} with failures`,
  )
  const outcomes = await inPool(
    reruns,
    testWorkers(workerFactsOfProcess()),
    async (rerun, index) => {
      const request = JSON.stringify(rerunRequest(rerun, args))
      const ran = await runVitest(
        [fileURLToPath(import.meta.url), rerunFlag, request],
        NodePath.join(reports, `rerun-${index}.json`),
        true,
      )
      console.log(
        `\nRERUN: ${NodePath.relative(cwd, rerun.file)}\n${ran.output}`,
      )
      return judgeRerun(rerun, ran.report)
    },
  )
  const lines = outcomes.flat().map(outcome => outcomeLine(outcome, cwd))
  console.log(lines.join('\n'))
  return lines.some(line => line.startsWith('FAILED: ')) ? 1 : 0
}

/** The first run: `vitest run` with the script's arguments. */
const runFirst = async (reports: string): Promise<number> => {
  const first = await runVitest(
    [vitest, 'run', ...args, '--reporter=default', `--reporter=${reporter}`],
    NodePath.join(reports, 'first.json'),
    false,
  )
  return Option.match(first.report, {
    onNone: () => {
      console.error(
        'test-rerun: Vitest ended without a report; nothing to rerun',
      )
      return Promise.resolve(first.code === 0 ? 1 : first.code)
    },
    onSome: report =>
      Plan.$match(planReruns(report), {
        Passed: () => Promise.resolve(first.code),
        Broken: ({ errors }) => {
          for (const error of errors)
            console.log(
              `FAILED: an error no test file can be blamed for: ${error.message}`,
            )
          return Promise.resolve(1)
        },
        Rerun: ({ reruns }) => rerunAll(reruns, reports),
      }),
  })
}

/** A rerun's process: Vitest on the request's file, with the first run's options. */
const runRerun = async (request: RerunRequest): Promise<void> => {
  const { options } = parseCLI(['vitest', 'run', ...request.args])
  const ctx = await startVitest([request.file], {
    ...options,
    run: true,
    watch: false,
    ...(request.project === '' ? {} : { project: request.project }),
    ...(request.testNamePattern === undefined
      ? {}
      : { testNamePattern: request.testNamePattern }),
    reporters: ['default', reporter],
  })
  await ctx.exit()
}

if (args[0] === rerunFlag)
  await Option.match(decodeRerunRequest(args[1] ?? ''), {
    onNone: () => {
      console.error(`test-rerun: ${rerunFlag} takes a rerun request`)
      process.exitCode = 1
      return Promise.resolve()
    },
    onSome: runRerun,
  })
else {
  const reports = await mkdtemp(NodePath.join(tmpdir(), 'fabrica-rerun-'))
  process.exitCode = await runFirst(reports).finally(() =>
    rm(reports, { recursive: true, force: true }),
  )
}
