import { Effect, Option } from 'effect'
import { execFile } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import type { Readable } from 'node:stream'

// Who holds a command's pipes (spec §12.1, H61, H74): once a command has exited, a descendant that
// moved to a group of its own and whose parent exited too is no longer in its tree, yet may still
// hold its output pipes open. It is found by the pipes themselves. Node gives a child's stdio
// socketpairs, whose two ends are told apart: on macOS lsof names the far end of the engine's own
// (`->0x…`), while on Linux /proc gives each end an inode of its own, so the far ends are read from
// the command's fds 1 and 2 as it starts, and looked for later.

export interface PipeHolders {
  /** Read as the command `pid` starts: what names the far ends of its pipes, where the host needs it. */
  readonly ends: (pid: number) => ReadonlyArray<string>
  /** The processes, other than the engine, holding the far ends of the engine's pipe ends `fds`. */
  readonly find: (pipes: {
    readonly fds: ReadonlyArray<number>
    readonly ends: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<number>>
}

/** The file descriptor of the engine's end of a child's pipe, while it is open. */
export const pipeFd = (readable: Readable): Option.Option<number> => {
  if (readable.destroyed) return Option.none()
  const fd: unknown = Reflect.get(
    Object(Reflect.get(readable, '_handle')),
    'fd',
  )
  return typeof fd === 'number' && fd >= 0 ? Option.some(fd) : Option.none()
}

const lsof = (
  args: ReadonlyArray<string>,
): Effect.Effect<Option.Option<string>> =>
  Effect.callback<Option.Option<string>>(resume => {
    execFile(
      '/usr/sbin/lsof',
      [...args],
      { env: { LC_ALL: 'C' }, maxBuffer: 256 * 1024 * 1024, timeout: 10_000 },
      // lsof exits 1 when some of what it was asked about has nothing open; its output still holds
      // what it found.
      (_error, stdout) =>
        resume(
          Effect.succeed(stdout === '' ? Option.none() : Option.some(stdout)),
        ),
    )
  })

/** Reads lsof's `-F` output into each process's names (`n` lines) and devices (`d` lines). */
export const parseLsof = (
  text: string,
): ReadonlyArray<{
  readonly pid: number
  readonly devices: ReadonlyArray<string>
  readonly names: ReadonlyArray<string>
}> => {
  const processes: Array<{
    pid: number
    devices: Array<string>
    names: Array<string>
  }> = []
  for (const line of text.split('\n')) {
    const field = line.slice(1)
    if (line.startsWith('p'))
      processes.push({ pid: Number(field), devices: [], names: [] })
    else if (line.startsWith('d')) processes.at(-1)?.devices.push(field)
    else if (line.startsWith('n')) processes.at(-1)?.names.push(field)
  }
  return processes
}

/** macOS: the far end of a socketpair or pipe names the engine's end's address, `->0x…`. */
export const lsofHolders = (self: number): PipeHolders => ({
  ends: () => [],
  find: ({ fds }) =>
    Effect.gen(function* () {
      if (fds.length === 0) return []
      const own = yield* lsof([
        '-a',
        '-p',
        String(self),
        '-d',
        fds.join(','),
        '-F',
        'pd',
      ])
      const ends = new Set(
        Option.match(own, {
          onNone: () => [],
          onSome: text =>
            parseLsof(text).flatMap(entry =>
              entry.devices.map(device => `->${device}`),
            ),
        }),
      )
      if (ends.size === 0) return []
      const all = yield* lsof(['-n', '-P', '-F', 'pn'])
      return Option.match(all, {
        onNone: () => [],
        onSome: text =>
          parseLsof(text)
            .filter(
              entry =>
                entry.pid !== self && entry.names.some(name => ends.has(name)),
            )
            .map(entry => entry.pid),
      })
    }).pipe(Effect.withSpan('ProcessHolders.lsof')),
})

const link = (path: string): Promise<string | undefined> =>
  readlink(path).catch(() => undefined)

/**
 * Linux: under `proc` (/proc), each open end links to `socket:[inode]` or `pipe:[inode]`; a command's
 * fds 1 and 2 are read as it starts, before it can have moved them.
 */
export const procHolders = ({
  self,
  proc,
}: {
  readonly self: number
  readonly proc: string
}): PipeHolders => ({
  ends: pid =>
    [1, 2].flatMap(fd => {
      try {
        return [readlinkSync(`${proc}/${pid}/fd/${fd}`)]
      } catch {
        return []
      }
    }),
  find: ({ ends }) =>
    Effect.promise(async () => {
      const wanted = new Set(ends)
      if (wanted.size === 0) return []
      const pids = (await readdir(proc).catch(() => [])).filter(name =>
        /^\d+$/.test(name),
      )
      const holders = await Promise.all(
        pids.map(async pid => {
          if (Number(pid) === self) return []
          const fds = await readdir(`${proc}/${pid}/fd`).catch(() => [])
          const targets = await Promise.all(
            fds.map(fd => link(`${proc}/${pid}/fd/${fd}`)),
          )
          return targets.some(
            target => target !== undefined && wanted.has(target),
          )
            ? [Number(pid)]
            : []
        }),
      )
      return holders.flat()
    }).pipe(Effect.withSpan('ProcessHolders.proc')),
})

/** The host's way of finding holders, by its platform; none where it has neither. */
export const hostHolders = ({
  platform,
  self,
}: {
  readonly platform: NodeJS.Platform
  readonly self: number
}): PipeHolders =>
  platform === 'darwin'
    ? lsofHolders(self)
    : platform === 'linux'
      ? procHolders({ self, proc: '/proc' })
      : { ends: () => [], find: () => Effect.succeed([]) }
