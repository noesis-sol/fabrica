import { Effect, Option } from 'effect'

import {
  GateCounts,
  GateReason,
  type ProjectId,
  type RunId,
  TicketId,
} from '@fabrica/contracts'

import { gateVerdictColumn } from './rows'
import { Telemetry } from './service'
import { TelemetryStore } from './store'

// The gate's decisions counted per ticket (spec §12.6), for the reviewer and the Review screen: read
// from the telemetry store itself, so they don't wait on DuckDB, which a host may be unable to load.
// Every row recorded before the read is counted.

/** Whose decisions: the project's, narrowed to a ticket or a run where one is named. */
export interface GateScope {
  readonly project: ProjectId
  readonly ticket: Option.Option<TicketId>
  readonly run: Option.Option<RunId>
}

interface GateRow {
  readonly ticket: string
  readonly verdict: 'allowed' | 'asked' | 'refused'
  readonly reason: string | null
  readonly decisions: number
}

/** The rows, in the ticket's order, as a ticket's counts each. */
const countsOf = (rows: ReadonlyArray<GateRow>): ReadonlyArray<GateCounts> => {
  const tickets = new Map<string, ReadonlyArray<GateRow>>()
  for (const row of rows)
    tickets.set(row.ticket, [...(tickets.get(row.ticket) ?? []), row])
  return [...tickets].flatMap(([ticket, own]) =>
    Option.match(TicketId.makeOption(ticket), {
      onNone: () => [],
      onSome: id => {
        const total = (verdict: GateRow['verdict']) =>
          own
            .filter(row => row.verdict === verdict)
            .reduce((sum, row) => sum + row.decisions, 0)
        return [
          new GateCounts({
            ticket: id,
            allowed: total('allowed'),
            asked: total('asked'),
            refused: total('refused'),
            reasons: own.flatMap(({ verdict, reason, decisions }) =>
              verdict === 'allowed' || reason === null
                ? []
                : [new GateReason({ verdict, reason, count: decisions })],
            ),
          }),
        ]
      },
    }),
  )
}

/** The gate's decisions per ticket in `scope`, tickets in order, each one's reasons most given first. */
export const readGateCounts = Effect.fn('Telemetry.readGateCounts')(function* ({
  project,
  ticket,
  run,
}: GateScope) {
  const telemetry = yield* Telemetry
  const sql = yield* TelemetryStore
  yield* telemetry.flush
  const named = Option.getOrNull(ticket)
  const going = Option.getOrNull(run)
  const rows = yield* sql.unsafe<GateRow>(
    `SELECT ticket, ${gateVerdictColumn} AS verdict, reason, count(*) AS decisions
    FROM tool_calls
    WHERE project = ? AND ticket IS NOT NULL
      AND (? IS NULL OR ticket = ?) AND (? IS NULL OR run = ?)
    GROUP BY 1, 2, 3 ORDER BY ticket, decisions DESC, reason`,
    [project, named, named, going, going],
  )
  return countsOf(rows)
})
