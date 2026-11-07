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

/** What an arithmetic expression, or anything bash evaluates as one, reads. */
export interface Rereads {
  /** Variables, whose text bash evaluates in turn. */
  readonly names: ReadonlyArray<string>
  /** A substitution's output or a positional parameter, read as the expression's own text. */
  readonly output: boolean
}

export const readsNothing: Rereads = { names: [], output: false }

/** Commands that print only a number, unless the line redefines them. */
const countingCommands: ReadonlySet<string> = new Set([
  'wc',
  'grep',
  'sysctl',
  'getconf',
  'git',
  'date',
  'nproc',
  'seq',
])

/**
 * A substitution whose output is a number whatever went into it: one pipeline, its last command one of these,
 * what's before it read as any command is. A file's name, which `wc` and `grep -c` print, can't be chosen by
 * a variable or a glob here; `wc <` prints none.
 */
const countingSubstitution =
  /\$\((?:[^()`;&\n|]*\|(?!\|)\s*)*(?:wc\s[^()`|;&\n]*<[^()`|;&\n]*|(?:wc\s|grep -c\s|sysctl -n hw\.|getconf\s|git rev-list --count\s)[^()`|;&\n$*?[]*|date \+%s\s*|nproc(?:\s+2>\/dev\/null)?\s*|seq(?:\s+-?\d+(?:\.\d+)?)+\s*)(?:\|\s*(?:tr -d\s[^()`|;&\n]*|xargs\s*)|\|\|\s*true\s*)?\)/u

/** Whether `text` is such a substitution, whole. */
export const countsOnly = (text: string): boolean => {
  const found = countingSubstitution.exec(text)
  return found?.index === 0 && found[0].length === text.length
}

/** Whether `text` holds a substitution that may print anything. */
const holdsRunning = (text: string): boolean =>
  /\$\(|`/u.test(text.replace(new RegExp(countingSubstitution, 'gu'), '0'))

/** What `expression`, evaluated as arithmetic, reads: a digit's `0x1f` or `16#ff` names nothing. */
export const arithmeticReads = (expression: string): Rereads => {
  const counted = expression.replace(
    new RegExp(countingSubstitution, 'gu'),
    '0',
  )
  return {
    names: [...counted.matchAll(/(?:^|[^\w#])([A-Za-z_]\w*)/gu)].flatMap(
      ([, name]) => name ?? [],
    ),
    output: /\$\(|`|\$\{?[0-9@*]|\$\{!/u.test(counted),
  }
}

export const rereadsEither = (one: Rereads, other: Rereads): Rereads => ({
  names: [...one.names, ...other.names],
  output: one.output || other.output,
})

/** A variable a loop or an array literal sets: to each of its words, or to what the gate can't see. */
export interface LoopValue {
  readonly name: string
  readonly value: Option.Option<Word>
}

export type Script = Data.TaggedEnum<{
  Parsed: {
    readonly commands: ReadonlyArray<SimpleCommand>
    /**
     * Why the line is read with doubt: forms bash may read otherwise than the gate does, so anything in
     * them, or after them, may be something else. What the reader made of it still counts, so a refusal
     * stays one, and each of these asks.
     */
    readonly doubts: ReadonlyArray<string>
    /** A `$'…'` or `$"…"` was read: a POSIX shell that doesn't know them finds their end elsewhere. */
    readonly dollarQuotes: boolean
    /** The words that name no command: a function's name, a loop's variable and list, a case's subject, a read redirection's file, a here-document's assigning expansions. */
    readonly unnamed: ReadonlyArray<Word>
    /** What the line's arithmetic reads again as an expression, where a subscript in that text runs commands. */
    readonly rereads: Rereads
    /** What the line's loops and array literals give their variables. */
    readonly loopValues: ReadonlyArray<LoopValue>
  }
  Unparsable: { readonly reason: string }
}>
export const Script = Data.taggedEnum<Script>()

class Unparsable extends Data.TaggedError('Unparsable')<{
  readonly reason: string
}> {}

/** Words that open or close the shell's compound commands, skipped where a command's name would be. */
const reserved: ReadonlySet<string> = new Set([
  'coproc',
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

const doubtOfCode =
  "a $'…' character code can spell anything, so the gate asks whatever it reads it as"
const doubtOfBacktick =
  'a backtick substitution: bash finds its end and unescapes it before reading it, so its quotes and comments may hide commands'
const doubtOfHereDocument =
  'a here-document opened in a substitution and not closed in it, so the lines after it may be commands'
const doubtOfContinuedDocument =
  'a line continued in a here-document or its delimiter, which bash joins before it looks for the end'
const doubtOfArithmetic =
  'a $(( … )) that closes early, which bash reads as a command substitution'
const doubtOfSubscript =
  'a << or $[ in arithmetic, which opens no here-document though the gate would read one'
const doubtOfSubstitutionEnd =
  'a substitution bash 3.2, macOS’s, would end elsewhere than the gate reads it, for a quote, comment or ) in it'
const doubtOfCoproc =
  'coproc, which runs what follows it in a way the gate doesn’t follow'
const doubtOfCase =
  'a case the gate can’t follow: what it took for patterns ended without their )'
const doubtOfContinuedDollar =
  'a line continued right after a $, which changes how what follows is quoted'
const doubtOfQuotedAssignment =
  'a quoted word that looks like an assignment, which bash runs as a command'
const doubtOfCountingFunction =
  'a function named as a command that prints only a number, which the gate takes it for'
const doubtOfFunctionExpansion =
  'a ${ … } running commands in the shell, which only newer bash does'
const doubtOfPromptExpansion =
  'a ${…@P} expansion, which runs what the text it reads holds'
const doubtOfLocale =
  'a backslash right after a non-ASCII character: in a locale like Shift-JIS it is part of that character and escapes nothing'

/** A `$` then a line continuation: bash joins them into `$'` or `$(`, the gate's reader doesn't. */
const continuedDollar = /\$\\\n/u

/** An assignment's start, in a word as written or as read. */
const assignmentStart = /^[A-Za-z_]\w*(?:\[.*\])?\+?=/su

/** A word naming a subscripted variable, whose subscript bash evaluates: `a[x]=1`, `read a[x]`. */
const subscripted = /^[A-Za-z_]\w*\[(.*)\](?:\+?=.*)?$/su

/** Text of an expanding here-document where bash evaluates a part as arithmetic. */
const documentArithmetic = /\$\[|\$\{[^\n]*(?:\[|!|:[^-=+?])/u

/** `[[`'s operators that evaluate what's beside them, and the one that reads a name's subscript. */
const testNumeric = /(\S+)\s+-(?:eq|ne|lt|le|gt|ge)\s+(\S+)/gu
const testName = /(?:^|\s)-v\s+(\S+)/gu

/** A parameter expansion's text, where bash evaluates a part as arithmetic or reads a name's text as a variable. */
const expansionSubscript = /^[#!]?[A-Za-z_]\w*\[(.*?)\]/su
const expansionIndirect = /^!([A-Za-z_]\w*)(?![@*\w[])/u
const expansionIndirectParameter = /^![0-9@*#]/u
const expansionIndirectElement = /^!([A-Za-z_]\w*)\[(?![@*]\])/u
const expansionSlice =
  /^[A-Za-z_0-9@*#$?!-][\w@*]*(?:\[.*?\])?:(?![-=+?])(.*)$/su

/**
 * Where a grouping ends as bash 3.2 finds it, which is macOS's bash and so Pi's there; -1 where it doesn't.
 * That bash matches the text of a `$(…)` without reading it as commands: it knows quotes, a comment after a
 * blank or line break, `$'…'`, backticks and nested `$(`, not `${` or `$[`, and no here-documents, so its end can differ from
 * the reader's. A line where they differ has commands one reads and the other doesn't.
 */
const matchedEnd = (options: {
  readonly source: string
  readonly from: number
  readonly open: string
  readonly close: string
  /** Inside a command substitution, where a comment hides what it holds. */
  readonly commands?: boolean
  /** A `$'…'`, where a backslash escapes. */
  readonly escapes?: boolean
}): number => {
  const { source, from, open, close } = options
  const commands = options.commands === true
  let count = 1
  let dollar = false
  let comment = false
  for (let at = from; at < source.length; at++) {
    const char = source.charAt(at)
    if (comment) {
      if (char === '\n') comment = false
      continue
    }
    const previous = at === from ? '' : source.charAt(at - 1)
    if (
      commands &&
      char === '#' &&
      at !== from &&
      (previous === '\n' || previous === ' ' || previous === '\t')
    ) {
      comment = true
      continue
    }
    if (char === '\\' && (open !== "'" || options.escapes === true)) {
      at++
      dollar = false
      continue
    }
    if (char === close) count--
    else if (open !== close && char === open && !dollar) count++
    if (count === 0) return at + 1
    if (open === "'") continue
    if (open !== close && (char === "'" || char === '"' || char === '`')) {
      const ends = matchedEnd({
        source,
        from: at + 1,
        open: char,
        close: char,
        escapes: dollar && char === "'",
      })
      if (ends === -1) return -1
      at = ends - 1
    } else if (dollar && char === '(') {
      const ends = matchedEnd({
        source,
        from: at + 1,
        open: '(',
        close: ')',
        commands: true,
      })
      if (ends === -1) return -1
      at = ends - 1
    }
    dollar = char === '$'
  }
  return -1
}

/** Reads `source` from the start; `home` stands for `$HOME`. */
class Reader {
  index = 0
  readonly commands: Array<SimpleCommand> = []
  readonly unnamed: Array<Word> = []
  readonly pending: Array<HereDocument> = []
  /** How many backtick substitutions the reader is inside, where a backtick closes one. */
  backticks = 0
  /** How many command substitutions, or process substitutions, the reader is inside. */
  substitutions = 0
  /** A `$'…'` or `$"…"` was read. */
  dollarQuotes = false
  /** The line's doubts (`Script`), each said once. */
  readonly doubts = new Set<string>()
  rereads = readsNothing
  /** Up to where a `((` already read goes: what's nested in it is part of what was read. */
  arithmeticEnd = 0
  /** Up to where the last `[[` read goes. */
  testEnd = 0
  readonly loopValues: Array<LoopValue> = []

  constructor(
    readonly source: string,
    readonly home: Option.Option<string>,
  ) {}

  peek(offset = 0): string {
    return this.source[this.index + offset] ?? ''
  }

  /** The `((` at the reader is evaluated as arithmetic, up to the `))` that closes it. */
  noteDoubleParenthesis(): void {
    if (this.index < this.arithmeticEnd) return
    let depth = 0
    let at = this.index
    for (; at < this.source.length; at++) {
      const char = this.source.charAt(at)
      if (char === '(') depth++
      else if (char === ')' && --depth === 0) break
    }
    this.arithmeticEnd = at
    this.noteArithmetic(this.source.slice(this.index + 2, at))
  }

  /** The `[[` the reader has just passed evaluates what's beside its numeric tests, wherever in the test. */
  noteTest(): void {
    if (this.index < this.testEnd) return
    let at = this.index
    for (; at < this.source.length; at++) {
      const char = this.source.charAt(at)
      if (char === '\\') at++
      else if (char === "'") {
        const close = this.source.indexOf("'", at + 1)
        at = close === -1 ? this.source.length : close
      } else if (char === '"') {
        for (at++; at < this.source.length; at++) {
          const inner = this.source.charAt(at)
          if (inner === '\\') at++
          else if (inner === '"') break
        }
      } else if (
        char === ']' &&
        this.source.charAt(at + 1) === ']' &&
        /\s/u.test(this.source.charAt(at - 1)) &&
        /^(?:$|[\s;&|)])/u.test(this.source.charAt(at + 2))
      )
        break
    }
    this.testEnd = at
    const test = this.source.slice(this.index, at).replaceAll('\\\n', '')
    let numeric = false
    for (const [, left, right] of test.matchAll(testNumeric)) {
      numeric = true
      this.noteArithmetic(left ?? '')
      this.noteArithmetic(right ?? '')
    }
    // What's beside the test's operators may be several words here: only a substitution matters.
    if (numeric && holdsRunning(test)) this.noteArithmetic('$1')
    for (const [, name] of test.matchAll(testName))
      this.noteArithmetic(name ?? '')
  }

  /** `${` at the reader, its `{` next but one: followed by a blank or `|`, newer bash runs it as commands. */
  noteOpenedExpansion(): void {
    if (/[ \t\n|]/u.test(this.peek(2)))
      this.doubts.add(doubtOfFunctionExpansion)
  }

  /** `expression` is evaluated as arithmetic. */
  noteArithmetic(expression: string): void {
    this.rereads = rereadsEither(this.rereads, arithmeticReads(expression))
  }

  /** `${` `text` `}`: its subscript and slice are arithmetic, and `${!x}` reads `x`'s text as a variable. */
  noteExpansion(text: string): void {
    if (text.endsWith('@P')) this.doubts.add(doubtOfPromptExpansion)
    const subscript = expansionSubscript.exec(text)?.[1]
    if (subscript !== undefined && subscript !== '@' && subscript !== '*')
      this.noteArithmetic(subscript)
    const indirect = expansionIndirect.exec(text)?.[1]
    if (indirect !== undefined) this.noteArithmetic(indirect)
    if (expansionIndirectParameter.test(text)) this.noteArithmetic('$1')
    const element = expansionIndirectElement.exec(text)?.[1]
    if (element !== undefined) this.noteArithmetic(element)
    const slice = expansionSlice.exec(text)?.[1]
    if (slice !== undefined) this.noteArithmetic(slice)
  }

  /** Reads commands until `end` (a closing parenthesis or backtick) or the end of the source. */
  list(end: ')' | '`' | undefined): void {
    let words: Array<Word> = []
    let writes: Array<Word> = []
    /** Words that name no command: a function's name, a loop's variable and list, a case's subject. */
    let skip: number | 'rest' = 0
    /** Here-documents opened before this list began: bash reads their bodies from lines the gate reads as its own. */
    const pendingOutside = this.pending.length
    /** How many `case`s this list is inside, and whether it is at one's patterns, up to their `)`. */
    let cases = 0
    let patterns = false
    /** Words read as patterns since the last `)`: only a `|` or a `)` may follow them, or this misreads it. */
    let patternWords = false
    /** A `[[ … ]]` test's parenthesis ended the words before it: what follows is still the test. */
    let testing = false
    /** The command's words so far are all assignments. */
    let assignmentsOnly = true
    /** The `for` or `select` being read: its variable and what it gets. */
    let loop:
      | {
          name: string | undefined
          listed: boolean
          readonly words: Array<Word>
        }
      | undefined
    const endLoop = () => {
      const { name, listed, words: list } = loop ?? {}
      if (name !== undefined) {
        // With no `in`, it gets the positional parameters.
        if (listed !== true)
          this.loopValues.push({ name, value: Option.none() })
        for (const value of list ?? [])
          this.loopValues.push({ name, value: Option.some(value) })
      }
      loop = undefined
    }
    const finish = () => {
      if (words.length > 0 || writes.length > 0)
        this.commands.push({ words, writes })
      words = []
      writes = []
      skip = 0
      testing = false
      assignmentsOnly = true
      endLoop()
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
        // Bash 3.2 joins a continued line first, so in a substitution the comment runs on over the next.
        if (
          this.substitutions > 0 &&
          this.source.charAt(this.index - 1) === '\\'
        )
          this.doubts.add(doubtOfSubstitutionEnd)
        continue
      }
      if (char === '\n') {
        if (patterns && patternWords) this.doubts.add(doubtOfCase)
        if (end !== undefined && pendingOutside > 0)
          this.doubts.add(doubtOfHereDocument)
        this.index++
        finish()
        this.hereDocuments()
        continue
      }
      if (patterns && char === ')') {
        this.index++
        patterns = false
        patternWords = false
        finish()
        continue
      }
      if (patterns && patternWords && (char === ';' || char === '&'))
        this.doubts.add(doubtOfCase)
      if (patterns && (char === '(' || char === '|')) {
        this.index++
        continue
      }
      if (end !== undefined && char === end) {
        if (patterns && patternWords) this.doubts.add(doubtOfCase)
        this.index++
        finish()
        if (this.pending.length > pendingOutside)
          this.doubts.add(doubtOfHereDocument)
        return
      }
      if ((char === '<' || char === '>') && this.peek(1) === '(') {
        const start = this.index
        this.index += 2
        this.substitution(')')
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
        // `((…))`, a `for`'s too: read as commands below, and evaluated by bash.
        if (this.peek(1) === '(') this.noteDoubleParenthesis()
        // An array literal's values, read below as commands.
        const arrayName = /^([A-Za-z_]\w*)\+?=$/u.exec(
          words.at(-1)?.text ?? '',
        )?.[1]
        if (arrayName !== undefined && this.source[this.index - 1] === '=')
          this.loopValues.push({ name: arrayName, value: Option.none() })
        if (
          this.peek(1) === ')' &&
          countingCommands.has(words.at(-1)?.text ?? '')
        )
          this.doubts.add(doubtOfCountingFunction)
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
        // `;;`, `;&` and `;;&` end a `case`'s branch: its next patterns follow.
        if (
          cases > 0 &&
          char === ';' &&
          (this.peek(1) === ';' || this.peek(1) === '&')
        )
          patterns = true
        this.index++
        finish()
        continue
      }
      const start = this.index
      const word = this.word()
      // A backtick closing nothing here, where one closes further out: the reader would never pass it.
      if (this.index === start)
        throw new Unparsable({ reason: `a ${char} the reader can’t place` })
      // Ahead of what skips a word: `case x in esac` has no patterns, and the line goes on after it.
      if (cases > 0 && word.plain && word.word.text === 'esac') {
        cases--
        patterns = false
        patternWords = false
        finish()
        continue
      }
      if (skip === 'rest') {
        // `for x do …` and `for x { …; }`: with no `in`, the loop's body starts on the same line.
        if (word.plain && (word.word.text === 'do' || word.word.text === '{')) {
          skip = 0
          endLoop()
          continue
        }
        if (loop !== undefined) {
          if (loop.name === undefined) loop.name = word.word.text
          else if (word.plain && word.word.text === 'in') loop.listed = true
          else loop.words.push(word.word)
        }
        this.unnamed.push(word.word)
        continue
      }
      if (skip > 0) {
        // `function wc`, as `wc()` above.
        if (countingCommands.has(word.word.text))
          this.doubts.add(doubtOfCountingFunction)
        this.unnamed.push(word.word)
        skip--
        continue
      }
      if (patterns) {
        this.unnamed.push(word.word)
        patternWords = true
        continue
      }
      if (words.length === 0 && word.plain && word.word.text === 'case') {
        cases++
        patterns = true
      }
      if (words.length === 0 && word.plain && word.word.text === 'coproc')
        this.doubts.add(doubtOfCoproc)
      if (words.length === 0 && word.plain && reserved.has(word.word.text)) {
        skip = skipped.get(word.word.text) ?? 0
        if (word.word.text === 'for' || word.word.text === 'select')
          loop = { name: undefined, listed: false, words: [] }
        continue
      }
      // An array's subscript still open: what follows, a `<<` or a `|` among it, isn't the shell's.
      if (
        words.every(({ text }) =>
          /^(?:\w+(?:\[.*\])?\+?=|time$|-p$)/u.test(text),
        ) &&
        /^[A-Za-z_]\w*\[/u.test(word.word.text) &&
        !/\]\+?=/u.test(word.word.text)
      )
        this.doubts.add(doubtOfSubscript)
      // Where it would name the command: quoted, bash takes it for no assignment.
      if (
        assignmentsOnly &&
        assignmentStart.test(word.word.text) &&
        !assignmentStart.test(
          this.source.slice(start, this.index).replaceAll('\\\n', ''),
        )
      )
        this.doubts.add(doubtOfQuotedAssignment)
      if (assignmentsOnly) {
        const subscript = subscripted.exec(word.word.text)?.[1]
        if (subscript !== undefined) this.noteArithmetic(subscript)
      }
      // An array literal's `[x]=1`.
      const element = /^\[(.+)\]\+?=/su.exec(word.word.text)?.[1]
      if (element !== undefined) this.noteArithmetic(element)
      if (word.plain && word.word.text === '[[') this.noteTest()
      assignmentsOnly &&= assignmentStart.test(word.word.text)
      words.push(word.word)
    }
    if (patterns && patternWords) this.doubts.add(doubtOfCase)
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
    const start = this.index
    const target = this.word()
    if (operator === '<<' || operator === '<<-') {
      const written = this.source.slice(start, this.index)
      if (written.includes('\\\n')) this.doubts.add(doubtOfContinuedDocument)
      this.pending.push({
        delimiter: target.word.text,
        stripTabs: operator === '<<-',
        // Only a quote or an escape in the delimiter keeps the body from expanding: `<<$E` doesn't.
        expands: !/['"\\]/u.test(written),
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
      const raw = this.source.slice(start, this.index)
      // Bash joins continued lines in a body that expands, its last line's with the delimiter too.
      // Bash 3.2 does so in a substitution even where the delimiter is quoted.
      if ((document.expands || this.substitutions > 0) && raw.includes('\\\n'))
        this.doubts.add(doubtOfContinuedDocument)
      if (this.substitutions > 0 && /[^\0-\x7f]\\/u.test(raw))
        this.doubts.add(doubtOfLocale)
      const body = raw.replaceAll('\\\n', '')
      if (document.expands && (body.includes('$(') || body.includes('`')))
        throw new Unparsable({
          reason: 'a here-document runs commands of its own',
        })
      if (document.expands) {
        for (const [text] of body.matchAll(assigningExpansion))
          this.unnamed.push({ text, pattern: text, dynamic: false })
        if (documentArithmetic.test(body)) this.noteArithmetic(body)
      }
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
    const start = this.index
    const read = () => {
      const text = this.source.slice(
        start,
        this.index - (close === '}' ? 1 : 2),
      )
      if (close === '}') this.noteExpansion(text)
      else this.noteArithmetic(text)
    }
    let depth = 0
    while (this.index < this.source.length) {
      const char = this.peek()
      const next = this.peek(1)
      if (char === '\\') {
        this.noteAfterWide()
        this.index += 2
      } else if (char === '"' || char === "'")
        throw new Unparsable({
          reason: `a quote inside ${close === '}' ? '${…}' : '$((…))'}, which shells read differently`,
        })
      else if (char === '$' && next === '(' && this.peek(2) === '(') {
        this.index += 3
        this.expansion('))')
      } else if (char === '$' && next === '(') {
        this.index += 2
        this.substitution(')')
      } else if (char === '$' && next === '{') {
        this.noteOpenedExpansion()
        this.index += 2
        this.expansion('}')
      } else if (char === '`') {
        this.doubts.add(doubtOfBacktick)
        this.index++
        this.backticks++
        this.list('`')
        this.backticks--
      } else if (close === '}' && char === '}') {
        this.index++
        read()
        return
      } else if (close === '))' && char === '(') {
        depth++
        this.index++
      } else if (close === '))' && char === ')') {
        if (depth === 0 && next === ')') {
          this.index += 2
          read()
          return
        }
        // A `)` closing what `$((` opened, alone: bash reads the whole as a command substitution.
        if (depth === 0) this.doubts.add(doubtOfArithmetic)
        depth--
        this.index++
      } else this.index++
    }
    throw new Unparsable({
      reason: `a ${close === '}' ? '${' : '$(('} doesn’t close`,
    })
  }

  /** The list of a command substitution or a process substitution, up to `close`. */
  substitution(close: ')'): void {
    const start = this.index
    // A `#` right after the `$(` is no comment to bash 3.2: what it holds counts there, wherever it ends.
    if (
      this.peek() === '#' &&
      /^[^\n]*['"\\()`]/u.test(this.source.slice(start))
    )
      this.doubts.add(doubtOfSubstitutionEnd)
    this.substitutions++
    this.list(close)
    this.substitutions--
    const ends = matchedEnd({
      source: this.source,
      from: start,
      open: '(',
      close,
      commands: true,
    })
    if (ends !== -1 && ends !== this.index)
      this.doubts.add(doubtOfSubstitutionEnd)
  }

  /** The backslash at the reader may be a byte of the character before it, in a locale the line can set. */
  noteAfterWide(): void {
    if (this.source.charCodeAt(this.index - 1) > 0x7f)
      this.doubts.add(doubtOfLocale)
  }

  /**
   * Where the `$'…'` the reader is inside closes, as bash finds it: a backslash skips the next character,
   * and only then is what lies between decoded, so no escape's reading can move the end of the string.
   */
  ansiClose(): number {
    let at = this.index
    while (at < this.source.length && this.source.charAt(at) !== "'")
      at += this.source.charAt(at) === '\\' ? 2 : 1
    if (at >= this.source.length)
      throw new Unparsable({ reason: "a $' doesn’t close" })
    return at
  }

  /** The escape at the reader's backslash inside `$'…'`, read past and decoded as bash decodes it, up to `close`. */
  ansiEscape(close: number): string {
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
    // `\c` at the end of the string stands for itself; a backslash after it takes a second one along, as
    // bash 5 reads it. Bash 3.2 reads both apart, so any `\c` is doubted either way.
    if (next === 'c' && this.index + 2 < close) {
      const control = this.peek(2)
      this.index += control === '\\' && this.peek(3) === '\\' ? 4 : 3
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
        this.substitution(')')
        variable(this.source.slice(start, this.index), '')
      } else if (next === '[') {
        // `$[…]`, old arithmetic: a `<<` in it opens no here-document, as the reader would have it.
        this.doubts.add(doubtOfSubscript)
        literal('$', false)
        this.index++
      } else if (next === '{') {
        this.noteOpenedExpansion()
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
      this.doubts.add(doubtOfBacktick)
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
        this.noteAfterWide()
        // A continued line is nothing: `i\<newline>f` is the word `if`, reserved as it is.
        if (this.peek(1) === '\n') this.index += 2
        else {
          plain = false
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
        this.dollarQuotes = true
        this.index += 2
        let content = ''
        /** A NUL ends the string bash makes, the rest of the quote read and dropped. */
        let ended = false
        const close = this.ansiClose()
        while (this.index < close) {
          // A character code asks, whatever it decodes to: it can spell anything. So does any `\c`, which
          // versions of bash read apart: a backslash after it starts another escape in 3.2, macOS's, and at
          // the end of the string 3.2 leaves a lone backslash, which escapes what follows in an `eval`.
          if (this.peek() === '\\' && /[0-7xuUc]/u.test(this.peek(1)))
            this.doubts.add(doubtOfCode)
          let decoded = this.peek()
          if (decoded === '\\') {
            this.noteAfterWide()
            decoded = this.ansiEscape(close)
          } else this.index++
          if (decoded === String.fromCharCode(0)) ended = true
          if (!ended) content += decoded
        }
        this.index = close + 1
        literal(content, true)
      } else if (char === '$' && this.peek(1) === '"') {
        // A locale's translation, its `$` dropped: the string is read as double-quoted.
        plain = false
        this.dollarQuotes = true
        this.index++
      } else if (char === '"') {
        plain = false
        this.index++
        while (this.peek() !== '"') {
          if (this.index >= this.source.length)
            throw new Unparsable({ reason: 'a " doesn’t close' })
          const inner = this.peek()
          if (inner === '\\' && '$`"\\\n'.includes(this.peek(1))) {
            this.noteAfterWide()
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
  if (continuedDollar.test(source)) reader.doubts.add(doubtOfContinuedDollar)
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
    doubts: [...reader.doubts],
    dollarQuotes: reader.dollarQuotes,
    rereads: reader.rereads,
    loopValues: reader.loopValues,
  })
}
