import { Data, Option, Result } from 'effect'

// What `--spec` names (spec §15.5, H83): a file, or a web URL, which is read here. A URL is https only,
// with no user name or password; a GitHub file page and a one-file gist page are fetched as their raw
// files; it is recorded and shown without its query and fragment, which may hold a token; and its copy
// is named after its last path segment. Each problem is a line of the start checks' report.

/** The most a spec may be, in bytes, from a URL or a file. */
export const specMaxBytes = 5 * 1024 * 1024

/** Where a spec from outside the repository is committed, as a copy (§10.2). */
export const specsFolder = '.fabrica/specs'

/** The longest a copy's name is, before `.md` is added. */
const maxNameLength = 100

/** The trailer of a copy's commits naming where it came from. */
export const SourceTrailer = 'Spec-Source'

/** A spec's source, as `--spec` gives it. */
export type SpecSource = Data.TaggedEnum<{
  /** A path, from the project's checkout or absolute. */
  File: { readonly path: string }
  Url: {
    /** The URL as given, its query included, which is what is fetched. */
    readonly url: URL
    /** The URL as it is recorded and shown. */
    readonly shown: string
    /** The name of its copy under `specsFolder`. */
    readonly name: string
  }
}>
export const SpecSource = Data.taggedEnum<SpecSource>()

/** A file on GitHub: its repository, ref and path as the URL encodes them, and its raw URL. */
export interface GitHubFile {
  readonly owner: string
  readonly repo: string
  readonly ref: string
  readonly path: string
  readonly raw: URL
}

/** Where GitHub's raw files and API are, which a test's stub stands in for. */
export interface GitHubHosts {
  readonly raw: string
  readonly api: string
}

export const githubHosts: GitHubHosts = {
  raw: 'https://raw.githubusercontent.com',
  api: 'https://api.github.com',
}

/** The URL's path segments as it encodes them, without the empty one a trailing slash leaves. */
const segmentsOf = (url: URL): ReadonlyArray<string> => {
  const segments = url.pathname.split('/').slice(1)
  return segments.at(-1) === '' ? segments.slice(0, -1) : segments
}

/** How many of `rest`'s segments are the ref: `refs/heads/<branch>` and `refs/tags/<tag>` are 3. */
const refLength = (rest: ReadonlyArray<string>): number =>
  rest[0] === 'refs' && (rest[1] === 'heads' || rest[1] === 'tags') ? 3 : 1

/** The GitHub file `url` names: a file page, or a raw URL, its raw file the same; none for another. */
export const githubFile = (
  url: URL,
  hosts: GitHubHosts = githubHosts,
): Option.Option<GitHubFile> => {
  const segments = segmentsOf(url)
  const none = Option.none<GitHubFile>()
  if (segments.some(segment => segment === '')) return none
  const page =
    url.hostname === 'github.com' || url.hostname === 'www.github.com'
  if (!page && url.hostname !== 'raw.githubusercontent.com') return none
  const [owner, repo, ...after] = segments
  if (page && after[0] !== 'blob' && after[0] !== 'raw') return none
  const rest = page ? after.slice(1) : after
  const length = refLength(rest)
  const path = rest.slice(length).join('/')
  if (owner === undefined || repo === undefined || path === '') return none
  const ref = rest.slice(0, length).join('/')
  // A raw URL's query is a private file's token.
  const raw = new URL(`${hosts.raw}/${owner}/${repo}/${ref}/${path}`)
  raw.search = url.search
  return Option.some({ owner, repo, ref, path, raw })
}

/** The ID of the gist `url`'s page names, `gist.github.com/<user>/<id>`. */
export const gistOf = (url: URL): Option.Option<string> => {
  const [user, id, ...rest] = segmentsOf(url)
  return url.hostname === 'gist.github.com' &&
    user !== undefined &&
    user !== '' &&
    id !== undefined &&
    /^[0-9a-z]+$/iu.test(id) &&
    rest.length === 0
    ? Option.some(id)
    : Option.none()
}

/**
 * The name of a copy of the spec called `name`: made a safe file name (letters, digits, `.`, `_` and
 * `-`, no leading dot), `.md` added unless it ends in `.md`, `.markdown` or `.txt`; none where
 * nothing of it is left.
 */
export const copyName = (name: string): Option.Option<string> => {
  const trim = (text: string) =>
    text.replace(/^[.-]+/u, '').replace(/[.-]+$/u, '')
  const safe = trim(
    trim(
      name
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/-{2,}/gu, '-'),
    ).slice(0, maxNameLength),
  )
  if (safe === '') return Option.none()
  return Option.some(/\.(md|markdown|txt)$/iu.test(safe) ? safe : `${safe}.md`)
}

/** A path segment of a URL, decoded where it reads as percent-encoded text. */
const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** The URL as it is recorded and shown: without its query and fragment, which may hold a token. */
export const shownUrl = (url: URL): string => {
  const bare = new URL(url.href)
  bare.search = ''
  bare.hash = ''
  bare.username = ''
  bare.password = ''
  return bare.href
}

/** The source `--spec` gives, or the problem with it. */
export const specSource = (
  given: string,
): Result.Result<SpecSource, string> => {
  const text = given.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text))
    return Result.succeed(SpecSource.File({ path: text }))
  if (!URL.canParse(text))
    return Result.fail(
      `the spec isn't a URL Fabrica can read: give an https:// URL, or a file's path`,
    )
  const url = new URL(text)
  const shown = shownUrl(url)
  if (url.protocol !== 'https:')
    return Result.fail(
      `the spec ${shown} is a ${url.protocol.slice(0, -1)} URL: Fabrica fetches a spec over https only`,
    )
  if (url.username !== '' || url.password !== '')
    return Result.fail(
      `the spec ${shown} holds a user name or password, and Fabrica sends no credentials: give the URL without them`,
    )
  const name = copyName(decoded(segmentsOf(url).at(-1) ?? ''))
  if (Option.isNone(name))
    return Result.fail(
      `the spec ${shown} names no file: give the URL of the spec's raw file`,
    )
  return Result.succeed(SpecSource.Url({ url, shown, name: name.value }))
}
