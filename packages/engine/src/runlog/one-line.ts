// The human log keeps one line per write (spec §7.5): ticket titles, reasons and a model's words go
// into its lines, so a line break, an escape sequence or a bidi control among them would start a line
// of its own or rewrite what a terminal shows of the log. Each such character is written as an escape
// instead: C0 controls (a tab, a newline, ESC), DEL, C1 controls, the line and paragraph separators,
// and the bidi marks, overrides and isolates. The terminal's sanitiser is the CLI's (§19).

const named: ReadonlyMap<number, string> = new Map([
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0d, '\\r'],
])

/** Whether the log writes the code point `point` as an escape. */
const isUnsafe = (point: number): boolean =>
  point < 0x20 ||
  (point >= 0x7f && point <= 0x9f) ||
  point === 0x061c ||
  point === 0x200e ||
  point === 0x200f ||
  point === 0x2028 ||
  point === 0x2029 ||
  (point >= 0x202a && point <= 0x202e) ||
  (point >= 0x2066 && point <= 0x2069)

const escape = (point: number): string =>
  named.get(point) ?? `\\u${point.toString(16).padStart(4, '0')}`

/** `text` as one line of the log, each control, separator and bidi mark in it written as an escape. */
export const oneLine = (text: string): string => {
  let line = ''
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    line += isUnsafe(point) ? escape(point) : character
  }
  return line
}
