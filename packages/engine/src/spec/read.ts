import { Data, Effect, Match, Option, Result } from 'effect'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import * as NodePath from 'node:path'

import type { CommitHash } from '@fabrica/contracts'

import { readFileBytes, writeFileWhole } from '../files'
import { Git } from '../git'
import { specsFolder } from '../projects/layout'
import { fetchSpec } from './fetch'
import {
  SourceTrailer,
  SpecSource,
  copyName,
  specMaxBytes,
  specSource,
} from './source'

// The spec a run builds (spec §15.5, H83): read with the start checks, and committed once they pass. A
// file in the repository is committed where it is; one from outside it, or a URL's text fetched again
// each run, as a copy under `.fabrica/specs/`, its commits recording `Spec-Source:` (a URL without its
// query and fragment). A copy of the same name from another source is refused, as it would take the
// other's tickets. The same text is kept as it is, and a changed one is an update.

/** The spec as the start checks read it. */
export interface ReadSpec {
  /** Its path from the repository's root, which names it from one run to the next. */
  readonly path: string
  readonly name: string
  readonly text: string
  /** Its SHA-256, in hex. */
  readonly sha256: string
  /** What its copy's commits record; none for a file in the repository. */
  readonly source: Option.Option<string>
  /** The URL it was fetched from, as recorded; none for a file. */
  readonly url: Option.Option<string>
}

/** The spec once it is committed. */
export interface CommittedSpec extends Omit<ReadSpec, 'text'> {
  /** The commit that committed this version of it. */
  readonly commit: CommitHash
}

/** A spec that can't be run, saying why: a line of the start checks' report. */
export class SpecProblem extends Data.TaggedError('SpecProblem')<{
  readonly problem: string
}> {
  override get message() {
    return this.problem
  }
}

const problem = (text: string) => new SpecProblem({ problem: text })

const sha256Of = (text: string): string =>
  createHash('sha256').update(text).digest('hex')

/** The bytes as a spec's text: UTF-8, with no NUL, and not empty. */
const textOf = (shown: string, bytes: Uint8Array) => {
  const decoded = Result.try(() =>
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  )
  if (Result.isFailure(decoded) || bytes.includes(0))
    return Result.fail(`the spec ${shown} isn't text`)
  return decoded.success.trim() === ''
    ? Result.fail(`the spec ${shown} is empty`)
    : Result.succeed(decoded.success)
}

/** Whether what a server gave is a web page, by what it says it is or how it opens. */
const isHtml = (contentType: Option.Option<string>, text: string): boolean =>
  Option.exists(contentType, type =>
    /^\s*(text\/html|application\/xhtml\+xml)\b/iu.test(type),
  ) || /^\s*(<!doctype\s+html|<html[\s>])/iu.test(text)

/** The `Spec-Source:` a commit message records, or none. */
const sourceOf = (message: string): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      message
        .split('\n')
        .findLast(line => line.startsWith(`${SourceTrailer}:`)),
    ),
    line => line.slice(SourceTrailer.length + 1).trim(),
  )

/** A copy of that name from another source is refused, as it would take the other's tickets. */
const sameSource = Effect.fnUntraced(function* (input: {
  readonly checkout: string
  readonly path: string
  readonly source: string
}) {
  const last = yield* (yield* Git).lastCommitOf({
    repo: input.checkout,
    path: input.path,
  })
  const other = Option.filter(
    Option.flatMap(last, ({ message }) => sourceOf(message)),
    recorded => recorded !== input.source,
  )
  if (Option.isSome(other))
    return yield* problem(
      `${input.path} is a copy of ${other.value}, not of ${input.source}: give this spec another name`,
    )
})

const readUrl = Effect.fnUntraced(function* (
  checkout: string,
  { url, shown, name }: Extract<SpecSource, { _tag: 'Url' }>,
) {
  const path = NodePath.posix.join(specsFolder, name)
  yield* sameSource({ checkout, path, source: shown })
  const fetched = yield* fetchSpec({ url, shown, checkout }).pipe(
    Effect.mapError(error =>
      problem(`the spec ${shown} can't be fetched: ${error.reason}`),
    ),
  )
  const text = yield* Result.match(textOf(shown, fetched.bytes), {
    onFailure: reason => Effect.fail(problem(reason)),
    onSuccess: Effect.succeed,
  })
  if (isHtml(fetched.contentType, text))
    return yield* problem(
      `${shown} gave a web page, not a spec: give the URL of the raw file`,
    )
  return {
    path,
    name,
    text,
    sha256: sha256Of(text),
    source: Option.some(shown),
    url: Option.some(shown),
  } satisfies ReadSpec
})

const readFile = Effect.fnUntraced(function* (checkout: string, given: string) {
  const git = yield* Git
  const full = NodePath.resolve(checkout, given)
  const place = yield* Effect.tryPromise({
    try: () => Promise.all([realpath(checkout), realpath(full)]),
    catch: () => problem(`the spec ${given} isn't there`),
  })
  const from = NodePath.relative(place[0], place[1])
  const inside = !from.startsWith('..') && !NodePath.isAbsolute(from)
  if (inside && (from === '.git' || from.startsWith(`.git${NodePath.sep}`)))
    return yield* problem(`the spec ${given} is inside .git`)
  if (inside && (yield* git.isIgnored({ repo: checkout, path: from })))
    return yield* problem(
      `git ignores the spec ${given}, and workers see only what is committed`,
    )
  const bytes = yield* readFileBytes(
    { root: NodePath.dirname(place[1]), path: NodePath.basename(place[1]) },
    { maxBytes: specMaxBytes },
  ).pipe(
    Effect.mapError(error =>
      problem(
        Match.value(error).pipe(
          Match.tag(
            'FileTooLarge',
            () =>
              `the spec ${given} is more than ${specMaxBytes / (1024 * 1024)} MB`,
          ),
          Match.orElse(
            ({ message }) => `the spec ${given} can't be read: ${message}`,
          ),
        ),
      ),
    ),
  )
  const text = yield* Result.match(textOf(given, bytes), {
    onFailure: reason => Effect.fail(problem(reason)),
    onSuccess: Effect.succeed,
  })
  const sha256 = sha256Of(text)
  if (inside) {
    return {
      path: from.split(NodePath.sep).join('/'),
      name: NodePath.basename(from),
      text,
      sha256,
      source: Option.none(),
      url: Option.none(),
    } satisfies ReadSpec
  }
  const named = copyName(NodePath.basename(place[1]))
  if (Option.isNone(named))
    return yield* problem(`the spec ${given} has no name to keep its copy by`)
  const name = named.value
  const path = NodePath.posix.join(specsFolder, name)
  yield* sameSource({ checkout, path, source: place[1] })
  return {
    path,
    name,
    text,
    sha256,
    source: Option.some(place[1]),
    url: Option.none(),
  } satisfies ReadSpec
})

/** The spec `given` names, a path from the checkout or a URL, or the problem with it. */
export const readSpec = Effect.fn('Spec.read')(function* (input: {
  readonly checkout: string
  readonly given: string
}) {
  const { checkout, given } = input
  const source = yield* Result.match(specSource(given), {
    onFailure: reason => Effect.fail(problem(reason)),
    onSuccess: Effect.succeed,
  })
  return yield* SpecSource.$match(source, {
    File: ({ path }) => readFile(checkout, path),
    Url: url => readUrl(checkout, url),
  })
})

/**
 * Commits the spec alone on the branch checked out, where HEAD doesn't have this text already; its
 * commit, the one that last changed it where nothing did.
 */
export const commitSpec = Effect.fn('Spec.commit')(function* (input: {
  readonly checkout: string
  readonly spec: ReadSpec
}) {
  const { checkout, spec } = input
  const git = yield* Git
  const { text, ...rest } = spec
  const [held, last] = yield* Effect.all(
    [
      git.fileAt({ repo: checkout, revision: 'HEAD', path: spec.path }),
      git.lastCommitOf({ repo: checkout, path: spec.path }),
    ],
    { concurrency: 2 },
  )
  if (Option.contains(held, text) && Option.isSome(last))
    return { ...rest, commit: last.value.commit } satisfies CommittedSpec
  yield* writeFileWhole({ root: checkout, path: spec.path }, text)
  const made = yield* git.commitFile({
    repo: checkout,
    path: spec.path,
    message: [
      `fabrica: ${Option.isSome(held) ? 'update' : 'add'} spec ${spec.name}`,
      '',
      `SHA-256: ${spec.sha256}`,
      ...Option.toArray(
        Option.map(spec.source, source => `${SourceTrailer}: ${source}`),
      ),
    ].join('\n'),
  })
  // The same text to git, whose line endings it normalises: kept as it is.
  const commit = Option.orElse(made, () =>
    Option.map(last, ({ commit: kept }) => kept),
  )
  if (Option.isNone(commit))
    return yield* problem(`git commits nothing of the spec ${spec.path}`)
  return { ...rest, commit: commit.value } satisfies CommittedSpec
})
