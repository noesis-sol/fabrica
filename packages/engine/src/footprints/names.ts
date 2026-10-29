// What a footprint knows of a path by its name alone (spec §13.4): its folder, its base name, its
// extension, whether it is a document, and whether it can be a path in the repository at all.

/** The words of a list written one after another, as a set. */
export const setOf = (words: string): ReadonlySet<string> =>
  new Set(words.split(/\s+/u).filter(word => word !== ''))

/** The names, each once, sorted. */
export const sorted = (items: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(items)].sort()

/** A path's folder: `.` for one at the root. */
export const dirname = (path: string): string => {
  const end = path.lastIndexOf('/')
  return end === -1 ? '.' : path.slice(0, end)
}

/** A path's last name. */
export const basename = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1)

/** The extension of a path's base name, lower-cased and without its dot: `""` for none. */
export const extensionOf = (path: string): string => {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** The extensions of documents: prose, which tickets cite for conventions more often than they change. */
const documentExtensions = setOf('md markdown mdx txt rst adoc')

/** Whether a file is a document (`.md`, `.txt`): prose, holding no code. */
export const isDocument = (path: string): boolean =>
  documentExtensions.has(extensionOf(path))

/**
 * A name as a path from the repository's root, cleaned (no `./` parts, no `a/..` pairs, no trailing
 * slash), or undefined for one that can't be in it: empty, the root itself, absolute, or leading
 * out of it (`/etc/passwd`, `../x.ts`).
 */
export const repoPath = (name: string): string | undefined => {
  if (name.startsWith('/')) return undefined
  const parts: Array<string> = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else parts.push(part)
  }
  return parts.length === 0 ? undefined : parts.join('/')
}
