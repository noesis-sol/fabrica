import { Effect, Option } from 'effect'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import { runProject } from '../src/run'
import { readEvents } from '../src/runlog'
import { WorkGraph } from '../src/workgraph'
import {
  dockerRootless,
  installStub,
  stubDistribution,
  writeStubScript,
} from './container-stub'
import {
  configOf,
  fakeProvider,
  maintainer,
  ofKind,
  phasesOf,
  project,
  run,
  services,
  setUpFixtures,
  settings,
} from './verifier-harness'

// A verifier in a container (spec §12.7, §13.6, §13.8): each agent gets a container of its own, so its
// setup commands run again for the verifier; a change that breaks them passes in its worker's container
// and fails in its verifier's. That is the change's setup failing, not a tool's defect.

beforeAll(setUpFixtures)

describe('a verifier in a container', () => {
  it.effect(
    'whose setup fails leaves its ticket waiting on a setup failure',
    () =>
      Effect.gen(function* () {
        const fixture = project({
          ...settings,
          verifier: { enabled: true, rounds: 3 },
          container: { devcontainer: '.devcontainer/devcontainer.json' },
        })
        const root = dirname(fixture.sockets)
        const base = join(root, 'ctr')
        mkdirSync(base, { recursive: true })
        const script = join(base, 'stub-cli')
        writeStubScript(script)
        const distribution = stubDistribution({
          base,
          node: process.execPath,
          cli: join(root, 'pi-stub.mjs'),
        })
        const cli = installStub({
          script,
          base: root,
          clis: ['docker'],
          distribution: distribution.root,
        })
        cli.answerInfo('docker', dockerRootless)
        const count = join(base, 'count')
        // Passes for the worker's container, and fails for the verifier's.
        const devcontainer = JSON.stringify({
          image: 'node:26',
          postCreateCommand: `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}; test "$n" -eq 0`,
        })
        const provider = yield* fakeProvider
        const { events, id } = yield* Effect.gen(function* () {
          const graph = yield* WorkGraph
          const made = yield* graph.create({
            ticket: {
              type: 'task',
              title: 'Add the widget',
              description: 'Adds the widget.\n\nverify: PASS',
              acceptance: 'The widget is there.',
            },
            actor: maintainer,
          })
          yield* runProject({
            ...configOf(fixture),
            containers: {
              platform: 'linux',
              uid: 1000,
              gid: 1000,
              enginePriority: 0,
              memory: 1024 ** 3,
              environment: {},
              distribution: Effect.succeed(distribution),
              readFile: path =>
                Effect.succeed(
                  Option.some(
                    path.endsWith('devcontainer.json')
                      ? devcontainer
                      : 'cpu memory pids',
                  ),
                ),
            },
          })
          const read = yield* readEvents({
            root: fixture.checkout,
            run: Option.some(run),
          })
          return { events: read.events, id: made.id }
        }).pipe(Effect.provide(services(fixture, provider.url)))
        const warnings = ofKind(events, 'warn').map(({ text }) => text)
        expect(warnings.some(text => text.includes('SETUP_FAILED'))).toBe(true)
        expect(JSON.stringify(events)).not.toContain('TOOL_DEFECT')
        expect(phasesOf(events, id)).toContain('verifying (finished)')
        // Its worker's container and its verifier's, both removed.
        const kinds = cli.calls().map(([, subcommand]) => subcommand)
        expect(kinds.filter(kind => kind === 'run')).toHaveLength(2)
        expect(kinds.at(-1)).toBe('rm')
      }).pipe(Effect.scoped),
  )
})
