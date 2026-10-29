import { Effect } from 'effect'

import { codeExtensions } from './code'
import { extensionOf, setOf } from './names'
import type { Repository } from './repository'
import { type ReadSource, readAll } from './sources'

// The names the repository declares (spec §13.4): the functions, types, constants, classes, methods
// and fields its tracked source files define. A function a ticket's text names counts only when the
// repository declares it: tickets name library and everyday functions (`JSON.stringify`,
// `Effect.fn`) that say nothing about where they work (tutti-ejkt.3, -gr4z.2). A declaration is read
// by its look, a line at a time, in the languages projects are written in; a name read where there
// is none (a field of an object literal) only counts a name as declared that might not be.

// Words as alternatives of a regular expression.
const either = (words: string): string => [...setOf(words)].join('|')

// A declaration by its keyword, starting a line after its modifiers: function merge, export const
// Loop, pub fn run, async def main, class Git, type Footprint, interface Repository, def self.name;
// not a type an import names on a line of its own (  type Effect,).
const keyword = new RegExp(
  String.raw`^[ \t]*(?:(?:${either(`export default declare async public private protected internal
    static abstract final sealed open override unsafe inline extern data case`)}|pub(?:\([\w ]*\))?|` +
    String.raw`const(?=[ \t]+fn\b))[ \t]+)*(?:function\b\*?|(?:${either(`func fn fun def class
    struct interface trait type enum union namespace module object record const let var val
    static`)})\b)` +
    String.raw`[ \t]*\*?[ \t]*(?:self\.)?([A-Za-z_$][\w$]*)(?![\w$]|[ \t]*[,}]|[ \t]+as\b)`,
  'gmu',
)
// A Go method: func (r *Repo) Merge(.
const goMethod = /^func[ \t]*\([^)\n]*\)[ \t]*([A-Za-z_]\w*)/gmu
// A method, a field or a shell function, starting a line after its modifiers: merge(a: A): B,
// merge(a) {, readonly merge: (a: A) => B, files?: string, name() {. A call starting a line
// (merge(a)) is none: a method's parameters are followed by its type or its body; nor is a
// statement (if (x) {). A signature is read up to 200 characters a part, so that a long line (a
// bundle's) takes no longer than a short one.
const member = new RegExp(
  String.raw`^[ \t]*(?:(?:${either(`public private protected internal static async readonly
    abstract override get set declare final open`)})[ \t]+)*` +
    String.raw`(?!(?:${either('if for while switch catch with elif else return')})\b)` +
    String.raw`([A-Za-z_$][\w$]*)[?!]?[ \t]*` +
    String.raw`(?:<[^>\n]{0,200}>[ \t]*)?(?:\([^\n]{0,200}\)[ \t]*(?::[^\n]{0,200})?\{[ \t]*$|` +
    String.raw`\([^\n]{0,200}\)[ \t]*:|:)`,
  'gmu',
)
// An assignment starting a line, at a module's top: MAX_SIZE = 10 (Python), name=value (shell).
const assigned = /^([A-Za-z_$][\w$]*)[ \t]*=(?!=)/gmu

/** Whether a file is source code, whose declarations and mentions are read: by its extension. */
export const isSource = (file: string): boolean =>
  codeExtensions.has(extensionOf(file))

/** The names a source file's text declares, each once, by its look (see the expressions above). */
export const declaredIn = (text: string): ReadonlyArray<string> => [
  ...new Set(
    [keyword, goMethod, member, assigned].flatMap(form =>
      [...text.matchAll(form)].flatMap(m => (m[1] === undefined ? [] : [m[1]])),
    ),
  ),
]

/** What the repository declares, to tell its functions from a library's. */
export interface Declared {
  /**
   * Whether a function a ticket names is the repository's: `merge` when a source file declares it,
   * `Type.method` (`Loop.merge`) only when both parts are declared.
   */
  readonly declares: (fn: string) => boolean
}

/** The declarations of the source files' texts, by path; a file that isn't source is passed over. */
export const declaredBy = (
  sources: Iterable<readonly [string, string]>,
): Declared => {
  const names = new Set<string>()
  for (const [file, text] of sources)
    if (isSource(file)) for (const name of declaredIn(text)) names.add(name)
  return { declares: fn => fn.split('.').every(part => names.has(part)) }
}

/**
 * What the tracked source files declare, each read once: once per Base, and only where a ticket
 * without `files` names a function (`namesFunctions`).
 */
export const readDeclared = Effect.fn('Footprints.readDeclared')(
  function* (input: {
    readonly repository: Repository
    readonly read: ReadSource
  }) {
    const sources = yield* readAll(
      input.read,
      input.repository.files.filter(isSource),
    )
    return declaredBy(sources)
  },
)
