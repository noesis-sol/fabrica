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
  /** Its escaped form: a quoted or escaped `\ { } * ? [ ] , ~` behind a backslash. */
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
  Parsed: { readonly commands: ReadonlyArray<SimpleCommand> }
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

const special = new Set(['\\', '{', '}', '*', '?', '[', ']', ',', '~'])
const breaking = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const nameStart = /[A-Za-z_]/u
const nameChar = /[A-Za-z0-9_]/u
const redirection =
  /(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)|(&>>|&>)/uy

interface HereDocument {
  readonly delimiter: string
  readonly stripTabs: boolean
  readonly expands: boolean
}

/** Reads `source` from the start; `home` stands for `$HOME`. */
class Reader {
  index = 0
  readonly commands: Array<SimpleCommand> = []
  readonly pending: Array<HereDocument> = []
  /** How many backtick substitutions the reader is inside, where a backtick closes one. */
  backticks = 0

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
    const finish = () => {
      if (words.length > 0 || writes.length > 0)
        this.commands.push({ words, writes })
      words = []
      writes = []
      skip = 0
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
        this.index++
        finish()
        this.list(')')
        continue
      }
      if (char === ';' || char === '&' || char === '|' || char === ')') {
        this.index++
        finish()
        continue
      }
      const word = this.word()
      if (skip === 'rest') continue
      if (skip > 0) {
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
      if (!found) break
    }
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
        let depth = 2
        while (depth > 0) {
          if (this.index >= this.source.length)
            throw new Unparsable({ reason: 'a $(( doesn’t close' })
          const char = this.peek()
          if (char === '(') depth++
          else if (char === ')') depth--
          this.index++
        }
        variable(this.source.slice(start, this.index), '')
      } else if (next === '(') {
        const start = this.index
        this.index += 2
        this.list(')')
        variable(this.source.slice(start, this.index), '')
      } else if (next === '{') {
        const close = this.source.indexOf('}', this.index + 2)
        if (close === -1) throw new Unparsable({ reason: 'a ${ doesn’t close' })
        const written = this.source.slice(this.index, close + 1)
        this.index = close + 1
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
        while (this.peek() !== "'") {
          if (this.index >= this.source.length)
            throw new Unparsable({ reason: "a $' doesn’t close" })
          if (this.peek() === '\\') {
            content += this.peek(1)
            this.index += 2
          } else {
            content += this.peek()
            this.index++
          }
        }
        this.index++
        literal(content, true)
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
  return Script.Parsed({ commands: reader.commands })
}
