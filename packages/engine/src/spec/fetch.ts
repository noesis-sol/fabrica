import { Context, Data, Duration, Effect, Option, Schema } from 'effect'
import { STATUS_CODES } from 'node:http'
import { request } from 'node:https'

import { CommandOutcome, ExitStatus, ProcessRunner } from '../process'
import {
  type GitHubFile,
  type GitHubHosts,
  gistOf,
  githubFile,
  githubHosts,
  specMaxBytes,
} from './source'

// Fetching a spec at a web URL (spec §15.5, H83): https only, up to 5 redirects and each over https,
// within 30 s and 5 MB, with no credentials or cookies; a GitHub file page and a one-file gist page as
// their raw files, a private GitHub file (its raw file answering 404) through the host's own `gh`
// login, whose token never leaves gh. An HTML answer is refused. Each failure says why, as a line of
// the start checks' report.

/** How long a spec's fetch may take, redirects and gh included. */
export const fetchTimeLimit = Duration.seconds(30)

/** The most redirects a spec's fetch follows. */
export const maxRedirects = 5

/** What a fetch trusts and where it finds GitHub, which only a test changes. */
export const SpecFetching = Context.Reference<{
  /** The certificates to trust instead of the system's, PEM. */
  readonly ca: Option.Option<string>
  readonly hosts: GitHubHosts
}>('@fabrica/engine/spec/SpecFetching', {
  defaultValue: () => ({
    ca: Option.none(),
    hosts: githubHosts,
  }),
})

/** A fetch that failed, saying why; `status` where the server answered with one. */
export class SpecFetchFailed extends Data.TaggedError('SpecFetchFailed')<{
  readonly reason: string
  readonly status: Option.Option<number>
}> {
  override get message() {
    return this.reason
  }
}

const failed = (reason: string) =>
  new SpecFetchFailed({ reason, status: Option.none() })

const tooBig = `is more than ${specMaxBytes / (1024 * 1024)} MB`

/** An HTTP status as a person reads it: `HTTP 404 Not Found`. */
const statusWords = (status: number): string =>
  `HTTP ${status}${STATUS_CODES[status] === undefined ? '' : ` ${STATUS_CODES[status]}`}`

/** A response: its status, its redirect and media type, and its body where it succeeded. */
interface Answered {
  readonly status: number
  readonly location: Option.Option<string>
  readonly contentType: Option.Option<string>
  readonly body: Uint8Array
}

/** What a spec's fetch got. */
export interface Fetched {
  readonly bytes: Uint8Array
  readonly contentType: Option.Option<string>
}

/** One GET, aborted as the effect is interrupted: nothing is sent but what is named here. */
const getOnce = (url: URL, accept: Option.Option<string>) =>
  Effect.flatMap(Effect.service(SpecFetching), fetching =>
    Effect.callback<Answered, SpecFetchFailed>((resume, signal) => {
      const sent = request(
        url,
        {
          method: 'GET',
          agent: false,
          signal,
          headers: {
            'user-agent': 'fabrica',
            ...Option.match(accept, {
              onNone: () => ({}),
              onSome: type => ({ accept: type }),
            }),
          },
          ...Option.match(fetching.ca, {
            onNone: () => ({}),
            onSome: ca => ({ ca }),
          }),
        },
        response => {
          const status = response.statusCode ?? 0
          const fields = {
            status,
            location: Option.fromUndefinedOr(response.headers.location),
            contentType: Option.fromUndefinedOr(
              response.headers['content-type'],
            ),
          }
          if (status < 200 || status >= 300) {
            response.resume()
            resume(Effect.succeed({ ...fields, body: new Uint8Array() }))
            return
          }
          const stop = () => {
            response.destroy()
            resume(Effect.fail(failed(tooBig)))
          }
          if (Number(response.headers['content-length']) > specMaxBytes) {
            stop()
            return
          }
          const chunks: Array<Buffer> = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > specMaxBytes) stop()
            else chunks.push(chunk)
          })
          response.on('end', () =>
            resume(Effect.succeed({ ...fields, body: Buffer.concat(chunks) })),
          )
          response.on('error', error =>
            resume(Effect.fail(failed(error.message))),
          )
        },
      )
      sent.on('error', error => resume(Effect.fail(failed(error.message))))
      sent.end()
    }),
  )

/** GETs `url`, following up to `maxRedirects` redirects, each over https. */
const get = Effect.fnUntraced(function* (
  url: URL,
  accept: Option.Option<string> = Option.none(),
) {
  let current = url
  for (let hops = 0; ; hops += 1) {
    const answer = yield* getOnce(current, accept)
    if (answer.status >= 300 && answer.status < 400) {
      if (Option.isNone(answer.location))
        return yield* failed(
          `${statusWords(answer.status)} names nowhere to go`,
        )
      if (hops >= maxRedirects)
        return yield* failed(`redirected more than ${maxRedirects} times`)
      if (!URL.canParse(answer.location.value, current.href))
        return yield* failed(
          `redirected to ${answer.location.value}, not a URL`,
        )
      const next = new URL(answer.location.value, current)
      if (next.protocol !== 'https:')
        return yield* failed(
          `redirected to ${next.host === '' ? next.href : next.host} over ${next.protocol.slice(0, -1)}`,
        )
      // Node would send a URL's user name and password as a login.
      if (next.username !== '' || next.password !== '')
        return yield* failed(
          `redirected to ${next.host} with a user name or password, and Fabrica sends no credentials`,
        )
      current = next
      continue
    }
    if (answer.status < 200 || answer.status >= 300)
      return yield* new SpecFetchFailed({
        reason: statusWords(answer.status),
        status: Option.some(answer.status),
      })
    return {
      bytes: answer.body,
      contentType: answer.contentType,
    } satisfies Fetched
  }
})

/** What `gh api` says when it isn't logged in. */
const loggedOut = /gh auth login|not logged in/iu

/** A private GitHub file, read through the host's own gh login. */
const throughGh = Effect.fnUntraced(function* (
  shown: string,
  file: GitHubFile,
  checkout: string,
) {
  const runner = yield* ProcessRunner
  const outcome = yield* runner.run({
    command: 'gh',
    args: [
      'api',
      `repos/${file.owner}/${file.repo}/contents/${file.path}?ref=${file.ref}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ],
    cwd: checkout,
    timeLimit: fetchTimeLimit,
    outputLimit: specMaxBytes,
    network: true,
    secrets: true,
  })
  const privately = (what: string) =>
    failed(
      `${shown} is private or missing; if it is private, ${what} and run again`,
    )
  return yield* CommandOutcome.$match(outcome, {
    Exited: ({ status, stdout, stderr }) =>
      ExitStatus.$is('Code')(status) && status.code === 0
        ? Effect.succeed<Fetched>({
            bytes: Buffer.from(stdout),
            contentType: Option.none(),
          })
        : Effect.fail(
            loggedOut.test(stderr) ||
              (ExitStatus.$is('Code')(status) && status.code === 4)
              ? privately('log gh in (gh auth login)')
              : /HTTP 404/u.test(stderr)
                ? failed(`${statusWords(404)}, through your gh login too`)
                : failed(
                    `gh api failed: ${stderr.trim().split('\n')[0] ?? 'it gave no reason'}`,
                  ),
          ),
    TimedOut: () =>
      Effect.fail(failed(`took more than ${Duration.format(fetchTimeLimit)}`)),
    Cut: () => Effect.fail(failed(tooBig)),
    FailedToStart: () =>
      Effect.fail(privately('install gh (https://cli.github.com), log it in')),
  })
})

const GistFiles = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Record(
      Schema.String,
      Schema.Struct({ raw_url: Schema.String }),
    ),
  }),
)

/** The raw URL of the one file of the gist `id`, through GitHub's API. */
const gistFile = Effect.fnUntraced(function* (shown: string, id: string) {
  const { hosts } = yield* SpecFetching
  const got = yield* get(
    new URL(`${hosts.api}/gists/${id}`),
    Option.some('application/json'),
  )
  const { files } = yield* Schema.decodeUnknownEffect(GistFiles)(
    new TextDecoder().decode(got.bytes),
  ).pipe(
    Effect.mapError(() => failed("GitHub's answer for the gist can't be read")),
  )
  const all = Object.values(files)
  const [only] = all
  if (only === undefined || all.length !== 1)
    return yield* failed(
      `${shown} is a gist of ${all.length} files: give the URL of its file's raw view`,
    )
  if (
    !URL.canParse(only.raw_url) ||
    new URL(only.raw_url).protocol !== 'https:'
  )
    return yield* failed(
      "GitHub's answer for the gist names no raw file over https",
    )
  return new URL(only.raw_url)
})

/**
 * Fetches the spec at `url`, within `fetchTimeLimit`: a GitHub file page as its raw file, through gh
 * where that answers 404; a one-file gist page as its file; any other URL as it is.
 */
export const fetchSpec = Effect.fn('Spec.fetch')(function* (input: {
  readonly url: URL
  readonly shown: string
  /** Where gh runs: the project's checkout. */
  readonly checkout: string
}) {
  const { url, shown, checkout } = input
  const { hosts } = yield* SpecFetching
  const file = githubFile(url, hosts)
  const gist = gistOf(url)
  const work = Effect.gen(function* () {
    if (Option.isSome(gist))
      return yield* get(yield* gistFile(shown, gist.value))
    if (Option.isNone(file)) return yield* get(url)
    return yield* get(file.value.raw).pipe(
      Effect.catchIf(
        error => Option.contains(error.status, 404),
        () => throughGh(shown, file.value, checkout),
      ),
    )
  })
  const finished = yield* Effect.timeoutOption(work, fetchTimeLimit)
  return yield* Option.match(finished, {
    onNone: () =>
      Effect.fail(failed(`took more than ${Duration.format(fetchTimeLimit)}`)),
    onSome: Effect.succeed,
  })
})
