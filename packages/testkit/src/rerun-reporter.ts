import { writeFile } from 'node:fs/promises'
import type { Reporter, SerializedError, TestModule } from 'vitest/node'

import type { RunReport } from './rerun'
import { reportVariable } from './rerun-variable'

// The Vitest reporter scripts/test-rerun.ts adds to each run: it writes what ran, failed and broke to
// the file `rerun-variable.ts` names, for the script to plan and judge reruns by (`rerun.ts`).

const moduleReport = (module: TestModule): RunReport['modules'][number] => ({
  file: module.moduleId,
  project: module.project.name,
  failed: [...module.children.allTests('failed')].map(test => test.fullName),
  passed: [...module.children.allTests('passed')].map(test => test.fullName),
  errors: [module, ...module.children.allSuites()].flatMap(suite =>
    suite.errors().map(error => error.message),
  ),
})

export default class RerunReporter implements Reporter {
  async onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
  ): Promise<void> {
    const path = process.env[reportVariable]
    if (path === undefined) return
    const report: RunReport = {
      modules: testModules.map(moduleReport),
      unhandled: unhandledErrors.map(error => ({
        message: error.message,
        stack: error.stack ?? '',
      })),
    }
    await writeFile(path, JSON.stringify(report))
  }
}
