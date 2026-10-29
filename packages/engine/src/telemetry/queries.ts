import { Array, DateTime, Effect, Option } from 'effect'
import { constants } from 'node:fs'
import { readdir } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  type ColumnUnit,
  InsightsColumn,
  InsightsQuery,
  InsightsSummary,
  InsightsTable,
  ModelName,
  type ProjectId,
  type Tokens,
} from '@fabrica/contracts'

import { sessionsFolder } from '../agent/launch'
import {
  checkFolders,
  closeQuietly,
  openRegular,
  resolveLocation,
} from '../files/open'
import { eventsPath } from '../runlog/run-log'
import {
  type Parameter,
  type ResultRow,
  TelemetryDb,
  type Value,
} from './duckdb'

// The named queries (spec §21, §18.4): each a statement over the recorded rows' copies in DuckDB, the
// projects' event streams and Pi's session files, the last two read where they lie. No SQL comes from
// a client: a query is named, with its parameters, and answers a table of named columns. The event
// stream gives what a run saw (phases, questions, checks with their commits and output, merges, each
// turn's tokens and cost); Pi's session files give every model call of a ticket's sessions; the
// recorded rows give checks, holds, merges, hand-backs, the gate's asks and worker sessions. A file is
// read only where it is a regular file in real folders: a link planted in a checkout's `.fabrica/` is
// passed over (§20.2, H62). DuckDB reserves `at`, so the rows' time column is written `"at"`.

/** A project's event stream: its checkout's `events.jsonl`. */
export interface EventSource {
  readonly project: ProjectId
  readonly file: string
}

/** One of Pi's session files, of a ticket's sessions. */
export interface SessionSource {
  readonly project: ProjectId
  readonly ticket: string
  readonly file: string
}

/** The files a query reads in place. */
export interface Sources {
  readonly events: ReadonlyArray<EventSource>
  readonly sessions: ReadonlyArray<SessionSource>
}

/** The checkout's event stream, where it is a regular file in real folders. */
export const findEventStream = Effect.fn('Insights.findEventStream')(function* (
  checkout: string,
) {
  const found = yield* Effect.gen(function* () {
    const { full, folders } = yield* resolveLocation({
      root: checkout,
      path: eventsPath,
    })
    yield* checkFolders(folders, false)
    const { handle } = yield* openRegular(full, constants.O_RDONLY)
    yield* closeQuietly(handle)
    return full
  }).pipe(Effect.option)
  return found
})

/** The regular files directly in `folder` that pass `keep`, or its real folders; none where it can't be read. */
const entriesOf = (
  folder: string,
  kind: 'file' | 'folder',
  keep: (name: string) => boolean = () => true,
) =>
  Effect.tryPromise(() => readdir(folder, { withFileTypes: true })).pipe(
    Effect.map(entries =>
      entries
        .filter(entry =>
          kind === 'file' ? entry.isFile() : entry.isDirectory(),
        )
        .map(({ name }) => name)
        .filter(keep)
        .toSorted(),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  )

/** Pi's session files of each of the project's tickets: `<data>/projects/<id>/sessions/<ticket>/*.jsonl`. */
export const findSessionFiles = Effect.fn('Insights.findSessionFiles')(
  function* (options: { readonly data: string; readonly project: ProjectId }) {
    const sessions = sessionsFolder(options)
    const checked = yield* checkFolders(
      [NodePath.dirname(sessions), sessions],
      false,
    ).pipe(Effect.option)
    if (Option.isNone(checked)) return []
    const tickets = yield* entriesOf(sessions, 'folder')
    const found = yield* Effect.forEach(tickets, ticket =>
      entriesOf(NodePath.join(sessions, ticket), 'file', name =>
        name.endsWith('.jsonl'),
      ).pipe(
        Effect.map(files =>
          files.map((file): SessionSource => ({
            project: options.project,
            ticket,
            file: NodePath.join(sessions, ticket, file),
          })),
        ),
      ),
    )
    return found.flat()
  },
)

/** The event stream's fields the queries read, with their types; a record without one has it NULL. */
const eventColumns: ReadonlyArray<readonly [string, string]> = [
  ['v', 'INTEGER'],
  ['time', 'VARCHAR'],
  ['run', 'VARCHAR'],
  ['kind', 'VARCHAR'],
  ['ticket', 'VARCHAR'],
  ['suite', 'VARCHAR'],
  ['command', 'VARCHAR'],
  ['commit', 'VARCHAR'],
  ['seconds', 'DOUBLE'],
  ['result', 'VARCHAR'],
  ['output', 'VARCHAR'],
  ['phases', 'JSON'],
  ['hand_backs', 'JSON'],
  ['tokens', 'JSON'],
  ['cost_usd', 'DOUBLE'],
  ['outcome', 'VARCHAR'],
  ['model', 'VARCHAR'],
]

/** A session file's fields the queries read: an entry's type and time, a message, a usage entry's own. */
const sessionColumns: ReadonlyArray<readonly [string, string]> = [
  ['type', 'VARCHAR'],
  ['timestamp', 'VARCHAR'],
  ['message', 'JSON'],
  ['provider', 'VARCHAR'],
  ['model', 'VARCHAR'],
  ['usage', 'JSON'],
]

const columnsSpec = (columns: ReadonlyArray<readonly [string, string]>) =>
  `{${columns.map(([name, type]) => `${name}: '${type}'`).join(', ')}}`

/** No rows, with `columns` and those added to them, for a source with no files. */
const noRows = (columns: ReadonlyArray<readonly [string, string]>) =>
  `SELECT ${columns.map(([name, type]) => `NULL::${type} AS ${name}`).join(', ')} WHERE false`

const readJson = (
  files: string,
  columns: ReadonlyArray<readonly [string, string]>,
) =>
  `read_json(${files}, format = 'newline_delimited', ignore_errors = true, filename = true, columns = ${columnsSpec(columns)})`

/** A statement's opening: the query's parameters, and the event stream's records and the sessions' model calls as tables. */
interface Preamble {
  readonly text: string
  readonly parameters: Readonly<Record<string, Parameter>>
}

const preambleOf = (sources: Sources): Preamble => {
  const events =
    sources.events.length === 0
      ? `SELECT *, NULL::VARCHAR AS project, NULL::BIGINT AS "at" FROM (${noRows(eventColumns)})`
      : `SELECT e.* EXCLUDE (filename), f.project, epoch_ms(CAST(e.time AS TIMESTAMPTZ)) AS "at"
         FROM ${readJson('$event_files', eventColumns)} e
         JOIN (SELECT unnest($event_files) AS file, unnest($event_projects) AS project) f
           ON e.filename = f.file
         WHERE e.v = 1 AND e.kind IS NOT NULL`
  const entries =
    sources.sessions.length === 0
      ? `SELECT *, NULL::VARCHAR AS project, NULL::VARCHAR AS ticket FROM (${noRows(sessionColumns)})`
      : `SELECT s.* EXCLUDE (filename), f.project, f.ticket
         FROM ${readJson('$session_files', sessionColumns)} s
         JOIN (SELECT unnest($session_files) AS file, unnest($session_projects) AS project,
                 unnest($session_tickets) AS ticket) f
           ON s.filename = f.file`
  const text = `WITH events AS (${events}),
    session_entries AS (${entries}),
    session_calls AS (
      SELECT project, ticket, epoch_ms(CAST(timestamp AS TIMESTAMPTZ)) AS "at",
        coalesce(json_extract_string(message, '$.model'), model) AS model,
        coalesce(json_extract(message, '$.usage'), usage) AS u
      FROM session_entries
      WHERE (type = 'message' AND json_extract_string(message, '$.role') = 'assistant')
        OR type = 'usage'
    ),
    sessions AS (
      SELECT project, ticket, "at", model,
        coalesce(json_extract_string(u, '$.input')::BIGINT, 0) AS input,
        coalesce(json_extract_string(u, '$.output')::BIGINT, 0) AS output,
        coalesce(json_extract_string(u, '$.cacheWrite')::BIGINT, 0) AS cache_write,
        coalesce(json_extract_string(u, '$.cacheRead')::BIGINT, 0) AS cache_read,
        json_extract_string(u, '$.cost.total')::DOUBLE AS cost
      FROM session_calls WHERE model IS NOT NULL AND u IS NOT NULL
    )`
  return {
    text,
    parameters: {
      ...(sources.events.length === 0
        ? {}
        : {
            event_files: sources.events.map(({ file }) => file),
            event_projects: sources.events.map(({ project }) => project),
          }),
      ...(sources.sessions.length === 0
        ? {}
        : {
            session_files: sources.sessions.map(({ file }) => file),
            session_projects: sources.sessions.map(({ project }) => project),
            session_tickets: sources.sessions.map(({ ticket }) => ticket),
          }),
    },
  }
}

/** The filter of the recorded rows by project and time, `alias` the table's. */
const recorded = (alias = '') =>
  `($project IS NULL OR ${alias}project = $project) AND ${alias}"at" >= $since`

/** A named query's statement: its columns, in order, and the body after the preamble's tables. */
interface Statement {
  readonly columns: Array.NonEmptyReadonlyArray<readonly [string, ColumnUnit]>
  readonly body: string
  readonly parameters?: Readonly<Record<string, Parameter>>
}

/** Questions asked in the streams, each with when it was answered; NULL while it waits. */
const asks = (filter: string) => `asks AS (
    SELECT a.project, a.run, a.ticket, a."at" AS asked,
      (SELECT min(b."at") FROM events b
        WHERE b.kind IN ('answered', 'auto_answered') AND b.project = a.project
          AND b.ticket = a.ticket AND b."at" >= a."at") AS answered
    FROM events a WHERE a.kind = 'asked' AND ${filter}
  )`

const ticketTime = (
  query: InsightsQuery & { readonly _tag: 'ticket_time' },
): Statement => {
  /** The ticket's and the run's rows, where the query names them; `alias` the table's. */
  const of = (alias = '') =>
    `($ticket IS NULL OR ${alias}ticket = $ticket) AND ($run IS NULL OR ${alias}run = $run)`
  const which = of()
  return {
    columns: [
      ['run', 'text'],
      ['ticket', 'text'],
      ['part', 'text'],
      ['millis', 'millis'],
      ['count', 'count'],
    ],
    body: `,
    ends AS (
      SELECT run, ticket, arg_max(phases, "at") AS phases, arg_max(hand_backs, "at") AS hand_backs,
        max(seconds) AS seconds
      FROM events WHERE kind = 'ticket_end' AND project = $project AND ${which}
      GROUP BY run, ticket
    ),
    ${asks(`a.project = $project AND ${of('a.')}`)},
    parts AS (
      SELECT run, ticket, 'total' AS part, seconds * 1000 AS millis, NULL::BIGINT AS count FROM ends
      UNION ALL
      SELECT run, ticket, 'phase:' || key, json_extract(phases, '$.' || key)::DOUBLE * 1000, NULL
      FROM ends, unnest(json_keys(phases)) AS k(key) WHERE phases IS NOT NULL
      UNION ALL
      SELECT run, ticket, 'check:' || suite, sum(seconds) * 1000, count(*)
      FROM events WHERE kind = 'check' AND project = $project AND ticket IS NOT NULL AND ${which}
      GROUP BY run, ticket, suite
      UNION ALL
      SELECT run, ticket, 'question', sum(answered - asked), count(*) FROM asks GROUP BY run, ticket
      UNION ALL
      SELECT run, ticket, 'hand_back:' || key, NULL, json_extract(hand_backs, '$.' || key)::BIGINT
      FROM ends, unnest(json_keys(hand_backs)) AS k(key) WHERE hand_backs IS NOT NULL
      UNION ALL
      SELECT run, ticket, 'hold:' || hold, sum(duration_ms), count(*)
      FROM holds WHERE project = $project AND ticket IS NOT NULL AND "at" >= $since AND ${which}
      GROUP BY run, ticket, hold
    )
    SELECT run, ticket, part, round(millis) AS millis, count FROM parts
    ORDER BY run, ticket, part`,
    parameters: {
      ticket: Option.getOrNull(query.ticket),
      run: Option.getOrNull(query.run),
    },
  }
}

const waits: Statement = {
  columns: [
    ['wait', 'text'],
    ['asked', 'count'],
    ['median', 'millis'],
    ['longest', 'millis'],
    ['waiting', 'count'],
  ],
  body: `,
    ${asks('a.at >= $since')},
    parts AS (
      SELECT 'question' AS wait, count(*) AS asked, median(answered - asked) AS median,
        max(answered - asked) AS longest, count(*) FILTER (WHERE answered IS NULL) AS waiting
      FROM asks
      UNION ALL
      SELECT 'permission', count(*), median(duration_ms), max(duration_ms), 0
      FROM tool_calls WHERE asked = 1 AND ${recorded()}
    )
    SELECT * FROM parts ORDER BY wait`,
}

const checkDurations = (
  query: InsightsQuery & { readonly _tag: 'check_durations' },
): Statement => ({
  columns: [
    ['suite', 'text'],
    ['checks', 'count'],
    ['failed', 'count'],
    ['median', 'millis'],
    ['p90', 'millis'],
    ['longest', 'millis'],
  ],
  body: `
    SELECT suite, count(*) AS checks,
      count(*) FILTER (WHERE result IN ('failed', 'timed_out')) AS failed,
      median(duration_ms) AS median, quantile_cont(duration_ms, 0.9) AS p90,
      max(duration_ms) AS longest
    FROM checks WHERE ${recorded()} AND ($suite IS NULL OR suite = $suite)
    GROUP BY suite ORDER BY suite`,
  parameters: { suite: Option.getOrNull(query.suite) },
})

// A test is flaky where the test runner said so (`FLAKY: <test>` in a check's output, as Fabrica's
// own runner prints it), or where one check command failed and passed on the same commit.
const flakyTests: Statement = {
  columns: [
    ['test', 'text'],
    ['times', 'count'],
    ['last', 'time'],
  ],
  body: `,
    flagged AS (
      SELECT trim(unnest(regexp_extract_all(output, 'FLAKY: ([^\\n]+)', 1))) AS test, "at"
      FROM events WHERE kind = 'check' AND output IS NOT NULL AND "at" >= $since
    ),
    same_tree AS (
      SELECT command AS test, max("at") AS "at" FROM events
      WHERE kind = 'check' AND commit IS NOT NULL AND command IS NOT NULL AND "at" >= $since
      GROUP BY project, suite, command, commit
      HAVING bool_or(result = 'failed') AND bool_or(result = 'passed')
    )
    SELECT test, count(*) AS times, max("at") AS last
    FROM (SELECT test, "at" FROM flagged UNION ALL SELECT test, "at" FROM same_tree)
    GROUP BY test ORDER BY times DESC, test`,
}

// A run's cost is its turns' (each turn's share of its session's totals), or its end record's where
// its turns carry none.
const costPerMergedTicket: Statement = {
  columns: [
    ['run', 'text'],
    ['started', 'time'],
    ['merged', 'count'],
    ['cost', 'usd'],
    ['cost_per_merged', 'usd'],
  ],
  body: `,
    runs AS (SELECT project, run, min("at") AS started FROM events WHERE kind = 'start' GROUP BY project, run),
    merged AS (
      SELECT project, run, count(DISTINCT ticket) AS merged FROM events
      WHERE kind = 'closed' AND commit IS NOT NULL GROUP BY project, run
    ),
    turns AS (SELECT project, run, sum(cost_usd) AS cost FROM events WHERE kind = 'turn' GROUP BY project, run),
    ends AS (SELECT project, run, max(cost_usd) AS cost FROM events WHERE kind = 'end' GROUP BY project, run)
    SELECT r.run, r.started, coalesce(m.merged, 0) AS merged, coalesce(t.cost, e.cost) AS cost,
      coalesce(t.cost, e.cost) / nullif(m.merged, 0) AS cost_per_merged
    FROM runs r
      LEFT JOIN merged m USING (project, run)
      LEFT JOIN turns t USING (project, run)
      LEFT JOIN ends e USING (project, run)
    WHERE r.started >= $since
    ORDER BY r.started, r.run`,
}

const tokenColumns = [
  ['input', 'tokens'],
  ['output', 'tokens'],
  ['cache_write', 'tokens'],
  ['cache_read', 'tokens'],
  ['cost', 'usd'],
] as const

// By run, from the turn records, which know their run; by ticket or project, from Pi's session
// files, which hold every call, a talk's and the probe's aside.
const tokensByModel = (
  query: InsightsQuery & { readonly _tag: 'tokens_by_model' },
): Statement => ({
  columns: [[query.by, 'text'], ['model', 'text'], ...tokenColumns],
  body:
    query.by === 'run'
      ? `,
    turn_tokens AS (
      SELECT run AS key, m AS model, json_extract(tokens, '$."' || m || '"') AS t,
        CASE WHEN model = m THEN cost_usd END AS cost
      FROM events, unnest(json_keys(tokens)) AS k(m)
      WHERE kind = 'turn' AND tokens IS NOT NULL AND "at" >= $since
    )
    SELECT key AS run, model,
      sum(json_extract_string(t, '$.input')::BIGINT) AS input, sum(json_extract_string(t, '$.output')::BIGINT) AS output,
      sum(json_extract_string(t, '$.cache_write')::BIGINT) AS cache_write,
      sum(json_extract_string(t, '$.cache_read')::BIGINT) AS cache_read, sum(cost) AS cost
    FROM turn_tokens GROUP BY key, model ORDER BY key, model`
      : `
    SELECT ${query.by}, model, sum(input) AS input, sum(output) AS output,
      sum(cache_write) AS cache_write, sum(cache_read) AS cache_read, sum(cost) AS cost
    FROM sessions WHERE "at" >= $since GROUP BY ${query.by}, model ORDER BY ${query.by}, model`,
})

// Of the tickets that reached the merge queue, the share merged, set aside, and handed back for
// each kind of hand-back.
const handBackRates: Statement = {
  columns: [
    ['outcome', 'text'],
    ['tickets', 'count'],
    ['share', 'share'],
  ],
  body: `,
    reached AS (
      SELECT DISTINCT project || '/' || ticket AS ticket, outcome FROM merges WHERE ${recorded()}
    ),
    handed AS (
      SELECT kind, count(DISTINCT project || '/' || ticket) AS tickets FROM hand_backs
      WHERE ${recorded()} GROUP BY kind
    ),
    parts AS (
      SELECT 'merged' AS outcome, count(DISTINCT ticket) AS tickets FROM reached WHERE outcome = 'merged'
      UNION ALL
      SELECT 'set_aside', count(DISTINCT ticket) FROM reached WHERE outcome <> 'merged'
      UNION ALL
      SELECT 'hand_back:' || k.kind, coalesce(h.tickets, 0)
      FROM (VALUES ('resolve'), ('fix')) k(kind) LEFT JOIN handed h USING (kind)
    )
    SELECT outcome, tickets, tickets / nullif((SELECT count(DISTINCT ticket) FROM reached), 0) AS share
    FROM parts ORDER BY outcome`,
}

// Similar tickets are those of a type: per type and model, the tickets worked, the share a worker
// finished, the median time worked, and the tokens and cost per ticket from Pi's session files.
const modelsCompared: Statement = {
  columns: [
    ['type', 'text'],
    ['model', 'text'],
    ['tickets', 'count'],
    ['finished', 'share'],
    ['median', 'millis'],
    ['tokens_per_ticket', 'tokens'],
    ['cost_per_ticket', 'usd'],
  ],
  body: `,
    worked AS (
      SELECT w.project, w.ticket, w.model, coalesce(t.type, 'unknown') AS type,
        sum(w.duration_ms) AS millis, bool_or(w.outcome = 'finish') AS finished
      FROM worker_sessions w LEFT JOIN tickets t ON t.project = w.project AND t.id = w.ticket
      WHERE ${recorded('w.')}
      GROUP BY w.project, w.ticket, w.model, coalesce(t.type, 'unknown')
    ),
    spent AS (
      SELECT project, ticket, model, sum(input + output + cache_write + cache_read) AS tokens,
        sum(cost) AS cost
      FROM sessions GROUP BY project, ticket, model
    )
    SELECT w.type, w.model, count(*) AS tickets, avg(w.finished::INTEGER) AS finished,
      median(w.millis) AS median, avg(s.tokens) AS tokens_per_ticket, avg(s.cost) AS cost_per_ticket
    FROM worked w LEFT JOIN spent s
      ON s.project = w.project AND s.ticket = w.ticket AND s.model = w.model
    GROUP BY w.type, w.model ORDER BY w.type, w.model`,
}

const statementOf = (query: InsightsQuery): Statement =>
  InsightsQuery.match(query, {
    ticket_time: ticketTime,
    waits: () => waits,
    check_durations: checkDurations,
    flaky_tests: () => flakyTests,
    cost_per_merged_ticket: () => costPerMergedTicket,
    tokens_by_model: tokensByModel,
    hand_back_rates: () => handBackRates,
    models_compared: () => modelsCompared,
  })

/** The project a query is about, where it names one. */
export const projectOf = (query: InsightsQuery): Option.Option<ProjectId> =>
  query._tag === 'ticket_time' ? Option.some(query.project) : query.project

/** The epoch milliseconds a query looks from: `since`, or the start of time. */
const sinceOf = (query: InsightsQuery): number =>
  query._tag === 'ticket_time'
    ? 0
    : Option.match(query.since, {
        onNone: () => 0,
        onSome: DateTime.toEpochMillis,
      })

/**
 * Runs the statement `body` after the sources' preamble, with its parameters and the project and
 * time: those it names, since DuckDB refuses a parameter its statement doesn't take.
 */
const run = (options: {
  readonly sources: Sources
  readonly body: string
  readonly project: Option.Option<ProjectId>
  readonly since: number
  readonly parameters?: Readonly<Record<string, Parameter>>
}) =>
  Effect.gen(function* () {
    const db = yield* TelemetryDb
    const preamble = preambleOf(options.sources)
    const text = `${preamble.text}${options.body}`
    const parameters = Object.entries({
      ...preamble.parameters,
      ...options.parameters,
      project: Option.getOrNull(options.project),
      since: options.since,
    }).filter(([name]) => new RegExp(`\\$${name}\\b`, 'u').test(text))
    return yield* db.rows(text, Object.fromEntries(parameters))
  })

/** A cell as the protocol carries it: counts, times and tokens whole. */
const cellOf = (
  value: Value,
  unit: ColumnUnit,
): Option.Option<number | string> => {
  if (value === null) return Option.none()
  if (typeof value === 'string') return Option.some(value)
  if (!Number.isFinite(value)) return Option.none()
  return Option.some(
    unit === 'usd' || unit === 'share' ? value : Math.round(value),
  )
}

const tableOf = (
  columns: Statement['columns'],
  rows: ReadonlyArray<ResultRow>,
): InsightsTable =>
  new InsightsTable({
    columns: Array.map(
      columns,
      ([name, unit]) => new InsightsColumn({ name, unit }),
    ),
    rows: rows.map(row =>
      columns.map(([name, unit]) => cellOf(row[name] ?? null, unit)),
    ),
  })

/** Runs the named `query` over the recorded rows' copies and `sources`. */
export const runNamedQuery = Effect.fn('Insights.query')(function* (
  query: InsightsQuery,
  sources: Sources,
) {
  const statement = statementOf(query)
  const rows = yield* run({
    sources,
    body: statement.body,
    project: projectOf(query),
    since: sinceOf(query),
    ...(statement.parameters === undefined
      ? {}
      : { parameters: statement.parameters }),
  })
  return tableOf(statement.columns, rows)
})

const numberOf = (value: Value | undefined): number =>
  typeof value === 'number' ? value : 0

/** The Insights screen's summary (§18.4) of the project, or of every project, from `since`. */
export const readSummary = Effect.fn('Insights.summary')(function* (
  options: {
    readonly project: Option.Option<ProjectId>
    readonly since: Option.Option<DateTime.Utc>
  },
  sources: Sources,
) {
  const scope = {
    sources,
    project: options.project,
    since: Option.match(options.since, {
      onNone: () => 0,
      onSome: DateTime.toEpochMillis,
    }),
  }
  const [counts, handBacks, models] = yield* Effect.all(
    [
      run({
        ...scope,
        body: `
    SELECT
      count(DISTINCT project || '/' || run) FILTER (WHERE kind = 'start') AS runs,
      count(*) FILTER (WHERE kind = 'closed' AND commit IS NOT NULL) AS merged,
      count(*) FILTER (WHERE kind = 'deferred') AS set_aside,
      median(seconds * 1000) FILTER (WHERE kind = 'ticket_end' AND outcome = 'merged') AS ready_to_merged
    FROM events WHERE "at" >= $since`,
      }),
      run({
        ...scope,
        body: `
    SELECT kind, count(*) AS count FROM hand_backs WHERE ${recorded()} GROUP BY kind`,
      }),
      run({
        ...scope,
        body: `
    SELECT model, sum(input) AS input, sum(output) AS output, sum(cache_write) AS cache_write,
      sum(cache_read) AS cache_read, sum(cost) AS cost, count(cost) AS priced
    FROM sessions WHERE "at" >= $since GROUP BY model ORDER BY model`,
      }),
    ],
    { concurrency: 1 },
  )
  const count = counts[0]
  const handBacksOf = (kind: string) =>
    numberOf(handBacks.find(row => row.kind === kind)?.count)
  const tokens: Record<ModelName, Tokens> = {}
  for (const row of models) {
    const model = ModelName.makeOption(String(row.model))
    if (Option.isNone(model)) continue
    tokens[model.value] = {
      input: numberOf(row.input),
      output: numberOf(row.output),
      cache_write: numberOf(row.cache_write),
      cache_read: numberOf(row.cache_read),
    }
  }
  const priced = models.some(row => numberOf(row.priced) > 0)
  const readyToMerged = count?.ready_to_merged
  return new InsightsSummary({
    runs: numberOf(count?.runs),
    merged: numberOf(count?.merged),
    setAside: numberOf(count?.set_aside),
    handBacks: { resolve: handBacksOf('resolve'), fix: handBacksOf('fix') },
    tokens,
    costUsd: priced
      ? Option.some(models.reduce((sum, row) => sum + numberOf(row.cost), 0))
      : Option.none(),
    readyToMerged:
      typeof readyToMerged === 'number'
        ? Option.some(Math.round(readyToMerged))
        : Option.none(),
  })
})
