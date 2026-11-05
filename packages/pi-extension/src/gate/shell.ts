import { Data, Option } from 'effect'

// A bash command line, read as the command policy needs it (spec §12.6): its simple commands, in the
// order they run, those inside command and process substitutions included, each with its words and
// the files its redirections write. A word keeps its text, its escaped form for brace expansion and
// globbing (a quoted or escaped character behind a backslash), and whether part of it is only known
// when it runs (a variable, a command's output); `$HOME` is the home folder where that is known. What
// the reader can't follow (an unclosed quote, a here-document that runs commands) is unparsable, so
// the gate asks instead of guessing.

export interface Word {
  /** The word's text, its quotes removed; a dynamic part as written. */
  readonly text: string
  /** Its escaped form: a quoted or escaped `\ { } * ? [ ] , ~ # ^` behind a backslash. */
  readonly pattern: string
  /** Part of it is known only when it runs. */
  readonly dynamic: boolean
}

export interface SimpleCommand {
  readonly words: ReadonlyArray<Word>
  /** The files its redirections write. */
  readonly writes: ReadonlyArray<Word>
}

export type Script = Data.TaggedEnum<{
  Parsed: {
    readonly commands: ReadonlyArray<SimpleCommand>
    /** A `$'…'` holds a character code, which can spell an option or a name anywhere, and isn't decoded. */
    readonly codes: boolean
    /** The words that name no command: a function's name, a loop's variable and list, a case's subject, a read redirection's file, a here-document's assigning expansions. */
    readonly unnamed: ReadonlyArray<Word>
  }
  Unparsable: { readonly reason: string }
}>
export const Script = Data.taggedEnum<Script>()

class Unparsable extends Data.TaggedError('Unparsable')<{
  readonly reason: string
}> {}

/** Words that open or close the shell's compound commands, skipped where a command's name would be. */
const reserved: ReadonlySet<string> = new Set([
  '!',
  '{',
  '}',
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'until',
  'while',
])

/** The words after a reserved word that name no command: `function f`, `for x in a b`, `case x in`. */
const skipped = new Map<string, number | 'rest'>([
  ['function', 1],
  ['for', 'rest'],
  ['select', 'rest'],
  ['case', 'rest'],
])

const special = new Set([
  '\\',
  '{',
  '}',
  '*',
  '?',
  '[',
  ']',
  ',',
  '~',
  '#',
  '^',
])
const breaking = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const nameStart = /[A-Za-z_]/u
const nameChar = /[A-Za-z0-9_]/u
const redirection =
  /(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)|(&>>|&>)/uy

/** The one-character escapes of `$'…'` and the characters they stand for, by code. */
const ansiEscapes: ReadonlyMap<string, number> = new Map([
  ['a', 7],
  ['b', 8],
  ['e', 27],
  ['E', 27],
  ['f', 12],
  ['n', 10],
  ['r', 13],
  ['t', 9],
  ['v', 11],
  ['\\', 92],
  ["'", 39],
  ['"', 34],
  ['?', 63],
])

/** The escapes of `$'…'` that take hexadecimal digits, and how many at most. */
const ansiHexadecimals: ReadonlyMap<string, number> = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
])

interface HereDocument {
  readonly delimiter: string
  readonly stripTabs: boolean
  readonly expands: boolean
}

/** In an expanding here-document's body, the expansions that may assign: `${X:=y}`, `$((X=1))`. */
const assigningExpansion = /\$(?:\{[^}]*|\(\([^)]*)=[^}\n]*/gu

/** Reads `source` from the start; `home` stands for `$HOME`. */
class Reader {
  index = 0
  readonly commands: Array<SimpleCommand> = []
  readonly unnamed: Array<Word> = []
  readonly pending: Array<HereDocument> = []
  /** How many backtick substitutions the reader is inside, where a backtick closes one. */
  backticks = 0
  /** A `$'…'` held a character code. */
  codes = false

  constructor(
    readonly source: string,
    readonly home: Option.Option<string>,
  ) {}

  peek(offset = 0): string {
    return this.source[this.index + offset] ?? ''
  }

  /** Reads commands until `end` (a closing parenthesis or backtick) or the end of the source. */
  list(end: ')' | '`' | undefined): void {
    let words: Array<Word> = []
    let writes: Array<Word> = []
    /** Words that name no command: a function's name, a loop's variable and list, a case's subject. */
    let skip: number | 'rest' = 0
    /** A `[[ … ]]` test's parenthesis ended the words before it: what follows is still the test. */
    let testing = false
    const finish = () => {
      if (words.length > 0 || writes.length > 0)
        this.commands.push({ words, writes })
      words = []
      writes = []
      skip = 0
      testing = false
    }
    while (this.index < this.source.length) {
      const char = this.peek()
      if (char === ' ' || char === '\t') {
        this.index++
        continue
      }
      if (char === '\\' && this.peek(1) === '\n') {
        this.index += 2
        continue
      }
      if (char === '#') {
        while (this.index < this.source.length && this.peek() !== '\n')
          this.index++
        continue
      }
      if (char === '\n') {
        this.index++
        finish()
        this.hereDocuments()
        continue
      }
      if (end !== undefined && char === end) {
        this.index++
        finish()
        return
      }
      if ((char === '<' || char === '>') && this.peek(1) === '(') {
        const start = this.index
        this.index += 2
        this.list(')')
        const written = this.source.slice(start, this.index)
        words.push({ text: written, pattern: written, dynamic: true })
        continue
      }
      redirection.lastIndex = this.index
      const redirect = redirection.exec(this.source)
      if (redirect !== null) {
        this.redirect(
          redirect[1] ?? redirect[2] ?? '',
          redirect[0].length,
          writes,
        )
        continue
      }
      if (char === '(') {
        // Among a command's words, or against a word, it is no subshell: an extended glob (`@(out)`,
        // zsh's `(out)/x`), which matches what the gate would read as a command. A function's `()`,
        // an array's `=(`, `time (…)` and a `[[ … ]]` test aside.
        const before = this.source[this.index - 1] ?? ' '
        const test: boolean = words[0]?.text === '[[' || testing
        if (
          !test &&
          (words.some(({ text }) => text !== 'time' && text !== '-p') ||
            !breaking.has(before)) &&
          this.peek(1) !== ')' &&
          before !== '='
        )
          throw new Unparsable({
            reason: 'a parenthesis among a command’s words',
          })
        this.index++
        finish()
        this.list(')')
        testing = test
        const after = this.peek()
        if (!test && after !== '' && after !== '`' && !breaking.has(after))
          throw new Unparsable({ reason: 'a parenthesis against a word' })
        continue
      }
      if (char === ';' || char === '&' || char === '|' || char === ')') {
        this.index++
        finish()
        continue
      }
      const word = this.word()
      if (skip === 'rest') {
        this.unnamed.push(word.word)
        continue
      }
      if (skip > 0) {
        this.unnamed.push(word.word)
        skip--
        continue
      }
      if (words.length === 0 && word.plain && reserved.has(word.word.text)) {
        skip = skipped.get(word.word.text) ?? 0
        continue
      }
      words.push(word.word)
    }
    if (end !== undefined)
      throw new Unparsable({
        reason: `a ${end === ')' ? '(' : '`'} doesn't close`,
      })
    finish()
  }

  /** A redirection `operator`, `length` characters long with its file descriptor, and its target. */
  redirect(operator: string, length: number, writes: Array<Word>): void {
    this.index += length
    while (this.peek() === ' ' || this.peek() === '\t') this.index++
    const target = this.word()
    if (operator === '<<' || operator === '<<-') {
      this.pending.push({
        delimiter: target.word.text,
        stripTabs: operator === '<<-',
        expands: target.plain,
      })
      return
    }
    const duplicates =
      (operator === '>&' || operator === '<&') &&
      /^(?:\d+-?|-)$/u.test(target.word.text)
    if (
      !duplicates &&
      (operator.includes('>') || operator === '<>') &&
      operator !== '<&'
    )
      writes.push(target.word)
    else this.unnamed.push(target.word)
  }

  /** Skips the bodies of the here-documents opened on the line just ended. */
  hereDocuments(): void {
    for (const document of this.pending.splice(0)) {
      const start = this.index
      let found = false
      while (this.index < this.source.length) {
        const newline = this.source.indexOf('\n', this.index)
        const lineEnd = newline === -1 ? this.source.length : newline
        const line = this.source.slice(this.index, lineEnd)
        this.index = newline === -1 ? lineEnd : lineEnd + 1
        if (
          (document.stripTabs ? line.replace(/^\t+/u, '') : line) ===
          document.delimiter
        ) {
          found = true
          break
        }
      }
      const body = this.source.slice(start, this.index)
      if (document.expands && (body.includes('$(') || body.includes('`')))
        throw new Unparsable({
          reason: 'a here-document runs commands of its own',
        })
      if (document.expands)
        for (const [text] of body.matchAll(assigningExpansion))
          this.unnamed.push({ text, pattern: text, dynamic: false })
      if (!found) break
    }
  }

  /**
   * The rest of a parameter expansion (`${…}`, up to `}`) or an arithmetic one (`$((…))`, up to `))`),
   * the command substitutions in it read as commands, since the shell runs them. Shells disagree on
   * where quotes inside an expansion end it (bash 3.2 pairs single quotes inside a double-quoted
   * `${…}`; others take them as literal), so a quote there is unparsable rather than guessed at.
   */
  expansion(close: '}' | '))'): void {
    let depth = 0
    while (this.index < this.source.length) {
      const char = this.peek()
      const next = this.peek(1)
      if (char === '\\') this.index += 2
      else if (char === '"' || char === "'")
        throw new Unparsable({
          reason: `a quote inside ${close === '}' ? '${…}' : '$((…))'}, which shells read differently`,
        })
      else if (char === '$' && next === '(' && this.peek(2) === '(') {
        this.index += 3
        this.expansion('))')
      } else if (char === '$' && next === '(') {
        this.index += 2
        this.list(')')
      } else if (char === '$' && next === '{') {
        this.index += 2
        this.expansion('}')
      } else if (char === '`') {
        this.index++
        this.backticks++
        this.list('`')
        this.backticks--
      } else if (close === '}' && char === '}') {
        this.index++
        return
      } else if (close === '))' && char === '(') {
        depth++
        this.index++
      } else if (close === '))' && char === ')') {
        if (depth === 0 && next === ')') {
          this.index += 2
          return
        }
        depth--
        this.index++
      } else this.index++
    }
    throw new Unparsable({
      reason: `a ${close === '}' ? '${' : '$(('} doesn’t close`,
    })
  }

  /** The escape at the reader's backslash inside `$'…'`, read past and decoded as bash decodes it. */
  ansiEscape(): string {
    const next = this.peek(1)
    const simple = ansiEscapes.get(next)
    if (simple !== undefined) {
      this.index += 2
      return String.fromCharCode(simple)
    }
    const digits = (start: number, pattern: RegExp, most: number): string => {
      let found = ''
      while (
        found.length < most &&
        pattern.test(this.peek(start + found.length))
      )
        found += this.peek(start + found.length)
      return found
    }
    if (/[0-7]/u.test(next)) {
      const octal = digits(1, /[0-7]/u, 3)
      this.index += 1 + octal.length
      return String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
    }
    if (next === 'x' && this.peek(2) === '{') {
      const hex = digits(3, /[0-9A-Fa-f]/u, Number.POSITIVE_INFINITY)
      if (hex.length > 0) {
        this.index += 3 + hex.length
        if (this.peek() === '}') this.index++
        return String.fromCharCode(Number.parseInt(hex, 16) & 0xff)
      }
    }
    const hexadecimal = ansiHexadecimals.get(next)
    if (hexadecimal !== undefined) {
      const hex = digits(2, /[0-9A-Fa-f]/u, hexadecimal)
      if (hex.length > 0) {
        this.index += 2 + hex.length
        const code = Number.parseInt(hex, 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
    }
    if (next === 'c' && this.index + 2 < this.source.length) {
      const control = this.peek(2)
      this.index += 3
      return String.fromCharCode(control.toUpperCase().charCodeAt(0) & 0x1f)
    }
    // Any other escape is kept as written, its backslash too.
    this.index += next === '' ? 1 : 2
    return `\\${next}`
  }

  /** A word, and whether it was written plain (no quotes, escapes or substitutions). */
  word(): { readonly word: Word; readonly plain: boolean } {
    let text = ''
    let pattern = ''
    let dynamic = false
    let plain = true
    const literal = (chars: string, quoted: boolean) => {
      text += chars
      for (const char of chars)
        pattern += quoted && special.has(char) ? `\\${char}` : char
    }
    const variable = (written: string, name: string) => {
      plain = false
      if (name === 'HOME' && Option.isSome(this.home))
        literal(this.home.value, true)
      else {
        text += written
        pattern += written
        dynamic = true
      }
    }
    const dollar = (): void => {
      const next = this.peek(1)
      if (next === '(' && this.peek(2) === '(') {
        const start = this.index
        this.index += 3
        this.expansion('))')
        variable(this.source.slice(start, this.index), '')
      } else if (next === '(') {
        const start = this.index
        this.index += 2
        this.list(')')
        variable(this.source.slice(start, this.index), '')
      } else if (next === '{') {
        const start = this.index
        this.index += 2
        this.expansion('}')
        const written = this.source.slice(start, this.index)
        variable(written, written.slice(2, -1))
      } else if (nameStart.test(next)) {
        const start = this.index
        this.index++
        while (nameChar.test(this.peek())) this.index++
        const written = this.source.slice(start, this.index)
        variable(written, written.slice(1))
      } else if (next !== '' && '@*#?$!-0123456789'.includes(next)) {
        variable(this.source.slice(this.index, this.index + 2), '')
        this.index += 2
      } else {
        literal('$', false)
        this.index++
      }
    }
    const backtick = (): void => {
      const start = this.index
      this.index++
      this.backticks++
      this.list('`')
      this.backticks--
      variable(this.source.slice(start, this.index), '')
    }

    while (this.index < this.source.length) {
      const char = this.peek()
      if (breaking.has(char) || (char === '`' && this.backticks > 0)) break
      if (char === '\\') {
        plain = false
        if (this.peek(1) === '\n') this.index += 2
        else {
          literal(this.peek(1), true)
          this.index += 2
        }
      } else if (char === "'") {
        plain = false
        const close = this.source.indexOf("'", this.index + 1)
        if (close === -1) throw new Unparsable({ reason: "a ' doesn’t close" })
        literal(this.source.slice(this.index + 1, close), true)
        this.index = close + 1
      } else if (char === '$' && this.peek(1) === "'") {
        plain = false
        this.index += 2
        let content = ''
        /** A NUL ends the string bash makes, the rest of the quote read and dropped. */
        let ended = false
        while (this.peek() !== "'") {
          if (this.index >= this.source.length)
            throw new Unparsable({ reason: "a $' doesn’t close" })
          // A character code asks, whatever it decodes to: it can spell anything.
          if (this.peek() === '\\' && /[0-7xuU]/u.test(this.peek(1)))
            this.codes = true
          let decoded = this.peek()
          if (decoded === '\\') decoded = this.ansiEscape()
          else this.index++
          if (decoded === String.fromCharCode(0)) ended = true
          if (!ended) content += decoded
        }
        this.index++
        literal(content, true)
      } else if (char === '$' && this.peek(1) === '"') {
        // A locale's translation, its `$` dropped: the string is read as double-quoted.
        plain = false
        this.index++
      } else if (char === '"') {
        plain = false
        this.index++
        while (this.peek() !== '"') {
          if (this.index >= this.source.length)
            throw new Unparsable({ reason: 'a " doesn’t close' })
          const inner = this.peek()
          if (inner === '\\' && '$`"\\\n'.includes(this.peek(1))) {
            if (this.peek(1) !== '\n') literal(this.peek(1), true)
            this.index += 2
          } else if (inner === '$') dollar()
          else if (inner === '`') backtick()
          else {
            literal(inner, true)
            this.index++
          }
        }
        this.index++
      } else if (char === '$') dollar()
      else if (char === '`') backtick()
      else {
        literal(char, false)
        this.index++
      }
    }
    return { word: { text, pattern, dynamic }, plain }
  }
}

/** `source`'s simple commands, or why the gate can't read it; `home` stands for `$HOME` where known. */
export const parseScript = (
  source: string,
  home: Option.Option<string>,
): Script => {
  const reader = new Reader(source, home)
  try {
    reader.list(undefined)
    reader.hereDocuments()
  } catch (error) {
    if (error instanceof Unparsable)
      return Script.Unparsable({ reason: error.reason })
    throw error
  }
  return Script.Parsed({
    commands: reader.commands,
    unnamed: reader.unnamed,
    codes: reader.codes,
  })
}
