import { Duration } from 'effect'

// The reaper (spec §12.1, H74): a small Node process started beside each agent, in a group of its
// own, that ends the agent's whole tree when the engine dies without running its finalizers (a
// SIGKILL). Its stdin is a pipe only the engine holds; the kernel closes it when the engine dies,
// however it died, and the reaper then terminates every group of the agent's tree, waits the grace,
// and kills what is left. On a normal release the engine has ended the tree itself and ends the
// reaper after it.
//
// While it waits, the reaper lists the agent's tree every `poll` and keeps the groups it found, so
// a descendant the agent's exit leaves without a parent is still reached through its group. A group
// with no member left is forgotten, so a group ID the system reuses is never signalled.
//
// It runs as its own script, so it can't import the engine's modules: its tree walk is
// `process/tree.ts`'s `treeOf` (members of the known groups and their descendants, through
// parents), over the same `ps` columns.

const SOURCE = `'use strict'
const { execFileSync } = require('node:child_process')
const agent = Number(process.argv[1])
const poll = Number(process.argv[2])
const grace = Number(process.argv[3])
const own = process.pid
let groups = new Set([agent])
const look = () => {
  let text
  try {
    text = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10000,
    })
  } catch {
    return
  }
  const children = new Map()
  const pgids = new Map()
  for (const line of text.split('\\n')) {
    const match = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    pgids.set(pid, Number(match[3]))
    const siblings = children.get(ppid)
    if (siblings === undefined) children.set(ppid, [pid])
    else siblings.push(pid)
  }
  const live = new Set(pgids.values())
  const found = new Set([agent])
  const pending = [...pgids.keys()].filter(pid => pid === agent || groups.has(pgids.get(pid)))
  const seen = new Set()
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    if (seen.has(pid)) continue
    seen.add(pid)
    const pgid = pgids.get(pid)
    if (pgid > 1 && pgid !== own) found.add(pgid)
    pending.push(...(children.get(pid) ?? []))
  }
  groups = new Set([...found].filter(pgid => pgid === agent || live.has(pgid)))
}
const signal = name => {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, name)
    } catch {}
  }
}
look()
const timer = setInterval(look, poll)
process.stdin.on('data', () => {})
process.stdin.once('end', () => {
  clearInterval(timer)
  look()
  signal('SIGTERM')
  setTimeout(() => {
    look()
    signal('SIGKILL')
    process.exit(0)
  }, grace)
})
`

/** The reaper's arguments to Node, for the agent whose process (and group) is `agent`. */
export const reaperArguments = ({
  agent,
  poll,
  grace,
}: {
  readonly agent: number
  readonly poll: Duration.Input
  readonly grace: Duration.Input
}): ReadonlyArray<string> => [
  '-e',
  SOURCE,
  String(agent),
  String(Duration.toMillis(Duration.fromInputUnsafe(poll))),
  String(Duration.toMillis(Duration.fromInputUnsafe(grace))),
]
