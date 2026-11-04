import { Duration, Effect, Fiber, Layer, Option, Ref, Result } from 'effect'
import { TestClock } from 'effect/testing'
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'
import {
  SpecCommitKey,
  SpecEnvironmentKey,
  SpecSha256Key,
  type Ticket,
  TicketId,
  RunMode as WireMode,
} from '@fabrica/contracts'

import { layer as gitLayer } from '../src/git'
import { layer as runnerLayer } from '../src/process'
import { makeSelfSigned } from '../src/rpc/certificate'
import { RunMode, runProject } from '../src/run'
import { shownMode } from '../src/run/spec-mode'
import {
  type ReadSpec,
  SpecFetching,
  SpecProblem,
  commitSpec,
  copyName,
  fetchSpec,
  filedKey,
  githubFile,
  narrowWarning,
  readSpec,
  specSource,
  treeShape,
} from '../src/spec'
import { WorkGraph, type WorkGraphShape, descendants } from '../src/workgraph'
import {
  binFolder,
  commit,
  configOf,
  eventsOf,
  git,
  gitConfig,
  liveDeadlines,
  ofKind,
  options,
  project,
  runOf,
  runnerConfig,
  setUpRuns,
  settings,
  withRuns,
} from './run-harness'

// Spec runs (spec §15.5, H83): a spec's URL fetched from a local https stub, whose GitHub stands in for
// GitHub's raw files and API, and `gh` a stub on the PATH commands run with; its commit in real git; and
// whole runs, the live organ runtime's session over the run harness's stub of Pi, which plays the
// breakdown from the checkout's `breakdown.json`, and the live work graph.

beforeAll(setUpRuns)

const certificate = makeSelfSigned({
  name: 'localhost',
  now: Date.UTC(2020, 0, 1),
})

type Route = (
  headers: IncomingHttpHeaders,
  response: ServerResponse,
  url: string,
) => void

const text =
  (body: string, type = 'text/markdown'): Route =>
  (_headers, response) => {
    response.writeHead(200, { 'content-type': type })
    response.end(body)
  }

const redirect =
  (location: string): Route =>
  (_headers, response) => {
    response.writeHead(302, { location })
    response.end()
  }

/** An https server on loopback, answering by the request's path; its base URL and what it was sent. */
const stubServer = (
  routes: (base: string) => Readonly<Record<string, Route>>,
) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly base: string
      readonly sent: Array<{
        readonly url: string
        readonly headers: IncomingHttpHeaders
      }>
      readonly close: () => void
    }>(resume => {
      const sent: Array<{
        readonly url: string
        readonly headers: IncomingHttpHeaders
      }> = []
      let base = ''
      const server = createServer(
        { cert: certificate.certificate, key: certificate.key },
        (request, response) => {
          const url = request.url ?? ''
          sent.push({ url, headers: request.headers })
          const route = routes(base)[url.split('?')[0] ?? '']
          if (route === undefined) {
            response.writeHead(404)
            response.end()
          } else route(request.headers, response, url)
        },
      )
      server.listen(0, 'localhost', () => {
        const address = server.address()
        base = `https://localhost:${typeof address === 'object' && address !== null ? address.port : 0}`
        resume(
          Effect.succeed({
            base,
            sent,
            close: () => {
              server.closeAllConnections()
              server.close()
            },
          }),
        )
      })
    }),
    ({ close }) => Effect.sync(close),
  )

/** `effect` on real git and the runner, trusting the stub at `base` as GitHub. */
const onStub = <A, E, R>(effect: Effect.Effect<A, E, R>, base: string) =>
  Effect.gen(function* () {
    return yield* effect.pipe(
      Effect.provideService(SpecFetching, {
        ca: Option.some(certificate.certificate),
        hosts: { raw: `${base}/raw`, api: `${base}/api` },
      }),
    )
  }).pipe(
    Effect.provide(
      Layer.suspend(() =>
        Layer.provideMerge(
          gitLayer(gitConfig),
          Layer.provideMerge(runnerLayer(runnerConfig()), liveDeadlines),
        ),
      ),
    ),
  )

/** The problem reading `given` comes to, or the spec it reads. */
const readFrom = (checkout: string, given: string, base: string) =>
  onStub(Effect.result(readSpec({ checkout, given })), base)

const problemOf = (read: Result.Result<ReadSpec, unknown>): string => {
  if (Result.isSuccess(read)) throw new Error('the spec was read')
  if (read.failure instanceof SpecProblem) return read.failure.problem
  throw new Error(`not a problem with the spec: ${String(read.failure)}`)
}

const specOf = (read: Result.Result<ReadSpec, unknown>): ReadSpec => {
  if (Result.isFailure(read)) throw new Error(String(read.failure))
  return read.success
}

describe('A spec at a URL (§15.5, H83)', () => {
  it.effect(
    'is fetched with no credentials or cookies, and recorded without its query and fragment',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const server = yield* stubServer(() => ({
          '/specs/shop': text('# The shop\n'),
        }))
        const spec = specOf(
          yield* readFrom(
            fixture.checkout,
            `${server.base}/specs/shop?token=sekret#part`,
            server.base,
          ),
        )
        expect(spec.path).toBe('.fabrica/specs/shop.md')
        expect(spec.text).toBe('# The shop\n')
        expect(spec.source).toEqual(Option.some(`${server.base}/specs/shop`))
        expect(spec.url).toEqual(Option.some(`${server.base}/specs/shop`))
        const [request] = server.sent
        expect(request?.url).toBe('/specs/shop?token=sekret')
        expect(request?.headers['authorization']).toBeUndefined()
        expect(request?.headers['cookie']).toBeUndefined()
      }),
  )

  it.effect('follows up to 5 redirects, and no more', () =>
    Effect.gen(function* () {
      const fixture = project()
      const hops = (count: number): Record<string, Route> =>
        Object.fromEntries(
          Array.from({ length: count }, (_, at) => [
            `/c${count}/${at}`,
            redirect(at + 1 === count ? '/spec.md' : `/c${count}/${at + 1}`),
          ]),
        )
      const server = yield* stubServer(() => ({
        ...hops(5),
        ...hops(6),
        '/spec.md': text('# Spec\n'),
      }))
      expect(
        specOf(
          yield* readFrom(fixture.checkout, `${server.base}/c5/0`, server.base),
        ).text,
      ).toBe('# Spec\n')
      expect(
        problemOf(
          yield* readFrom(fixture.checkout, `${server.base}/c6/0`, server.base),
        ),
      ).toContain('redirected more than 5 times')
    }),
  )

  it.effect('refuses a redirect over http', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/spec.md': redirect('http://elsewhere.invalid/spec.md'),
      }))
      expect(
        problemOf(
          yield* readFrom(
            fixture.checkout,
            `${server.base}/spec.md`,
            server.base,
          ),
        ),
      ).toContain('redirected to elsewhere.invalid over http')
    }),
  )

  it.effect('refuses a redirect holding a user name or password', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(base => ({
        '/spec.md': redirect(base.replace('https://', 'https://me:pw@')),
      }))
      expect(
        problemOf(
          yield* readFrom(
            fixture.checkout,
            `${server.base}/spec.md`,
            server.base,
          ),
        ),
      ).toContain('with a user name or password')
      expect(server.sent).toHaveLength(1)
    }),
  )

  it.effect('refuses what is over 5 MB, whether it says so or not', () =>
    Effect.gen(function* () {
      const fixture = project()
      const big = 'x'.repeat(5 * 1024 * 1024 + 1)
      const server = yield* stubServer(() => ({
        '/said.md': (_headers, response) => {
          response.writeHead(200, { 'content-length': big.length })
          response.end(big)
        },
        '/unsaid.md': (_headers, response) => {
          response.writeHead(200)
          response.write(big)
          response.end()
        },
      }))
      for (const path of ['said', 'unsaid'])
        expect(
          problemOf(
            yield* readFrom(
              fixture.checkout,
              `${server.base}/${path}.md`,
              server.base,
            ),
          ),
        ).toContain('is more than 5 MB')
    }),
  )

  it.effect('refuses an HTML answer, by what it says or how it opens', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/said.md': text('# Looks like text\n', 'text/html; charset=utf-8'),
        '/opens.md': text('<!DOCTYPE html>\n<html></html>\n', 'text/plain'),
      }))
      for (const path of ['said', 'opens'])
        expect(
          problemOf(
            yield* readFrom(
              fixture.checkout,
              `${server.base}/${path}.md`,
              server.base,
            ),
          ),
        ).toContain('gave a web page, not a spec')
    }),
  )

  it.effect("says why a fetch failed: the status, or what isn't text", () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/binary.md': (_headers, response) => {
          response.writeHead(200)
          response.end(Buffer.from([0, 1, 2]))
        },
        '/empty.md': text('  \n'),
      }))
      const problem = (path: string) =>
        readFrom(fixture.checkout, `${server.base}/${path}`, server.base).pipe(
          Effect.map(problemOf),
        )
      expect(yield* problem('gone.md')).toContain('HTTP 404 Not Found')
      expect(yield* problem('binary.md')).toContain("isn't text")
      expect(yield* problem('empty.md')).toContain('is empty')
    }),
  )

  it.effect('gives up past 30 s', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/stalled.md': () => undefined,
      }))
      const fiber = yield* Effect.forkChild(
        readFrom(fixture.checkout, `${server.base}/stalled.md`, server.base),
      )
      yield* Effect.gen(function* () {
        while (server.sent.length === 0)
          yield* TestClock.withLive(Effect.sleep('5 millis'))
      })
      yield* TestClock.adjust(Duration.seconds(30))
      expect(problemOf(yield* Fiber.join(fiber))).toContain(
        'took more than 30s',
      )
    }),
  )

  it.effect('reads a GitHub file page as its raw file', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/raw/me/shop/main/docs/shop.md': text('# From GitHub\n', 'text/plain'),
      }))
      const spec = specOf(
        yield* readFrom(
          fixture.checkout,
          'https://github.com/me/shop/blob/main/docs/shop.md',
          server.base,
        ),
      )
      expect(spec.text).toBe('# From GitHub\n')
      expect(spec.path).toBe('.fabrica/specs/shop.md')
    }),
  )

  it.effect("keeps a raw URL's query, which fetches a private file", () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/raw/me/shop/main/shop.md': text('# Raw\n', 'text/plain'),
      }))
      const spec = specOf(
        yield* readFrom(
          fixture.checkout,
          'https://raw.githubusercontent.com/me/shop/main/shop.md?token=sekret',
          server.base,
        ),
      )
      expect(server.sent[0]?.url).toBe('/raw/me/shop/main/shop.md?token=sekret')
      expect(spec.source).toEqual(
        Option.some('https://raw.githubusercontent.com/me/shop/main/shop.md'),
      )
    }),
  )

  it.effect('reads a one-file gist as its file, and refuses one of two', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(base => ({
        '/api/gists/abc123': text(
          JSON.stringify({
            files: { 'shop.md': { raw_url: `${base}/gist/shop.md` } },
          }),
          'application/json',
        ),
        '/api/gists/def456': text(
          JSON.stringify({
            files: {
              'a.md': { raw_url: `${base}/gist/a.md` },
              'b.md': { raw_url: `${base}/gist/b.md` },
            },
          }),
          'application/json',
        ),
        '/gist/shop.md': text('# From a gist\n', 'text/plain'),
      }))
      expect(
        specOf(
          yield* readFrom(
            fixture.checkout,
            'https://gist.github.com/me/abc123',
            server.base,
          ),
        ).text,
      ).toBe('# From a gist\n')
      expect(
        problemOf(
          yield* readFrom(
            fixture.checkout,
            'https://gist.github.com/me/def456',
            server.base,
          ),
        ),
      ).toContain('is a gist of 2 files')
    }),
  )

  it.effect(
    "reads a private GitHub file through the host's gh, and says so where gh can't",
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const server = yield* stubServer(() => ({}))
        const given = 'https://github.com/me/shop/blob/main/docs/shop.md'
        const gh = join(binFolder(), 'gh')
        // On a PATH of the test's folder alone: a host may well have a gh of its own.
        const config = runnerConfig()
        const missing = yield* Effect.flip(
          fetchSpec({
            url: new URL(given),
            shown: given,
            checkout: fixture.checkout,
          }),
        ).pipe(
          Effect.provideService(SpecFetching, {
            ca: Option.some(certificate.certificate),
            hosts: { raw: `${server.base}/raw`, api: `${server.base}/api` },
          }),
          Effect.provide(
            Layer.provide(
              runnerLayer({
                ...config,
                hostEnvironment: {
                  ...config.hostEnvironment,
                  PATH: binFolder(),
                },
              }),
              liveDeadlines,
            ),
          ),
        )
        expect(missing.reason).toContain('is private or missing')
        expect(missing.reason).toContain('install gh')

        writeFileSync(
          gh,
          '#!/bin/sh\necho "$@" > "$HOME/gh-args"\necho "# Private"\n',
        )
        chmodSync(gh, 0o755)
        expect(
          specOf(yield* readFrom(fixture.checkout, given, server.base)).text,
        ).toBe('# Private\n')
        const home = runnerConfig().hostEnvironment['HOME'] ?? ''
        expect(readFileSync(join(home, 'gh-args'), 'utf8')).toContain(
          'repos/me/shop/contents/docs/shop.md?ref=main',
        )

        writeFileSync(
          gh,
          '#!/bin/sh\necho "To get started, run: gh auth login" >&2\nexit 4\n',
        )
        expect(
          problemOf(yield* readFrom(fixture.checkout, given, server.base)),
        ).toContain('log gh in (gh auth login)')
      }),
  )

  it('refuses a URL that is not https, or holds credentials', () => {
    const refused = (given: string) =>
      Result.match(specSource(given), {
        onFailure: reason => reason,
        onSuccess: () => 'taken',
      })
    expect(refused('http://example.com/spec.md')).toContain('https only')
    expect(refused('ftp://example.com/spec.md')).toContain('https only')
    expect(refused('https://me:pw@example.com/spec.md')).toContain(
      'user name or password',
    )
    expect(refused('https://example.com/')).toContain('names no file')
  })

  it('shows a run a URL without its query and fragment, and a path as it is', () => {
    const shown = (source: string) =>
      shownMode(WireMode.cases.spec.make({ source, refine: false }))
    expect(shown('https://example.com/spec.md?token=sekret#part')).toEqual(
      WireMode.cases.spec.make({
        source: 'https://example.com/spec.md',
        refine: false,
      }),
    )
    expect(shown('docs/what?.md')).toEqual(
      WireMode.cases.spec.make({ source: 'docs/what?.md', refine: false }),
    )
    const tickets = WireMode.cases.tickets.make({})
    expect(shownMode(tickets)).toBe(tickets)
  })

  it('names a copy after the last path segment', () => {
    expect(copyName('shop')).toEqual(Option.some('shop.md'))
    expect(copyName('shop.txt')).toEqual(Option.some('shop.txt'))
    expect(copyName('../..')).toEqual(Option.none())
    expect(copyName('my shop!.markdown')).toEqual(
      Option.some('my-shop-.markdown'),
    )
  })

  it('takes a raw URL and a tag page as GitHub files', () => {
    const raw = githubFile(
      new URL('https://raw.githubusercontent.com/me/shop/v1/a/b.md'),
    )
    expect(Option.map(raw, ({ ref, path }) => [ref, path])).toEqual(
      Option.some(['v1', 'a/b.md']),
    )
    const tag = githubFile(
      new URL('https://github.com/me/shop/blob/refs/tags/v1/a.md'),
    )
    expect(Option.map(tag, ({ ref, path }) => [ref, path])).toEqual(
      Option.some(['refs/tags/v1', 'a.md']),
    )
    expect(
      Option.isNone(githubFile(new URL('https://example.com/me/shop/a.md'))),
    ).toBe(true)
  })
})

describe('A spec committed (§15.5)', () => {
  it.effect(
    'is a copy recording Spec-Source, kept as it is when the same, an update when changed',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const server = yield* stubServer(() => ({
          '/shop.md': text('# One\n'),
        }))
        const given = `${server.base}/shop.md?token=sekret`
        const read = specOf(
          yield* readFrom(fixture.checkout, given, server.base),
        )
        const first = yield* onStub(
          commitSpec({ checkout: fixture.checkout, spec: read }),
          server.base,
        )
        const message = git(fixture.checkout, 'log', '-1', '--format=%B')
        expect(message).toContain('fabrica: add spec shop.md')
        expect(message).toContain(`Spec-Source: ${server.base}/shop.md`)
        expect(message).toContain(`SHA-256: ${read.sha256}`)
        expect(message).not.toContain('sekret')
        expect(git(fixture.checkout, 'status', '--porcelain')).toBe('')

        const again = yield* onStub(
          commitSpec({ checkout: fixture.checkout, spec: read }),
          server.base,
        )
        expect(again.commit).toBe(first.commit)

        const changed = yield* onStub(
          commitSpec({
            checkout: fixture.checkout,
            spec: { ...read, text: '# Two\n', sha256: 'other' },
          }),
          server.base,
        )
        expect(changed.commit).not.toBe(first.commit)
        expect(git(fixture.checkout, 'log', '-1', '--format=%s')).toBe(
          'fabrica: update spec shop.md',
        )
      }),
  )

  it.effect('refuses a copy of the same name from another source', () =>
    Effect.gen(function* () {
      const fixture = project()
      const server = yield* stubServer(() => ({
        '/one/shop.md': text('# One\n'),
        '/two/shop.md': text('# Two\n'),
      }))
      yield* onStub(
        Effect.flatMap(
          readSpec({
            checkout: fixture.checkout,
            given: `${server.base}/one/shop.md`,
          }),
          spec => commitSpec({ checkout: fixture.checkout, spec }),
        ),
        server.base,
      )
      expect(
        problemOf(
          yield* readFrom(
            fixture.checkout,
            `${server.base}/two/shop.md`,
            server.base,
          ),
        ),
      ).toContain('give this spec another name')
    }),
  )

  it.effect(
    'refuses a file git ignores, as workers see only what is committed',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        commit(fixture.checkout, 'ignore', { '.gitignore': 'private.md\n' })
        writeFileSync(join(fixture.checkout, 'private.md'), '# Private\n')
        expect(
          problemOf(
            yield* readFrom(fixture.checkout, 'private.md', 'https://x'),
          ),
        ).toContain('git ignores the spec')
      }),
  )

  it.effect(
    'commits a file in the repository where it is, and copies one from outside',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const inside = specOf(
          yield* readFrom(fixture.checkout, 'docs/spec.md', 'https://x'),
        )
        expect(inside.path).toBe('docs/spec.md')
        expect(inside.source).toEqual(Option.none())
        writeFileSync(join(fixture.checkout, 'new.md'), '# New\n')
        const untracked = specOf(
          yield* readFrom(fixture.checkout, 'new.md', 'https://x'),
        )
        yield* onStub(
          commitSpec({ checkout: fixture.checkout, spec: untracked }),
          'https://x',
        )
        expect(git(fixture.checkout, 'log', '-1', '--format=%s')).toBe(
          'fabrica: add spec new.md',
        )
        expect(git(fixture.checkout, 'status', '--porcelain')).toBe('')
        const outside = join(fixture.data, '..', 'shop plan.md')
        writeFileSync(outside, '# Outside\n')
        const copied = specOf(
          yield* readFrom(fixture.checkout, outside, 'https://x'),
        )
        expect(copied.path).toBe('.fabrica/specs/shop-plan.md')
        expect(Option.isSome(copied.source)).toBe(true)
      }),
  )
})

const item = (key: string, extra: object = {}) => ({
  key,
  type: 'task',
  title: `Do ${key}`,
  description: 'stub: finish',
  files: [`${key}.txt`],
  parent: 'root',
  ...extra,
})

const rootCall = {
  root: { title: 'The shop', description: 'Builds the whole shop.' },
}

const environmentCall = {
  root: rootCall.root,
  environment: {
    title: 'Set the shop up',
    description: 'stub: finish',
    files: 'unknown',
  },
}

/** Project files that have the stub break the spec down as `script` says. */
const breakdownFile = (script: object) => ({
  'breakdown.json': JSON.stringify(script),
})

const specMode = options({ mode: RunMode.Spec({ source: 'docs/spec.md' }) })

/** The stub's calls of `tag`, as the session logs under `folder` keep them. */
const stubCalls = (folder: string, tag: string): ReadonlyArray<string> =>
  readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('stub.jsonl'))
    .flatMap(name => readFileSync(join(folder, name), 'utf8').split('\n'))
    .filter(line => line.includes(`"tag":"${tag}"`))

/** The tickets as the work graph has them now, by title. */
const titled = (graph: WorkGraphShape) =>
  Effect.map(graph.list(), tickets => (title: string): Ticket => {
    const found = tickets.find(ticket => ticket.title === title)
    if (found === undefined) throw new Error(`no ticket ${title}`)
    return found
  })

describe('A spec run (§15.5)', () => {
  it.effect(
    'files the environment ticket first, starts on it while the breakdown goes on, then runs the rest',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: environmentCall,
            waitForEnvironment: true,
            answers: [
              {
                items: [
                  item('part', {
                    type: 'epic',
                    description: 'The parts of it.',
                    files: undefined,
                  }),
                  item('one', { parent: 'part' }),
                  item('two'),
                ],
              },
            ],
          }),
        )
        const { end, events, ticketOf } = yield* runOf(
          fixture,
          Effect.void,
          () => specMode,
        )
        expect(end).toMatchObject({ kind: 'READY_EMPTY', code: 0 })
        const [start] = ofKind(events, 'start')
        expect(start?.spec).toBe('docs/spec.md')

        const organ = ofKind(events, 'organ')
        expect(organ).toHaveLength(1)
        expect(organ[0]).toMatchObject({
          organ: 'breakdown',
          outcome: 'answered',
        })
        expect(organ[0]?.session).toBeDefined()

        const claimed = ofKind(events, 'dispatch').map(({ ticket }) => ticket)
        const said = events.map(event =>
          'text' in event ? String(event.text) : '',
        )
        const startingLine = said.find(line =>
          line.includes('the environment ticket, while the breakdown files'),
        )
        expect(startingLine).toBeDefined()

        // The first ticket dispatched is the environment ticket: the rest wasn't filed yet.
        const first = claimed[0]
        if (first === undefined) throw new Error('nothing was dispatched')
        const environment = ticketOf(first)
        expect(environment.priority).toBe(0)
        expect(environment.metadata[SpecEnvironmentKey]).toBe(true)
        expect(claimed).toHaveLength(3)
        const firstDispatch = events.findIndex(
          event => event.kind === 'dispatch',
        )
        const answered = events.findIndex(event => event.kind === 'organ')
        expect(firstDispatch).toBeLessThan(answered)

        const rootId = TicketId.make(first.split('.')[0] ?? '')
        const root: Ticket = ticketOf(rootId)
        expect(root.type).toBe('epic')
        expect(Option.contains(root.metadata.spec, 'docs/spec.md')).toBe(true)
        expect(typeof root.metadata[SpecSha256Key]).toBe('string')
        expect(typeof root.metadata[SpecCommitKey]).toBe('string')
      }),
  )

  it.effect('makes every other ticket wait on the environment ticket', () =>
    Effect.gen(function* () {
      const fixture = project(
        settings,
        breakdownFile({
          root: environmentCall,
          answers: [{ items: [item('one'), item('two')] }],
        }),
      )
      yield* withRuns(
        fixture,
        Effect.gen(function* () {
          yield* runProject(configOf(fixture, specMode))
          const graph = yield* WorkGraph
          const edges = yield* graph.edges()
          const tickets = yield* graph.list()
          const environment = tickets.find(
            ticket => ticket.metadata[SpecEnvironmentKey] === true,
          )
          if (environment === undefined)
            throw new Error('no environment ticket')
          const others = tickets.filter(
            ticket => ticket.type !== 'epic' && ticket.id !== environment.id,
          )
          expect(others).toHaveLength(2)
          for (const other of others)
            expect(
              edges.some(
                edge =>
                  edge.kind === 'blocks' &&
                  edge.from === environment.id &&
                  edge.to === other.id,
              ),
            ).toBe(true)
          const detail = yield* graph.show(environment.id)
          expect(detail.labels).toContain('solo')
        }),
      )
    }),
  )

  it.effect(
    'gives a refused tree back with every reason at once, filing nothing of it',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [
              {
                items: [
                  item('a'),
                  item('a'),
                  item('lost', { parent: 'nowhere' }),
                  item('b', { waitsOn: ['missing'] }),
                  item('c', { waitsOn: ['d'] }),
                  item('d', { waitsOn: ['c'] }),
                  item('bare', { files: undefined }),
                ],
              },
              { items: [item('good')] },
            ],
          }),
        )
        const { end, events } = yield* runOf(
          fixture,
          Effect.void,
          () => specMode,
        )
        expect(end).toMatchObject({ code: 0 })
        const [refusal] = stubCalls(fixture.data, 'answer')
        for (const reason of [
          'the key a is given to 2 items',
          "lost's parent nowhere isn't in the tree",
          "b waits on missing, which isn't in the tree",
          'c, d wait on one another',
          'bare names no files',
        ])
          expect(refusal).toContain(reason)
        expect(ofKind(events, 'dispatch')).toHaveLength(1)
      }),
  )

  it.effect(
    'warns of a narrow tree, naming the chain and the hubs, and goes on',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [
              {
                items: [
                  item('a'),
                  item('b', { waitsOn: ['a'] }),
                  item('c', { waitsOn: ['b'] }),
                  item('d', { waitsOn: ['c'] }),
                ],
              },
            ],
          }),
        )
        const { end, events } = yield* runOf(
          fixture,
          Effect.void,
          () => specMode,
        )
        expect(end).toMatchObject({ code: 0 })
        const warned = ofKind(events, 'warn').filter(({ text }) =>
          text.startsWith('NARROW_TREE'),
        )
        expect(warned).toHaveLength(1)
        expect(warned[0]?.text).toContain('its longest chain is over 3')
        expect(warned[0]?.text).toContain('longest chain 4')
        expect(ofKind(events, 'dispatch')).toHaveLength(4)
      }),
  )

  it.effect(
    'carries on by SHA-256: no breakdown for the same text, an update for a changed one',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [{ items: [item('one')] }],
          }),
        )
        const outside = join(fixture.data, '..', 'shop.md')
        writeFileSync(outside, '# Shop\n')
        const mode = options({ mode: RunMode.Spec({ source: outside }) })
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* runProject(configOf(fixture, mode))
            const graph = yield* WorkGraph
            const filedFirst = (yield* graph.list()).length

            yield* runProject(configOf(fixture, mode))
            expect((yield* graph.list()).length).toBe(filedFirst)
            const after = yield* eventsOf(fixture)
            expect(ofKind(after, 'organ')).toHaveLength(1)
            expect(
              after.some(
                event =>
                  'text' in event &&
                  String(event.text).includes(
                    '.fabrica/specs/shop.md is built',
                  ),
              ),
            ).toBe(true)

            writeFileSync(outside, '# Shop, changed\n')
            commit(fixture.checkout, 'an update', {
              'breakdown.json': JSON.stringify({
                answers: [{ items: [item('added')] }],
              }),
            })
            const end = yield* runProject(configOf(fixture, mode))
            expect(end).toMatchObject({ code: 0 })
            const tickets = yield* graph.list()
            expect(tickets.length).toBe(filedFirst + 1)
            const root = tickets.find(ticket => ticket.type === 'epic')
            if (root === undefined) throw new Error('no root epic')
            const scope = descendants(root.id, yield* graph.edges())
            expect(tickets.every(ticket => scope.has(ticket.id))).toBe(true)
            expect(
              git(
                fixture.checkout,
                'log',
                '-1',
                '--format=%s',
                '--',
                '.fabrica/specs/shop.md',
              ),
            ).toBe('fabrica: update spec shop.md')
            expect(
              existsSync(join(fixture.checkout, '.fabrica/run/spec-update.md')),
            ).toBe(true)
          }),
        )
      }),
  )

  it.effect(
    'updates the open tickets for a changed spec, deferring the obsolete, refusing a closed one',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [
              {
                items: [
                  item('a'),
                  item('b', { waitsOn: ['a'] }),
                  item('c', { waitsOn: ['a'] }),
                ],
              },
            ],
          }),
        )
        const outside = join(fixture.data, '..', 'shop.md')
        writeFileSync(outside, '# Shop\n')
        const limited = options({
          mode: RunMode.Spec({ source: outside }),
          limit: Option.some(1),
        })
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* runProject(configOf(fixture, limited))
            const graph = yield* WorkGraph
            const first = yield* titled(graph)
            expect(first('Do a').status).toBe('closed')
            writeFileSync(outside, '# Shop, changed\n')
            commit(fixture.checkout, 'an update', {
              'breakdown.json': JSON.stringify({
                answers: [
                  {
                    items: [],
                    changes: [
                      { ticket: first('Do a').id, description: 'stub: finish' },
                    ],
                  },
                  {
                    items: [],
                    changes: [
                      {
                        ticket: first('Do b').id,
                        description: 'stub: finish, as changed',
                      },
                      { ticket: first('Do c').id, obsolete: 'Not any more.' },
                    ],
                  },
                ],
              }),
            })
            yield* runProject(configOf(fixture, limited))
            const after = yield* titled(graph)
            expect(after('Do b').description).toEqual(
              Option.some('stub: finish, as changed'),
            )
            expect(after('Do c').status).toBe('deferred')
            const c = yield* graph.show(first('Do c').id)
            expect(c.notes.map(({ body }) => body)).toContain('Not any more.')
            expect(
              stubCalls(fixture.data, 'answer').some(call =>
                call.includes(
                  `${first('Do a').id} is closed: only an open ticket changes`,
                ),
              ),
            ).toBe(true)
          }),
        )
      }),
  )

  it.effect(
    'refuses an update making a cycle through what is filed, parents and waits together',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [
              {
                items: [
                  item('part', {
                    type: 'epic',
                    description: 'The parts of it.',
                    files: undefined,
                  }),
                  item('t', { waitsOn: ['part'] }),
                  item('free'),
                ],
              },
            ],
          }),
        )
        const outside = join(fixture.data, '..', 'shop.md')
        writeFileSync(outside, '# Shop\n')
        const mode = options({ mode: RunMode.Spec({ source: outside }) })
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* runProject(configOf(fixture, mode))
            const graph = yield* WorkGraph
            const first = yield* titled(graph)
            const filed = (title: string) => filedKey(first(title).id)
            writeFileSync(outside, '# Shop, changed\n')
            commit(fixture.checkout, 'an update', {
              'breakdown.json': JSON.stringify({
                answers: [
                  {
                    items: [
                      item('x', {
                        parent: filed('Do part'),
                        waitsOn: [filed('Do t')],
                      }),
                    ],
                  },
                  { items: [item('y')] },
                ],
              }),
            })
            yield* runProject(configOf(fixture, mode))
            const refused = stubCalls(fixture.data, 'answer').find(call =>
              call.includes('wait on one another'),
            )
            expect(refused).toContain(filed('Do part'))
            expect(refused).toContain(filed('Do t'))
            const tickets = yield* graph.list()
            expect(tickets.map(({ title }) => title)).not.toContain('Do x')
            expect(tickets.map(({ title }) => title)).toContain('Do y')
          }),
        )
      }),
  )

  it.effect(
    'opens a closed epic again when an update files a ticket under it',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            root: rootCall,
            answers: [
              {
                items: [
                  item('part', {
                    type: 'epic',
                    description: 'The parts of it.',
                    files: undefined,
                  }),
                  item('one', { parent: 'part' }),
                ],
              },
            ],
          }),
        )
        const outside = join(fixture.data, '..', 'shop.md')
        writeFileSync(outside, '# Shop\n')
        const mode = options({ mode: RunMode.Spec({ source: outside }) })
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            yield* runProject(configOf(fixture, mode))
            const graph = yield* WorkGraph
            const first = yield* titled(graph)
            expect(first('Do part').status).toBe('closed')
            expect(first('The shop').status).toBe('closed')
            writeFileSync(outside, '# Shop, changed\n')
            commit(fixture.checkout, 'an update', {
              'breakdown.json': JSON.stringify({
                answers: [
                  {
                    items: [
                      item('added', {
                        parent: filedKey(first('Do part').id),
                        description: 'stub: defer',
                      }),
                    ],
                  },
                ],
              }),
            })
            yield* runProject(configOf(fixture, mode))
            const after = yield* titled(graph)
            expect(after('Do added').status).toBe('deferred')
            expect(after('Do part').status).toBe('open')
            expect(after('The shop').status).toBe('open')
          }),
        )
      }),
  )

  it.effect(
    'carries a breakdown that stopped on, under the root epic it filed',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({ root: environmentCall, answers: [] }),
        )
        yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const stopped = yield* runProject(configOf(fixture, specMode))
            expect(stopped).toMatchObject({ kind: 'SETUP', code: 2 })
            const graph = yield* WorkGraph
            const [root] = yield* graph.list({ types: ['epic'] })
            if (root === undefined) throw new Error('no root epic')
            expect(root.metadata[SpecSha256Key]).toBeUndefined()

            commit(fixture.checkout, 'carried on', {
              'breakdown.json': JSON.stringify({
                answers: [{ items: [item('rest')] }],
              }),
            })
            const end = yield* runProject(configOf(fixture, specMode))
            expect(end).toMatchObject({ code: 0 })
            const epics = yield* graph.list({ types: ['epic'] })
            expect(epics.map(({ id }) => id)).toEqual([root.id])
            const scope = descendants(root.id, yield* graph.edges())
            const tickets = yield* titled(graph)
            expect(scope.has(tickets('Do rest').id)).toBe(true)
            expect(
              (yield* graph.show(root.id)).ticket.metadata[SpecSha256Key],
            ).toBeDefined()
          }),
        )
      }),
  )

  it.effect(
    'waits out a usage limit, holding the run, and the breakdown carries on',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          settings,
          breakdownFile({
            limitedFirst: true,
            root: rootCall,
            answers: [{ items: [item('one')] }],
          }),
        )
        const end = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const ended = yield* Ref.make(false)
            const fiber = yield* runProject(configOf(fixture, specMode)).pipe(
              Effect.ensuring(Ref.set(ended, true)),
              Effect.forkChild,
            )
            while (!(yield* Ref.get(ended))) {
              yield* TestClock.adjust(Duration.minutes(10))
              yield* TestClock.withLive(Effect.sleep('50 millis'))
            }
            return yield* Fiber.join(fiber)
          }),
          'limits_second',
        )
        expect(end).toMatchObject({ kind: 'READY_EMPTY', code: 0 })
        const events = yield* eventsOf(fixture)
        expect(ofKind(events, 'organ')[0]).toMatchObject({
          organ: 'breakdown',
          outcome: 'answered',
        })
        expect(ofKind(events, 'dispatch')).toHaveLength(1)
      }),
  )

  it.effect(
    'past usage_limit_wait, the run ends as a usage limit ends it',
    () =>
      Effect.gen(function* () {
        const fixture = project(
          { ...settings, usage_limit_wait: '5m' },
          breakdownFile({
            limitedFirst: true,
            root: rootCall,
            answers: [{ items: [item('one')] }],
          }),
        )
        const end = yield* withRuns(
          fixture,
          Effect.gen(function* () {
            const ended = yield* Ref.make(false)
            const fiber = yield* runProject(configOf(fixture, specMode)).pipe(
              Effect.ensuring(Ref.set(ended, true)),
              Effect.forkChild,
            )
            while (!(yield* Ref.get(ended))) {
              yield* TestClock.adjust(Duration.minutes(1))
              yield* TestClock.withLive(Effect.sleep('50 millis'))
            }
            return yield* Fiber.join(fiber)
          }),
          'limits_second',
        )
        expect(end).toMatchObject({ code: 8 })
      }),
  )

  it.effect(
    'refuses a spec it cannot fetch at the start, a setup problem saying why',
    () =>
      Effect.gen(function* () {
        const fixture = project()
        const { end, events } = yield* runOf(fixture, Effect.void, () =>
          options({
            mode: RunMode.Spec({ source: 'http://example.com/spec.md' }),
          }),
        )
        expect(end).toMatchObject({ kind: 'SETUP', code: 2 })
        expect(
          ofKind(events, 'warn').some(({ text }) =>
            text.includes('https only'),
          ),
        ).toBe(true)
      }),
  )

  it.effect('stops, a setup problem, where the breakdown gives no tree', () =>
    Effect.gen(function* () {
      const fixture = project(
        settings,
        breakdownFile({ root: rootCall, answers: [] }),
      )
      const { end, events } = yield* runOf(fixture, Effect.void, () => specMode)
      expect(end).toMatchObject({ kind: 'SETUP', code: 2 })
      const [stop] = ofKind(events, 'stop')
      expect(stop?.text).toContain('gave no tree')
      expect(stop?.text).toContain('run it again to carry on')
    }),
  )

  it.effect('stops where the breakdown organ is turned off', () =>
    Effect.gen(function* () {
      const fixture = project({
        ...settings,
        organs: { breakdown: { enabled: false } },
      })
      const { end, events } = yield* runOf(fixture, Effect.void, () => specMode)
      expect(end).toMatchObject({ kind: 'SETUP', code: 2 })
      expect(ofKind(events, 'stop')[0]?.text).toContain('turned off')
    }),
  )
})

describe("A tree's shape (§15.5)", () => {
  const ticket = (
    name: string,
    type: Ticket['type'] = 'task',
    status: Ticket['status'] = 'open',
  ) => ({ id: TicketId.make(`fa-${name}`), type, status })
  const blocks = (from: string, to: string) => ({
    from: TicketId.make(`fa-${from}`),
    to: TicketId.make(`fa-${to}`),
    kind: 'blocks' as const,
  })

  it('warns of a chain over 3, and names it', () => {
    const tickets = ['a', 'b', 'c', 'd'].map(name => ticket(name))
    const shape = treeShape(tickets, [
      blocks('a', 'b'),
      blocks('b', 'c'),
      blocks('c', 'd'),
    ])
    expect(shape.chain).toEqual(['fa-a', 'fa-b', 'fa-c', 'fa-d'])
    expect(Option.getOrThrow(narrowWarning(shape, 1))).toContain(
      'fa-a > fa-b > fa-c > fa-d',
    )
  })

  it('warns of a width under the concurrency, and names the hubs', () => {
    const tickets = ['hub', 'a', 'b', 'c'].map(name => ticket(name))
    const shape = treeShape(tickets, [
      blocks('hub', 'a'),
      blocks('hub', 'b'),
      blocks('hub', 'c'),
    ])
    expect(shape.hubs).toEqual([{ id: 'fa-hub', holds: 3 }])
    const warning = Option.getOrThrow(narrowWarning(shape, 4))
    expect(warning).toContain("fewer than the run's 4 tickets at a time")
    expect(warning).toContain('fa-hub holds 3')
    expect(Option.isNone(narrowWarning(shape, 2))).toBe(true)
  })

  it('follows a chain through the epics tickets wait on', () => {
    const parent = (from: string, to: string) => ({
      from: TicketId.make(`fa-${from}`),
      to: TicketId.make(`fa-${to}`),
      kind: 'parent' as const,
    })
    const shape = treeShape(
      [
        ticket('e1', 'epic'),
        ticket('e2', 'epic'),
        ticket('e3', 'epic'),
        ticket('e4', 'epic'),
        ticket('a'),
        ticket('b'),
        ticket('c'),
        ticket('d'),
      ],
      [
        parent('e1', 'a'),
        parent('e2', 'b'),
        parent('e3', 'c'),
        parent('e4', 'd'),
        blocks('e1', 'b'),
        blocks('e2', 'c'),
        blocks('e3', 'd'),
      ],
    )
    expect(shape.chain).toEqual(['fa-a', 'fa-b', 'fa-c', 'fa-d'])
    expect(Option.getOrThrow(narrowWarning(shape, 1))).toContain(
      'its longest chain is over 3',
    )
  })

  it('names as a hub the epic others wait on directly, not the tickets under it', () => {
    const shape = treeShape(
      [
        ticket('e', 'epic'),
        ticket('a'),
        ticket('b'),
        ticket('x'),
        ticket('y'),
        ticket('z'),
      ],
      [
        {
          from: TicketId.make('fa-e'),
          to: TicketId.make('fa-a'),
          kind: 'parent' as const,
        },
        {
          from: TicketId.make('fa-e'),
          to: TicketId.make('fa-b'),
          kind: 'parent' as const,
        },
        blocks('e', 'x'),
        blocks('e', 'y'),
        blocks('e', 'z'),
      ],
    )
    expect(shape.hubs).toEqual([{ id: 'fa-e', holds: 3 }])
    expect(shape.chain).toHaveLength(2)
  })

  it('leaves out epics and closed tickets, and warns of no tree wide enough', () => {
    const shape = treeShape(
      [
        ticket('epic', 'epic'),
        ticket('done', 'task', 'closed'),
        ticket('a'),
        ticket('b'),
      ],
      [blocks('done', 'a')],
    )
    expect(shape.tickets).toBe(2)
    expect(Option.isNone(narrowWarning(shape, 2))).toBe(true)
    // Fewer tickets than the concurrency isn't a narrow tree: all of them run.
    expect(Option.isNone(narrowWarning(shape, 8))).toBe(true)
  })
})
