import { Duration, Option } from 'effect'

import type {
  CommitHash,
  HoldKind,
  LocalTime,
  TicketId,
} from '@fabrica/contracts'

import { BatteryNotice } from '../time'

// The human log's lines (spec §7.5), in orchestra's formats: each dated as orchestra dates them
// (`2026-10-29 10:15:00 +0200`, the UTC offset making the hour a clock change repeats read in order),
// then the text. A run-level line starts at the margin (`HOLD: …`, `SLEPT: …`); a line about one
// ticket is indented two spaces and names the ticket by its ID. A record's `text` is its line as the
// log has it, without the time (orchestra's `docs/events.md`), so these build both.

/** How the log dates a line: `time`, a record's, as orchestra writes it (`2026-10-29 10:15:00 +0200`). */
export const logStamp = (time: LocalTime): string =>
  `${time.slice(0, 10)} ${time.slice(11, 19)} ${time.slice(23, 26)}${time.slice(27, 29)}`

/** The time of day `time` names, to the minute: `14:03`. */
export const clockOf = (time: LocalTime): string => time.slice(11, 16)

/** A commit as the log names it: its first 7 digits. */
export const shortCommit = (commit: CommitHash): string => commit.slice(0, 7)

/** A ticket's line: indented under the run's. */
const ticketLine = (text: string): string => `  ${text}`

/** `n/limit`, or `n` for a run without a limit: the `[3/10]` a dispatch line starts with. */
export const progress = (n: number, limit: Option.Option<number>): string =>
  Option.match(limit, {
    onNone: () => String(n),
    onSome: most => `${n}/${most}`,
  })

/** `[3/10] fa-a1b2 dispatching: <title>`, or `dispatching solo` for a ticket labelled solo. */
export const dispatchingLine = (dispatch: {
  readonly n: number
  readonly limit: Option.Option<number>
  readonly ticket: TicketId
  readonly title: string
  readonly solo: boolean
}): string =>
  `[${progress(dispatch.n, dispatch.limit)}] ${dispatch.ticket} ${dispatch.solo ? 'dispatching solo' : 'dispatching'}: ${dispatch.title}`

/** `  fa-a1b2 footprint: Loop.merge, src/run/loop.ts`, under its dispatch line (§13.4). */
export const footprintLine = (footprint: {
  readonly ticket: TicketId
  /** What it edits, as the footprint names each: functions, files, globs, then areas. */
  readonly parts: ReadonlyArray<string>
}): string =>
  ticketLine(`${footprint.ticket} footprint: ${footprint.parts.join(', ')}`)

/** `  fa-a1b2 settled: <how>`: how its worker's turn left the ticket. */
export const settledLine = (settled: {
  readonly ticket: TicketId
  readonly how: string
}): string => ticketLine(`${settled.ticket} settled: ${settled.how}`)

/** `  fa-a1b2 closed (ffd6ce4 <subject>); merged into main, worktree and branch removed`. */
export const mergedLine = (merged: {
  readonly ticket: TicketId
  readonly commit: CommitHash
  /** The commit's subject. */
  readonly subject: string
  readonly base: string
}): string =>
  ticketLine(
    `${merged.ticket} closed (${shortCommit(merged.commit)} ${merged.subject}); merged into ${merged.base}, worktree and branch removed`,
  )

/**
 * `HOLD: USAGE_LIMIT: <why>`, and `; no new tickets while the 3 running finish` while tickets run:
 * the run takes no new tickets (§14).
 */
export const holdLine = (hold: {
  readonly hold: HoldKind
  readonly why: string
  /** How many tickets are running. */
  readonly running: number
}): string =>
  hold.running === 0
    ? `HOLD: ${hold.hold}: ${hold.why}`
    : `HOLD: ${hold.hold}: ${hold.why}; no new tickets while the ${hold.running} running finish`

/** `USAGE_LIMIT lifted: <why>`: the hold ends, and tickets start again. */
export const holdLiftedLine = (lifted: {
  readonly hold: HoldKind
  readonly why: string
}): string => `${lifted.hold} lifted: ${lifted.why}`

/**
 * A warning, its tag the word scripts and people search for (`CHECKS_FAILED`, `LIKELY_CONFLICT`, …):
 * `  CHECKS_FAILED: <text>` about a ticket, indented, or `README_STALE: <text>` about the run.
 */
export const warningLine = (warning: {
  readonly tag: string
  readonly about: 'ticket' | 'run'
  readonly text: string
}): string => {
  const line = `${warning.tag}: ${warning.text}`
  return warning.about === 'ticket' ? ticketLine(line) : line
}

/** How long a span is, as the log says it: `42s` under a minute, `34m` under an hour, else `2h05m`. */
export const spanText = (span: Duration.Duration): string => {
  const seconds = Math.max(1, Math.round(Duration.toSeconds(span)))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * What the run says of the battery (§7.7): `LID_SLEEPS: …` and `BATTERY: on battery at 85%` as it
 * starts, `BATTERY: 19% and discharging; …` at a threshold.
 */
export const batteryLine: (notice: BatteryNotice) => string =
  BatteryNotice.$match({
    LidSleeps: () =>
      warningLine({
        tag: 'LID_SLEEPS',
        about: 'run',
        text: 'keeping awake prevents idle sleep only: a closed lid still sleeps this host on battery or without an external display',
      }),
    OnBattery: ({ level }) => `BATTERY: on battery at ${level}%`,
    Low: ({ level }) =>
      `BATTERY: ${level}% and discharging; plug the host in before it sleeps`,
  })

/** `SLEPT: the host slept 34m (14:03–14:37, lid closed); limits don't count it` (§7.7). */
export const sleptLine = (slept: {
  readonly from: LocalTime
  readonly to: LocalTime
  readonly span: Duration.Duration
  readonly cause: Option.Option<string>
}): string => {
  const cause = Option.match(slept.cause, {
    onNone: () => '',
    onSome: said => `, ${said}`,
  })
  return `SLEPT: the host slept ${spanText(slept.span)} (${clockOf(slept.from)}–${clockOf(slept.to)}${cause}); limits don't count it`
}
