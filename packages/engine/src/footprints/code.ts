// The code of a source file without its comments and string literals (spec §13.4): a function a
// log string or a comment names isn't one the file uses (tutti-mfij). Each family of syntax is a
// small table of its comments and quotes, read by their look, a character at a time; a file that
// isn't code (`codeExtensions`) mentions nothing, and one of a family-less language (Vue, Svelte)
// keeps all its text. A misreading (a regular expression
// taken for a division, an apostrophe in JSX text taken for a quote) only leaves out words up to the
// line's end at most, or a shell's << taken for a heredoc's up to a line that closes it as one,
// where the merge's rebase and check still catch a conflict a hold didn't.
import { extensionOf, setOf } from './names'

/** The extensions of the source files declarations and mentions are read from: code, not prose or data. */
export const codeExtensions =
  setOf(`go swift py js mjs cjs ts mts cts tsx jsx rs rb java kt kts c
  h cc cpp hpp m mm sh bash zsh gradle cs php ex exs erl hs ml scala dart vue svelte`)

/**
 * A string literal: from `open` to `close`, a backslash escaping the character after it where
 * `escape`, ended by a line's end too where `line`, and holding code between each of `holes`' pairs
 * (`${` and `}`), whose close is one character; a hole's open doubled is text where `doubled`
 * (Python's `{{`).
 */
interface Quote {
  readonly open: string
  readonly close: string
  readonly escape: boolean
  readonly line: boolean
  readonly holes: ReadonlyArray<readonly [string, string]>
  readonly doubled: boolean
}

/** A family of syntax: its comments, its quotes and the literals read by a pattern. */
interface Syntax {
  /** What starts a comment to the line's end. */
  readonly line: ReadonlyArray<string>
  /** Whether a line comment starts only a word, as the shell's # does (not in ${#a} or $#). */
  readonly wordStart: boolean
  /** A block comment's open and close, nesting where `nested`. */
  readonly block: readonly [string, string] | undefined
  readonly nested: boolean
  /** Longest open first, as the first that matches is taken. */
  readonly quotes: ReadonlyArray<Quote>
  /** A character literal where one is ('a', '\n'), not a Rust lifetime ('a) or a Swift word. */
  readonly chars: boolean
  /** Whether ' also ends names (x'), so that a ' right after a word starts no character. */
  readonly primes: boolean
  /** Whether a / where an expression starts begins a regular expression, as in JavaScript. */
  readonly regex: boolean
  /** Whether <<WORD starts a heredoc, its lines to one that is WORD a string, as in the shell. */
  readonly heredoc: boolean
  /** The characters any of the above starts with: the others are code, passed over at once. */
  readonly starts: ReadonlySet<string>
}

const quote = (
  open: string,
  options: {
    close?: string
    escape?: boolean
    line?: boolean
    holes?: string
    doubled?: boolean
  } = {},
): Quote => ({
  open,
  close: options.close ?? open,
  escape: options.escape ?? true,
  line: options.line ?? open.length === 1,
  holes: (options.holes ?? '')
    .split(' ')
    .filter(h => h !== '')
    .map(h => [h, h.endsWith('(') ? ')' : '}'] as const),
  doubled: options.doubled ?? false,
})

const syntax = (fields: Partial<Omit<Syntax, 'starts'>>): Syntax => {
  const s = {
    line: [],
    wordStart: false,
    block: undefined,
    nested: false,
    quotes: [],
    chars: false,
    primes: false,
    regex: false,
    heredoc: false,
    ...fields,
  }
  const openers = [...s.line, s.block?.[0] ?? '', ...s.quotes.map(q => q.open)]
  if (s.chars) openers.push("'")
  if (s.regex) openers.push('/')
  if (s.heredoc) openers.push('<')
  return {
    ...s,
    starts: new Set(openers.filter(o => o !== '').map(o => o.charAt(0))),
  }
}

const cComments = { line: ['//'], block: ['/*', '*/'] as const }
const doubleQuoted = quote('"')

/** Each way of writing word in either case: f, F for f. */
const casings = (word: string): Array<string> =>
  [...word].reduce<Array<string>>(
    (all, c) => all.flatMap(w => [w + c.toLowerCase(), w + c.toUpperCase()]),
    [''],
  )

// Python's strings, an f-string's (f, rf or fr before it) with code in its {…} and {{ a brace.
const pythonQuotes = ['"""', "'''", '"', "'"]
  .flatMap(q => [
    quote(q),
    ...['f', 'rf', 'fr'].flatMap(casings).map(f =>
      quote(f + q, {
        close: q,
        line: q.length === 1,
        holes: '{',
        doubled: true,
      }),
    ),
  ])
  .sort((a, b) => b.open.length - a.open.length)

// A heredoc's body, a string: its words text where its delimiter is quoted ('EOF', "EOF" or
// \EOF), and with the code of $(…) and ${…} kept where it isn't.
const heredocText = quote('', { escape: false, line: false })
const heredocExpanded = quote('', { line: false, holes: '$( ${' })

// The families, by the extensions that use them. vue and svelte have none: their markup's text is
// prose, with apostrophes that aren't quotes.
const families: ReadonlyArray<readonly [string, Syntax]> = [
  [
    'js mjs cjs ts mts cts tsx jsx',
    syntax({
      ...cComments,
      quotes: [
        doubleQuoted,
        quote("'"),
        quote('`', { line: false, holes: '${' }),
      ],
      regex: true,
    }),
  ],
  [
    'go',
    syntax({
      ...cComments,
      quotes: [doubleQuoted, quote('`', { escape: false })],
      chars: true,
    }),
  ],
  [
    'rs',
    syntax({
      ...cComments,
      nested: true,
      quotes: [
        ...['###', '##', '#', ''].map(h =>
          quote(`r${h}"`, { close: `"${h}`, escape: false, line: false }),
        ),
        quote('"', { line: false }),
      ],
      chars: true,
    }),
  ],
  [
    'c h cc cpp hpp m mm cs',
    syntax({ ...cComments, quotes: [doubleQuoted], chars: true }),
  ],
  [
    'java',
    syntax({
      ...cComments,
      quotes: [quote('"""', { line: false }), doubleQuoted],
      chars: true,
    }),
  ],
  [
    'kt kts scala',
    syntax({
      ...cComments,
      nested: true,
      quotes: [
        quote('"""', { escape: false, holes: '${' }),
        quote('"', { holes: '${' }),
      ],
      chars: true,
    }),
  ],
  [
    'swift',
    syntax({
      ...cComments,
      nested: true,
      quotes: [quote('"""', { holes: '\\(' }), quote('"', { holes: '\\(' })],
    }),
  ],
  [
    'dart gradle',
    syntax({
      ...cComments,
      quotes: ['"""', "'''", '"', "'"].map(q => quote(q, { holes: '${' })),
    }),
  ],
  [
    'php',
    syntax({
      line: ['//', '#'],
      block: cComments.block,
      quotes: [doubleQuoted, quote("'")],
    }),
  ],
  ['py', syntax({ line: ['#'], quotes: pythonQuotes })],
  [
    'rb',
    syntax({
      line: ['#'],
      quotes: [
        quote('"', { line: false, holes: '#{' }),
        quote("'", { line: false }),
      ],
    }),
  ],
  [
    'ex exs',
    syntax({
      line: ['#'],
      quotes: ['"""', "'''", '"', "'"].map(q =>
        quote(q, { line: false, holes: '#{' }),
      ),
    }),
  ],
  [
    'sh bash zsh',
    syntax({
      line: ['#'],
      wordStart: true,
      quotes: [
        quote('"', { line: false, holes: '$( ${' }),
        quote("'", { escape: false, line: false }),
      ],
      heredoc: true,
    }),
  ],
  // Erlang's '…' is an atom, code; Haskell's and OCaml's ' also ends names (x') and starts type
  // variables ('a), which aren't characters ('a').
  ['erl', syntax({ line: ['%'], quotes: [doubleQuoted] })],
  [
    'hs',
    syntax({
      line: ['--'],
      block: ['{-', '-}'],
      nested: true,
      quotes: [doubleQuoted],
      chars: true,
      primes: true,
    }),
  ],
  [
    'ml',
    syntax({
      block: ['(*', '*)'],
      nested: true,
      quotes: [quote('"', { line: false })],
      chars: true,
      primes: true,
    }),
  ],
]

const familyOf = new Map<string, Syntax>(
  families.flatMap(([extensions, s]) =>
    [...setOf(extensions)].map(e => [e, s] as const),
  ),
)

/** The syntax of a file by its extension: undefined for one with no family, or not code. */
export const syntaxOf = (file: string): Syntax | undefined =>
  familyOf.get(extensionOf(file))

// A character literal: 'a', '\n', '\'', '\u{1F600}'; not a lifetime ('a) or a quote in a word.
const charLiteral = /'(?:\\.[^\n']{0,9}|[^\\'\n])'/uy

// What precedes a regular expression rather than a division: an operator or an opening bracket,
// or a keyword.
const beforeRegex = new Set('(,=:[!&|?{};+-*%~^')
const regexKeywords = setOf(
  'return typeof case do else in of new delete void throw yield await instanceof',
)

const isWordChar = (c: string): boolean => /[\w$]/.test(c)
const isSpace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** Whether a / at i starts a regular expression: what comes before it starts an expression. */
const regexAt = (text: string, i: number): boolean => {
  let j = i - 1
  while (j >= 0 && isSpace(text.charAt(j))) j--
  if (j < 0) return true
  if (beforeRegex.has(text.charAt(j))) return true
  let k = j
  while (k >= 0 && isWordChar(text.charAt(k))) k--
  return k < j && regexKeywords.has(text.slice(k + 1, j + 1))
}

/** The end of a regular expression whose / is at i, past its closing /; -1 for none on the line. */
const regexEnd = (text: string, i: number): number => {
  let inClass = false
  for (let j = i + 1; j < text.length; j++) {
    const c = text.charAt(j)
    if (c === '\n') return -1
    if (c === '\\') j++
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return j + 1
  }
  return -1
}

// A heredoc's start: <<, or <<- for one whose lines may start with tabs, then its delimiter, quoted
// or bare (not <<< or 1 << 2).
const heredocStart =
  /<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_]\w*))/y

/** The end of a heredoc's body from `from`: the end of its line that is `word`; -1 for none. */
const heredocEnd = (
  text: string,
  from: number,
  word: string,
  tabs: boolean,
): number => {
  let p = from
  while (p < text.length) {
    const n = text.indexOf('\n', p)
    const end = n === -1 ? text.length : n
    const line = text.slice(p, end).replace(/\r$/, '')
    if ((tabs ? line.replace(/^\t+/, '') : line) === word) return end
    p = end + 1
  }
  return -1
}

/** The end of a block comment opened at i, past its close, or the text's end. */
const blockEnd = (
  text: string,
  i: number,
  [open, close]: readonly [string, string],
  nested: boolean,
) => {
  let depth = 1
  let j = i + open.length
  while (j < text.length) {
    if (text.startsWith(close, j)) {
      j += close.length
      if (--depth === 0) return j
    } else if (nested && text.startsWith(open, j)) {
      j += open.length
      depth++
    } else j++
  }
  return text.length
}

/** Where code is read: the file's top, or a hole of a string, ended by `close` at depth 0. */
interface InCode {
  readonly quote: undefined
  readonly open: string
  readonly close: string
  depth: number
}
/** A string, ended by its close, or at `end` for a heredoc's. */
type Frame = InCode | { readonly quote: Quote; readonly end?: number }

/**
 * The code of text, in syntax, its comments and string literals each left out for a space and the
 * code in a string's holes kept: every word of the result is a word of text. Read with a stack, not
 * by recursion, so that holes nested however deep can't overflow it.
 */
export const codeOf = (text: string, s: Syntax): string => {
  const parts: Array<string> = []
  const stack: Array<Frame> = [
    { quote: undefined, open: '', close: '', depth: 0 },
  ]
  let start = 0
  let i = 0
  const keep = (end: number) => {
    if (end > start) parts.push(text.slice(start, end))
  }
  // The heredocs a line started, in order, whose bodies start at the line's end, `bodies`.
  let heredocs: Array<{ readonly quote: Quote; readonly end: number }> = []
  let bodies = -1
  while (i < text.length) {
    if (bodies !== -1 && i >= bodies) {
      // Not where the line ends in a string (cat <<EOF "…): too odd to read.
      if (i === bodies && stack.at(-1)?.quote === undefined) {
        keep(i)
        stack.push(...[...heredocs].reverse())
      }
      heredocs = []
      bodies = -1
    }
    const top = stack.at(-1)
    if (top === undefined) break
    const c = text.charAt(i)
    if (top.quote !== undefined) {
      const q = top.quote
      if (top.end !== undefined && i >= top.end) {
        stack.pop()
        i = top.end
        start = i
        continue
      }
      // A hole first, as Swift's \( starts with what escapes elsewhere.
      const hole = q.holes.find(([open]) => text.startsWith(open, i))
      if (
        hole !== undefined &&
        q.doubled &&
        text.startsWith(hole[0], i + hole[0].length)
      ) {
        i += 2 * hole[0].length
      } else if (hole !== undefined) {
        i += hole[0].length
        stack.push({
          quote: undefined,
          open: hole[0].slice(-1),
          close: hole[1],
          depth: 0,
        })
        start = i
      } else if (q.escape && c === '\\') i += 2
      else if (q.line && c === '\n') {
        stack.pop()
        start = i
      } else if (top.end === undefined && text.startsWith(q.close, i)) {
        stack.pop()
        i += q.close.length
        start = i
      } else i++
      continue
    }
    if (top.close !== '' && c === top.close) {
      if (top.depth > 0) {
        top.depth--
        i++
        continue
      }
      keep(i)
      stack.pop()
      i++
      continue
    }
    if (top.close !== '' && c === top.open) {
      top.depth++
      i++
      continue
    }
    if (!s.starts.has(c)) {
      i++
      continue
    }
    const comment = s.line.find(
      l =>
        text.startsWith(l, i) &&
        (!s.wordStart ||
          i === 0 ||
          isSpace(text.charAt(i - 1)) ||
          ';&|('.includes(text.charAt(i - 1))),
    )
    if (comment !== undefined) {
      keep(i)
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end
      start = i
      continue
    }
    if (s.block !== undefined && text.startsWith(s.block[0], i)) {
      keep(i)
      i = blockEnd(text, i, s.block, s.nested)
      start = i
      continue
    }
    if (
      s.chars &&
      c === "'" &&
      !(s.primes && i > 0 && isWordChar(text.charAt(i - 1)))
    ) {
      charLiteral.lastIndex = i
      if (charLiteral.test(text)) {
        keep(i)
        i = charLiteral.lastIndex
        start = i
        continue
      }
    }
    if (s.heredoc && c === '<') {
      heredocStart.lastIndex = i
      const m = heredocStart.exec(text)
      const word = m?.[2] ?? m?.[3] ?? m?.[5]
      const line = bodies !== -1 ? bodies : text.indexOf('\n', i)
      if (m !== null && word !== undefined && line !== -1) {
        const from = (heredocs[heredocs.length - 1]?.end ?? line) + 1
        const end = heredocEnd(text, from, word, m[1] === '-')
        if (end !== -1) {
          const quoted =
            m[2] !== undefined || m[3] !== undefined || m[4] === '\\'
          heredocs.push({ quote: quoted ? heredocText : heredocExpanded, end })
          bodies = line
        }
        i = heredocStart.lastIndex
      } else while (text.charAt(i) === '<') i++
      continue
    }
    if (s.regex && c === '/' && regexAt(text, i)) {
      const end = regexEnd(text, i)
      if (end !== -1) {
        keep(i)
        i = end
        start = i
        continue
      }
    }
    // A quote with a prefix (Rust's r"…") starts a word, not ends one (bar"…").
    const q = s.quotes.find(
      x =>
        text.startsWith(x.open, i) &&
        !(isWordChar(c) && i > 0 && isWordChar(text.charAt(i - 1))),
    )
    if (q !== undefined) {
      keep(i)
      stack.push({ quote: q })
      i += q.open.length
      continue
    }
    i++
  }
  if (stack[stack.length - 1]?.quote === undefined) keep(text.length)
  return parts.join(' ')
}

/** The code of a source file's text: all of it for a language with no family. */
export const codeIn = (file: string, text: string): string => {
  const s = syntaxOf(file)
  return s === undefined ? text : codeOf(text, s)
}
