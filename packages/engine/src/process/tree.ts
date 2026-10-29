import { Duration, Effect, Option } from 'effect'
import { execFile } from 'node:child_process'

import type { DeadlinesShape } from './deadlines'

// Ending a command's whole tree (spec §12.1, H74): the one rule for how a command, an agent or what a
// reaper finds is ended. Its tree is listed, then its group and the group of every descendant are
// terminated (test runners start workers in groups of their own), and what is left after a grace is
// killed. tutti signalled a check's group alone, and the test workers it left spun for days.

/** One process, as the process table lists it. */
export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  /** It has exited and waits on its parent to reap it: nothing is left to end. */
  readonly zombie: boolean
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/

/** Reads `ps -A -o pid=,ppid=,pgid=,stat=` output; a line it can't read is skipped. */
export const parseProcessTable = (text: string): ReadonlyArray<ProcessRow> =>
  text.split('\n').flatMap(line => {
    const match = ROW.exec(line)
    if (match === null) return []
    const [, pid, ppid, pgid, stat] = match
    if (
      pid === undefined ||
      ppid === undefined ||
      pgid === undefined ||
      stat === undefined
    )
      return []
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        zombie: stat.startsWith('Z'),
      },
    ]
  })

/**
 * Every process of the host, from `ps` (the same flags on macOS and Linux), or none when `ps` can't
 * tell.
 */
export const listProcesses: Effect.Effect<
  Option.Option<ReadonlyArray<ProcessRow>>
> = Effect.callback<Option.Option<ReadonlyArray<ProcessRow>>>(resume => {
  execFile(
    '/bin/ps',
    ['-A', '-o', 'pid=,ppid=,pgid=,stat='],
    { env: { LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
    (error, stdout) => {
      resume(
        Effect.succeed(
          error === null
            ? Option.some(parseProcessTable(stdout))
            : Option.none(),
        ),
      )
    },
  )
}).pipe(Effect.withSpan('ProcessTree.list'))

/**
 * The live processes of a tree: those `pids` names, the members of `groups`, and every descendant
 * of either, through their parents. Zombies are left out.
 */
export const treeOf = ({
  rows,
  pids,
  groups,
}: {
  readonly rows: ReadonlyArray<ProcessRow>
  readonly pids: ReadonlySet<number>
  readonly groups: ReadonlySet<number>
}): ReadonlyArray<ProcessRow> => {
  const children = new Map<number, Array<ProcessRow>>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings === undefined) children.set(row.ppid, [row])
    else siblings.push(row)
  }
  const found = new Map<number, ProcessRow>()
  const pending = rows.filter(row => pids.has(row.pid) || groups.has(row.pgid))
  for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
    if (found.has(row.pid)) continue
    found.set(row.pid, row)
    pending.push(...(children.get(row.pid) ?? []))
  }
  return [...found.values()].filter(row => !row.zombie)
}

/** What ending a tree needs from its host: the process table, and the deadlines its grace counts on. */
export interface TreeHost {
  readonly listProcesses: Effect.Effect<
    Option.Option<ReadonlyArray<ProcessRow>>
  >
  readonly deadlines: DeadlinesShape
  /** The engine's own process, whose group is never signalled. */
  readonly self: number
}

/** Whether any process is left in the group `pgid`: a signal 0 reaches it, or would but for permission. */
export const groupHasMembers = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return Reflect.get(Object(error), 'code') === 'EPERM'
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The group has no process left, or none the engine may signal.
  }
}

/** How often a terminated tree is listed again, to see whether it is gone before its grace ends. */
const POLL = Duration.millis(25)

/**
 * Ends the tree of the command whose process is `pid`, a group leader: terminates every group in it,
 * waits up to `grace` for the tree to go, and kills what is left. A command that has exited already
 * still has its group's members found, those it left behind; `holders`, the processes holding its
 * pipes, are part of its tree wherever they moved.
 */
export const endTree = Effect.fn('ProcessTree.end')(function* ({
  host,
  pid,
  holders,
  grace,
}: {
  readonly host: TreeHost
  readonly pid: number
  readonly holders: ReadonlyArray<number>
  readonly grace: Duration.Input
}) {
  const pids = new Set([pid, ...holders])
  const groups = new Set([pid])
  // Lists the tree, adding what it finds to those known, and signals each of its groups: a process
  // that left the tree's groups is reached through its own.
  const signalTree = Effect.fnUntraced(function* (signal: NodeJS.Signals) {
    const rows = yield* host.listProcesses
    if (Option.isNone(rows)) {
      signalGroup(pid, signal)
      return Option.none<number>()
    }
    const own = rows.value.find(row => row.pid === host.self)?.pgid
    const tree = treeOf({ rows: rows.value, pids, groups }).filter(
      row => row.pid > 1 && row.pid !== host.self,
    )
    for (const row of tree) {
      pids.add(row.pid)
      if (row.pgid > 1 && row.pgid !== own) groups.add(row.pgid)
    }
    for (const group of groups) signalGroup(group, signal)
    return Option.some(tree.length)
  })
  const gone = Effect.gen(function* () {
    for (;;) {
      const rows = yield* host.listProcesses
      if (
        Option.isSome(rows) &&
        treeOf({ rows: rows.value, pids, groups }).length === 0
      )
        return
      yield* Effect.sleep(POLL)
    }
  })
  const terminated = yield* signalTree('SIGTERM')
  if (Option.isSome(terminated) && terminated.value === 0) return
  yield* Effect.raceFirst(gone, host.deadlines.sleep(grace))
  const killed = yield* signalTree('SIGKILL')
  if (Option.isSome(killed) && killed.value === 0) return
  // A killed process is gone once its parent reaps it; a process the kernel holds can't be waited on
  // past the grace.
  yield* Effect.raceFirst(gone, host.deadlines.sleep(grace))
})
