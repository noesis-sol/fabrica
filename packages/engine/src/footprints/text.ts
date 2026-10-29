import { setOf } from './names'

// How a ticket's text is read for a footprint (spec §13.4), when it gives no `files`: the words that
// may be paths, the functions it names, its sentences, and whether a sentence asks to change a
// document it names or only cites it. Which words are the repository's paths and functions is
// `Repository`'s and `Declared`'s to say; these only find the candidates.

// The rest of a path token outside brackets: letters, digits, marks, _ . / -, and a + starting a
// name after a /.
const pathRest = String.raw`(?:/\+[\p{L}\p{M}\p{N}_]|[\p{L}\p{M}\p{N}_./-])*`
// A path token is anything that could be a path: src/run/loop.ts:661 (the line number left off),
// docs/café.md, Loop.merge (sorted out later). Letters and digits of any script count, and
// combining marks: macOS often writes é as e and U+0301. So do brackets around a name inside a word,
// as in the routes of a Next.js or SvelteKit project (pages/[id].tsx, app/[[...slug]]/page.tsx),
// and a + starting a name (src/routes/+page.svelte).
const pathToken = new RegExp(
  String.raw`(?:\+[\p{L}\p{M}\p{N}_]|[\p{L}\p{M}\p{N}_./-])${pathRest}` +
    String.raw`(?:(?:\[[\p{L}\p{M}\p{N}_.=-]+\]|\[\[[\p{L}\p{M}\p{N}_.=-]+\]\])${pathRest})*`,
  'gu',
)
// A part of a path token without brackets or a +, which a word with them may be instead: an index
// expression (files[i]), or a + marking an added line.
const plainPathToken = /[\p{L}\p{M}\p{N}_./-]+/gu
// A path token's ASCII part, which may be a path run into words of a script written without spaces:
// 修改loop.go, loop.goを直す.
const asciiPathToken = /[\w./-]+/gu

/** A word a path token may be: as written, and whether it is quoted (in backticks or quotes). */
export interface PathWord {
  readonly word: string
  readonly quoted: boolean
}

const quotes = new Set(['`', '"', "'", '‘', '’', '“', '”'])

const trimRight = (word: string): string => word.replace(/[./-]+$/u, '')

const nonAscii = (c: string): boolean => (c.codePointAt(0) ?? 0) > 0x7f

/** Whether c, before a + starting a token, joins two words of an expression (a+b.go, C++) instead. */
const joinsWords = (c: string): boolean =>
  /^[\p{L}\p{M}\p{N}_.\-+)\]}]$/u.test(c)

/**
 * Calls `take` with each word of text that may be a path, and its parts when it names nothing: a word
 * with brackets or a + in its plain parts (`Footprint.files[0]`, `+loop.go`), one with characters
 * outside ASCII in its ASCII parts (`修改loop.go`). `take` says whether the word named something.
 * Neither an absolute path nor a URL is taken: neither is in the repository.
 */
export const eachPathWord = (
  text: string,
  take: (word: PathWord) => boolean,
): void => {
  for (const match of text.matchAll(pathToken)) {
    const before = text.slice(0, match.index).at(-1) ?? ''
    const after = text.charAt(match.index + match[0].length)
    const quoted = quotes.has(before) && quotes.has(after)
    const token = joinsWords(before) ? match[0].replace(/^\+/u, '') : match[0]
    takeWord(token, quoted, take)
  }
}

const takeWord = (
  token: string,
  quoted: boolean,
  take: (word: PathWord) => boolean,
): void => {
  const word = trimRight(token)
  if (word === '' || word.startsWith('/') || word.includes('//')) return
  if (take({ word, quoted })) return
  if (/[[\]+]/u.test(word)) {
    for (const [part] of word.matchAll(plainPathToken))
      takeWord(part, false, take)
    return
  }
  if (![...word].some(nonAscii)) return
  for (const [ascii] of word.matchAll(asciiPathToken)) {
    const part = trimRight(ascii)
    if (part !== '' && !part.startsWith('/'))
      take({ word: part, quoted: false })
  }
}

/** `Type.method`, which a path token naming no file may be. */
const typeMethod = /^[A-Z][\w$]*\.[A-Za-z_$][\w$]*$/u
// A function named with its parentheses: refreshBranch(), Loop.merge(), o.log.raw().
const called = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\(\)/gu
// Markdown's `code`, where a function is often named without parentheses.
const codeSpan = /`([^`\n]+)`/gu
// A call in a code span, with or without arguments: o.agentName(id).
const callIn = /\b((?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*)\(/gu
// An identifier with a hump (waitSettled, LastToolUse), which in a code span is code, where a plain
// word (solo) may not be.
const camelCase = /^[A-Za-z_$][\w$]*[a-z0-9][A-Z][\w$]*$/u

/**
 * A function as the footprint keeps it, from a call's name: a lower-case qualifier is a package, a
 * variable or a field (`o.merge`, `o.log.raw`), not a type, and is left off; a capitalised one is
 * the type (`Loop.merge`).
 */
const functionName = (call: string): string => {
  const parts = call.split('.')
  const name = parts.at(-1) ?? ''
  const qualifier = parts.at(-2)
  return qualifier !== undefined && /^[A-Z]/u.test(qualifier)
    ? `${qualifier}.${name}`
    : name
}

/** Whether a word naming no file is a function: `Type.method`. */
export const isTypeMethod = (word: string): boolean => typeMethod.test(word)

/**
 * The functions text names, apart from its `Type.method` words: those with their parentheses
 * (`refreshBranch()`, `Loop.merge()`), and in its code spans an identifier with a hump
 * (`waitSettled`) or a call with or without arguments (`o.agentName(id)`).
 */
export const functionsIn = (text: string): ReadonlyArray<string> => [
  ...[...text.matchAll(called)].map(m => functionName(m[1] ?? '')),
  ...[...text.matchAll(codeSpan)].flatMap(m => {
    const code = (m[1] ?? '').trim()
    return [
      ...(camelCase.test(code) ? [code] : []),
      ...[...code.matchAll(callIn)].map(c => functionName(c[1] ?? '')),
    ]
  }),
]

// The end of a sentence: a line's end, or a . ! or ? and the spaces after it (a closing quote or
// bracket between them), unless a lower-case letter follows (e.g. docs/x.md).
const sentenceBreak = /[.!?]["'’”)\]]*\s+|\n/gu

/** The sentences of text, each with the break that ends it. */
export const sentences = (text: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let start = 0
  for (const m of text.matchAll(sentenceBreak)) {
    const end = m.index + m[0].length
    if (m[0] !== '\n' && /^\p{Ll}/u.test(text.slice(end))) continue
    out.push(text.slice(start, end))
    start = end
  }
  out.push(text.slice(start))
  return out
}

// A word asking for a change to a document a sentence names near it, before or after it: "Update
// docs/running.md", "Add the result to docs/spikes/07.md", "docs/x.md updated".
const changeWord = new RegExp(
  String.raw`\b(?:add|added|adding|update|updated|updating|change|changed|changing|edit|edited|` +
    'editing|write|written|writing|rewrite|rewritten|reword|reworded|document|fix|fixed|' +
    'correct|corrected|mention|say|describe|explain|note|record|remove|removed|delete|' +
    String.raw`deleted|drop|replace|rename|move|put|pin|keep|extend|create|split|trim|shorten|expand)\b`,
  'iu',
)
// A word saying, after a document it follows, what the document is to do or have: "docs/setup.md
// says how to run them".
const changesWord = new RegExp(
  String.raw`\b(?:adds|updates|changes|edits|writes|rewrites|rewords|fixes|mentions|says|describes|` +
    'explains|notes|records|removes|deletes|drops|replaces|renames|moves|extends|creates|' +
    String.raw`lists|names|gives|shows|covers)\b`,
  'iu',
)
// The words that, among the two before a document, cite it: "per docs/setup.md", "see CLAUDE.md".
const citeWords = setOf('per see following as like cf according via')
// How many words before a document and after it a change word is looked for in.
const changeBefore = 8
const changeAfter = 3

const letter = /\p{L}/u

/**
 * Whether a sentence, as its words, asks to change the document its i-th word names: the document
 * starts it ("- docs/running.md: say …"), or, unless one of the two words before it cites it ("per",
 * "see"), a change word is among the words near it. A sentence citing it ("Reproduce per
 * docs/setup.md", "Spike 1 (docs/spikes/01.md) found that …") does none of these.
 */
export const asksChange = (
  words: ReadonlyArray<string>,
  i: number,
): boolean => {
  if (i === words.findIndex(w => letter.test(w))) return true
  for (const w of words.slice(Math.max(0, i - 2), i))
    if (citeWords.has(w.replace(/^\P{L}+|\P{L}+$/gu, '').toLowerCase()))
      return false
  const before = (words[i] ?? '').startsWith('(')
    ? ''
    : words.slice(Math.max(0, i - changeBefore), i).join(' ')
  const after = words.slice(i + 1, i + 1 + changeAfter).join(' ')
  return (
    changeWord.test(before) || changeWord.test(after) || changesWord.test(after)
  )
}
