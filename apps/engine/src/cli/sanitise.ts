import type { Console } from 'effect'
import { inspect } from 'node:util'

// What the CLI prints is sanitised for the terminal (spec §19), `--json` included, since ticket titles,
// IDs and tool inputs come from agents: a character that could move the cursor, recolour or retitle the
// terminal, reorder what is shown or break a line where none is seen is shown as its `\uXXXX` escape.
// Those are the C0 controls (an escape sequence's ESC among them, so the sequence shows as text), DEL,
// the C1 controls, the bidi embeddings, overrides and isolates, and the line and paragraph separators.
// JSON's own escapes take that form, so `--json` output stays JSON and parses to what the engine sent.
// The CLI's console (`sanitisingConsole`) sanitises everything printed through it.

const tab = 0x09
const newline = 0x0a

/** Whether the character at `code` is shown as its escape; `lines` keeps tabs and newlines as they are. */
const shownEscaped = (code: number, lines: boolean): boolean =>
  (code <= 0x1f && !(lines && (code === tab || code === newline))) ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0x2028 ||
  code === 0x2029

const escaped = (code: number): string =>
  `\\u${code.toString(16).padStart(4, '0')}`

const sanitiseWith = (text: string, lines: boolean): string => {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += shownEscaped(code, lines) ? escaped(code) : char
  }
  return out
}

/** Text for the terminal: tabs and newlines kept, every other character that could act on it escaped. */
export const sanitise = (text: string): string => sanitiseWith(text, true)

/** One value on one line: tabs and newlines escaped too, so a value can't pass for lines of its own. */
export const sanitiseLine = (text: string): string => sanitiseWith(text, false)

const sanitiseArgs = (args: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  args.map(arg => sanitise(typeof arg === 'string' ? arg : inspect(arg)))

const sanitiseLabel = (label: string | undefined): string | undefined =>
  label === undefined ? undefined : sanitiseLine(label)

/** A console that prints through `inner`, everything it is given sanitised. */
export const sanitisingConsole = (inner: Console.Console): Console.Console => ({
  assert: (condition, ...args) =>
    inner.assert(condition, ...sanitiseArgs(args)),
  clear: () => inner.clear(),
  count: label => inner.count(sanitiseLabel(label)),
  countReset: label => inner.countReset(sanitiseLabel(label)),
  debug: (...args) => inner.debug(...sanitiseArgs(args)),
  dir: item => inner.log(...sanitiseArgs([item])),
  dirxml: (...args) => inner.dirxml(...sanitiseArgs(args)),
  error: (...args) => inner.error(...sanitiseArgs(args)),
  group: (...args) => inner.group(...sanitiseArgs(args)),
  groupCollapsed: (...args) => inner.groupCollapsed(...sanitiseArgs(args)),
  groupEnd: () => inner.groupEnd(),
  info: (...args) => inner.info(...sanitiseArgs(args)),
  log: (...args) => inner.log(...sanitiseArgs(args)),
  table: tabularData => inner.log(...sanitiseArgs([tabularData])),
  time: label => inner.time(sanitiseLabel(label)),
  timeEnd: label => inner.timeEnd(sanitiseLabel(label)),
  timeLog: (label, ...args) =>
    inner.timeLog(sanitiseLabel(label), ...sanitiseArgs(args)),
  trace: (...args) => inner.trace(...sanitiseArgs(args)),
  warn: (...args) => inner.warn(...sanitiseArgs(args)),
})
