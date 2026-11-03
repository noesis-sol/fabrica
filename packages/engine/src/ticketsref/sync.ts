import {
  Data,
  DateTime,
  Effect,
  Fiber,
  Option,
  Ref,
  Semaphore,
  Stream,
} from 'effect'

import {
  type CommitHash,
  Edge,
  type EdgeKind,
  type EngineId,
  Ticket,
  type TicketChange,
  type TicketEvent,
  TicketId,
} from '@fabrica/contracts'

import { Git, type GitShape, GitVersion, PushOutcome } from '../git'
import { StoreFailed } from '../workgraph/errors'
import type { WorkGraphShape } from '../workgraph/service'
import {
  LayoutTooNew,
  TicketFile,
  TicketsMeta,
  Tombstone,
  byClockedField,
  clockedFields,
  decodeLease,
  decodeMeta,
  decodeTicketFile,
  decodeTombstone,
  encodeLease,
  encodeMeta,
  encodeTicketFile,
  encodeTombstone,
  fieldTexts,
  layoutVersion,
  notesById,
} from './codec'
import { type Hlc, later, tick } from './hlc'
import {
  type Local,
  type LocalTicket,
  type PendingChange,
  type QuarantinedFile,
  type SyncState,
  makeLocal,
} from './local'
import {
  Entry,
  type MergeConflict,
  mergeEntry,
  mergeLease,
  mergeMeta,
} from './merge'
import { isOverCap, secretsIn } from './privacy'
import {
  type Listing,
  type RefFailure,
  RefFetch,
  RefMove,
  makeTicketsStore,
} from './store'

// The tickets ref's sync (spec §11.3, §11.4, §11.7): the store's changes committed on the ref, the ref
// merged with what another engine pushed, and the result imported into the store.
//
// The last commit imported is what the store last agreed with. A cycle compares the tickets with events
// since then against that commit's files, and commits what differs on top of it, each field that changed
// at a new clock; a sync with nothing changed makes no commit and writes nothing. Where the ref has moved
// past it (a crash after the ref moved, a fetch merged) the commit and the ref are merged, and the
// difference imported in one transaction, refused if anything in the store has changed meanwhile: then
// the cycle runs again from the store as it is. So every step can fail anywhere and the next cycle puts
// it right: nothing moves the ref but a compare-and-swap, and the ref's history only grows.

/** How many times a cycle runs again when another process, or the store, moved under it. */
const cycleTries = 5

/** How long a tombstone stays on the ref (§11.7). */
const tombstoneMillis = 90 * 24 * 60 * 60 * 1000

/** Git is missing or too old: sync is off (§11.7). */
export class SyncOff extends Data.TaggedError('SyncOff')<{
  readonly reason: string
}> {
  override get message() {
    return `tickets sync is off: ${this.reason}`
  }
}

/** A secret pattern in what was to be exported: nothing is committed until it goes (§11.7). */
export class ExportBlocked extends Data.TaggedError('ExportBlocked')<{
  readonly findings: readonly [string, ...Array<string>]
}> {
  override get message() {
    return `a secret pattern blocks the tickets' export: ${this.findings.join('; ')}`
  }
}

/** The ref or the store kept moving: the cycle ran out of tries, and waits for its next turn. */
export class SyncBusy extends Data.TaggedError('SyncBusy')<{}> {
  override get message() {
    return 'the tickets ref kept moving during a sync'
  }
}

/** There is no ref to rebuild from. */
export class NoTicketsRef extends Data.TaggedError('NoTicketsRef')<{}> {
  override get message() {
    return 'this repository has no tickets ref to rebuild from'
  }
}

/** Why a sync stopped: every one leaves the store and the ref as they were. */
export type SyncStopped =
  | SyncOff
  | ExportBlocked
  | SyncBusy
  | LayoutTooNew
  | RefFailure
  | StoreFailed

/** What a cycle over the store and the local ref did. */
export interface Settled {
  /** The store's changes made a commit. */
  readonly committed: boolean
  /** Tickets the import changed in the store. */
  readonly imported: number
}

const nothingSettled: Settled = { committed: false, imported: 0 }

/** What a fetch and its merge did. */
export type Pulled = Data.TaggedEnum<{
  /** The remote's ref is in the local ref's history now. */
  Merged: { readonly imported: number }
  /** The remote holds no such ref yet. */
  Absent: {}
  /** Offline, or the credentials refused; it waits for the next scheduled sync. */
  Unreachable: { readonly message: string }
}>
export const Pulled = Data.taggedEnum<Pulled>()

/** What a whole sync with a remote did. */
export interface Synced {
  readonly pulled: Pulled
  readonly pushed: PushOutcome
}

/** What a rebuild brought back. */
export interface RebuiltStore {
  readonly tickets: number
  readonly tombstones: number
  readonly quarantined: number
}

export interface TicketsSyncShape {
  /** Commits the store's changes on the local ref, imports whatever the ref holds beyond the store. */
  readonly commit: Effect.Effect<Settled, SyncStopped>
  /** Fetches the remote's ref and merges it into the local ref and the store. */
  readonly pull: (remote: string) => Effect.Effect<Pulled, SyncStopped>
  /** Pushes the local ref, naming the remote first where it hasn't been; never forced. */
  readonly push: (remote: string) => Effect.Effect<PushOutcome, SyncStopped>
  /** Pulls and pushes, a push losing to another engine's fetched and merged first. */
  readonly sync: (remote: string) => Effect.Effect<Synced, SyncStopped>
  /** Rebuilds the store from the ref (`fabrica tickets rebuild`). */
  readonly rebuild: Effect.Effect<RebuiltStore, SyncStopped | NoTicketsRef>
  /** The sync state. */
  readonly state: Effect.Effect<SyncState, StoreFailed>
}

const edgeKinds: ReadonlyArray<EdgeKind> = [
  'blocks',
  'discovered_from',
  'parent',
  'related',
]

const metaPath = 'meta.json'
const leasePath = 'lease.json'
const ticketPath = (id: TicketId) => `tickets/${id}.json`
const tombstonePath = (id: TicketId) => `tombstones/${id}.json`

const ticketOfPath = (path: string, folder: string): Option.Option<TicketId> =>
  path.startsWith(`${folder}/`) && path.endsWith('.json')
    ? TicketId.makeOption(path.slice(folder.length + 1, -'.json'.length))
    : Option.none()

/** A ticket's file on the ref, read. */
type Read<A> = Data.TaggedEnum<{
  Good: { readonly value: A }
  Bad: { readonly reason: string }
}>
const good = <A>(value: A): Read<A> => ({ _tag: 'Good', value })
const bad = <A>(reason: string): Read<A> => ({ _tag: 'Bad', reason })

/** A record decoded, or why it wasn't: the file is quarantined (§11.7). */
const readRecord = <A, E extends { readonly message: string }>(
  decoding: Effect.Effect<A, E>,
): Effect.Effect<Read<A>> =>
  decoding.pipe(
    Effect.map(good),
    Effect.catch(error => Effect.succeed(bad<A>(error.message))),
  )

const readTicketFile = (id: TicketId, bytes: Uint8Array) =>
  Effect.map(readRecord(decodeTicketFile(bytes)), (read): Read<TicketFile> =>
    read._tag === 'Good' && read.value.ticket.id !== id
      ? bad(`the file of ${id} holds ${read.value.ticket.id}`)
      : read,
  )

const readTombstone = (id: TicketId, bytes: Uint8Array) =>
  Effect.map(readRecord(decodeTombstone(bytes)), (read): Read<Tombstone> =>
    read._tag === 'Good' && read.value.id !== id
      ? bad(`the tombstone of ${id} holds ${read.value.id}`)
      : read,
  )

const storeFailed = (operation: string) => (error: unknown) =>
  new StoreFailed({
    operation,
    reason: error instanceof Error ? error.message : String(error),
  })

const isNonEmpty = <A>(
  items: ReadonlyArray<A>,
): items is readonly [A, ...Array<A>] => items.length > 0

const sameCommit = (
  a: Option.Option<CommitHash>,
  b: Option.Option<CommitHash>,
): boolean => Option.getOrUndefined(a) === Option.getOrUndefined(b)

/** The later of the clocks a ticket's file holds, and `clock`. */
const pastClocks = (clock: Hlc, file: TicketFile): Hlc =>
  Option.reduceCompact(
    [file.clocks.reopened],
    clockedFields.reduce(
      (latest, field) => later(latest, file.clocks[field]),
      clock,
    ),
    later,
  )

/** A merge's conflict, as the event it records (§11.7). */
const conflictChange = (conflict: MergeConflict): TicketChange =>
  conflict._tag === 'Field'
    ? {
        _tag: 'merge_conflict',
        field: conflict.field,
        ours: conflict.ours,
        theirs: conflict.theirs,
      }
    : {
        _tag: 'merge_conflict',
        field: 'deleted',
        ours: conflict.deletedBy === 'ours' ? 'deleted' : 'edited',
        theirs: conflict.deletedBy === 'theirs' ? 'deleted' : 'edited',
      }

/** The ticket a file exports: a result that stays local (§11.7) leaves the ref's as it was. */
const exportedTicket = (
  ticket: Ticket,
  base: Option.Option<TicketFile>,
): Effect.Effect<Ticket, StoreFailed> =>
  Option.exists(ticket.result, isOverCap)
    ? Ticket.makeEffect({
        ...ticket,
        result: Option.flatMap(base, file => file.ticket.result),
      }).pipe(Effect.mapError(storeFailed('keeping a large result local')))
    : Effect.succeed(ticket)

/**
 * A ticket's file from the store: each field that differs from the base's at the new clock, the others
 * at theirs; a status leaving `closed` is a reopen (§11.4). Notes are never removed; a link the base has
 * to a ticket the store knows nothing of (`unknownTargets`) stays, as a missing ticket removes nothing.
 */
const fileFromLocal = ({
  local,
  base,
  clock,
  unknownTargets,
}: {
  readonly local: LocalTicket
  readonly base: Option.Option<TicketFile>
  readonly clock: Hlc
  readonly unknownTargets: ReadonlySet<string>
}): Effect.Effect<TicketFile, StoreFailed> =>
  Effect.gen(function* () {
    const ticket = yield* exportedTicket(local.ticket, base)
    const texts = fieldTexts(ticket)
    const baseTexts = Option.map(base, file => fieldTexts(file.ticket))
    const reopened = Option.exists(
      base,
      file => file.ticket.status === 'closed' && ticket.status !== 'closed',
    )
    const kept = (kind: keyof LocalTicket['edges']) => [
      ...local.edges[kind],
      ...Option.match(base, {
        onNone: () => [],
        onSome: file => file.edges[kind].filter(to => unknownTargets.has(to)),
      }),
    ]
    return yield* TicketFile.makeEffect({
      ticket,
      labels: local.labels,
      edges: {
        blocks: kept('blocks'),
        discovered_from: kept('discovered_from'),
        parent: kept('parent'),
        related: kept('related'),
      },
      notes: notesById([
        ...Option.match(base, {
          onNone: () => [],
          onSome: file => file.notes,
        }),
        ...local.notes,
      ]),
      clocks: {
        ...byClockedField(field =>
          Option.match(base, {
            onNone: () => clock,
            onSome: file =>
              Option.exists(baseTexts, old => old[field] === texts[field])
                ? file.clocks[field]
                : clock,
          }),
        ),
        reopened: reopened
          ? Option.some(clock)
          : Option.flatMap(base, file => file.clocks.reopened),
      },
    }).pipe(Effect.mapError(storeFailed('exporting a ticket')))
  })

/** The sync of the project's store and the tickets ref of the repository holding `repo`. */
export const makeTicketsSync = Effect.fn('TicketsSync.make')(function* ({
  repo,
  prefix,
  engine,
}: {
  readonly repo: string
  /** The project's ticket ID prefix, for `meta.json`. */
  readonly prefix: string
  readonly engine: EngineId
}) {
  const git: GitShape = yield* Git
  const store = yield* makeTicketsStore({ repo })
  const local: Local = yield* makeLocal(engine)
  // The engine is the ref's only writer on its host: one sync of it at a time.
  const lock = yield* Semaphore.make(1)
  const gitChecked = yield* Ref.make(false)

  /** Refuses a git it can't use, once it has told; reads the hooks to turn off. */
  const prepare = Effect.gen(function* () {
    if (!(yield* Ref.get(gitChecked))) {
      yield* GitVersion.$match(yield* git.version, {
        Supported: () => Ref.set(gitChecked, true),
        TooOld: ({ version, minimum }) =>
          Effect.fail(
            new SyncOff({
              reason: `git ${version} is older than ${minimum}`,
            }),
          ),
        Missing: ({ path }) =>
          Effect.fail(
            new SyncOff({ reason: `git is not on the PATH (${path})` }),
          ),
        Unreadable: ({ reason }) => Effect.fail(new SyncOff({ reason })),
      })
    }
    yield* store.refreshHooks
  })

  /** Stops when a commit's layout is newer than this engine's, before anything is written over it (§11.7). */
  const checkLayout = (commit: CommitHash) =>
    Effect.gen(function* () {
      const hash = (yield* store.list(commit)).get(metaPath)
      if (hash === undefined) return
      const bytes = (yield* store.readBlobs([hash])).get(hash)
      if (bytes === undefined) return
      yield* decodeMeta(bytes).pipe(
        Effect.catchTags({
          RecordUndecodable: () => Effect.void,
          RecordTooNew: () => Effect.void,
        }),
      )
    })

  const metaText = encodeMeta(
    new TicketsMeta({ layout: layoutVersion, prefix }),
  ).pipe(Effect.mapError(storeFailed('writing meta.json')))

  // --- Export ----------------------------------------------------------------------------------

  /** A commit of the store's changes on the last commit imported; none where nothing differs. */
  const exportLocal = ({
    state,
    listing,
  }: {
    readonly state: SyncState
    readonly listing: Listing
  }) =>
    Effect.gen(function* () {
      const first = Option.isNone(state.lastImported)
      const since = first
        ? { ids: [], deleted: true }
        : yield* local.changedSince(state.exportedSeq)
      const named: ReadonlyArray<TicketId> = since.ids
      if (!since.deleted && named.length === 0) return Option.none()
      const ids = since.deleted
        ? [...new Set([...(yield* local.allIds), ...named])]
        : named
      const tickets = yield* local.readTickets(ids)

      const baseHashes = new Map<TicketId, string>()
      for (const { ticket } of tickets) {
        const hash = listing.get(ticketPath(ticket.id))
        if (hash !== undefined) baseHashes.set(ticket.id, hash)
      }
      const baseBytes = yield* store.readBlobs(baseHashes.values())
      const now = DateTime.toEpochMillis(yield* DateTime.now)
      const clock = tick({ engine, last: state.lastClock, now })

      // A base's link gone from the store: the target's known and the link was removed, or a ticket
      // the store has never heard of, whose file a missing ticket doesn't remove.
      const bases = new Map<TicketId, Option.Option<TicketFile>>()
      const quarantined = new Set<TicketId>()
      const missing = new Set<TicketId>()
      for (const { ticket } of tickets) {
        const hash = baseHashes.get(ticket.id)
        const bytes = hash === undefined ? undefined : baseBytes.get(hash)
        if (bytes === undefined) {
          bases.set(ticket.id, Option.none())
          continue
        }
        const read = yield* readTicketFile(ticket.id, bytes)
        if (read._tag === 'Bad') quarantined.add(ticket.id)
        else {
          bases.set(ticket.id, Option.some(read.value))
          for (const targets of Object.values(read.value.edges))
            for (const target of targets) missing.add(target)
        }
      }
      const known = yield* local.present([...missing])
      const stored = yield* local.tombstones
      const unknownTargets = new Set<string>(
        [...missing].filter(
          target =>
            !known.has(target) &&
            !stored.has(target) &&
            !listing.has(tombstonePath(target)),
        ),
      )

      const files: Array<{
        readonly path: string
        readonly text: string
        readonly file: TicketFile
      }> = []
      for (const item of tickets) {
        const id = item.ticket.id
        if (quarantined.has(id)) continue
        const base = bases.get(id) ?? Option.none()
        const file = yield* fileFromLocal({
          local: item,
          base,
          clock,
          unknownTargets,
        })
        const text = yield* encodeTicketFile(file).pipe(
          Effect.mapError(storeFailed('exporting a ticket')),
        )
        const hash = baseHashes.get(id)
        const had = hash === undefined ? undefined : baseBytes.get(hash)
        if (had === undefined || Buffer.from(had).toString('utf8') !== text)
          files.push({ path: ticketPath(id), text, file })
      }

      const live = new Set<string>(tickets.map(({ ticket }) => ticket.id))
      const namedSet = new Set<string>(named)
      const graves: Array<{
        readonly id: TicketId
        readonly path: string
        readonly text: string
      }> = []
      for (const [id, at] of stored) {
        const path = tombstonePath(id)
        const recent = now - at < tombstoneMillis
        if (
          recent &&
          !live.has(id) &&
          !listing.has(path) &&
          (first || namedSet.has(id))
        ) {
          const text = yield* encodeTombstone(
            new Tombstone({ id, clock }),
          ).pipe(Effect.mapError(storeFailed('exporting a tombstone')))
          graves.push({ id, path, text })
        }
      }

      const secrets = files.flatMap(({ path, text }) =>
        secretsIn(text).map(name => `${name} in ${path}`),
      )
      if (isNonEmpty(secrets)) {
        yield* local.warnBlocked(secrets)
        return yield* new ExportBlocked({ findings: secrets })
      }
      if (files.length === 0 && graves.length === 0) return Option.none()

      // The clock is kept before any commit holds it, so a crash never issues it twice.
      yield* local.setClock(clock)
      const next = new Map(listing)
      const written = yield* Effect.forEach(
        [...files, ...graves],
        ({ path, text }) =>
          Effect.map(
            store.writeBlob(text),
            (hash): readonly [string, string] => [path, hash],
          ),
        { concurrency: 4 },
      )
      for (const [path, hash] of written) next.set(path, hash)
      for (const { id } of graves) next.delete(ticketPath(id))
      if (!next.has(metaPath))
        next.set(metaPath, yield* store.writeBlob(yield* metaText))
      yield* pruneTombstones(next, now)
      const tree = yield* store.writeTree(next)
      const changed = files.length + graves.length
      const commit = yield* store.commitTree({
        tree,
        parents: Option.toArray(state.lastImported),
        message: `tickets: ${changed} changed (${engine})`,
        engine,
      })
      return Option.some({
        commit,
        clock,
        files: files.map(({ file }) => file),
      })
    })

  /** Leaves out the tombstones past their 90 days (§11.7); only ever in a commit made for another reason. */
  const pruneTombstones = (listing: Map<string, string>, now: number) =>
    Effect.gen(function* () {
      const graves = [...listing].flatMap(([path, hash]) =>
        Option.toArray(
          Option.map(
            ticketOfPath(path, 'tombstones'),
            (id): readonly [string, TicketId, string] => [path, id, hash],
          ),
        ),
      )
      const bytes = yield* store.readBlobs(graves.map(([, , hash]) => hash))
      for (const [path, id, hash] of graves) {
        const file = bytes.get(hash)
        if (file === undefined) continue
        const read = yield* readTombstone(id, file)
        if (
          read._tag === 'Good' &&
          now - read.value.clock.wall >= tombstoneMillis
        )
          listing.delete(path)
      }
    })

  // --- Merge -----------------------------------------------------------------------------------

  /** A ticket's entry at one commit: its file or tombstone's path and hash. */
  const entryAt = (listing: Listing, id: TicketId) => {
    const live = ticketPath(id)
    const dead = tombstonePath(id)
    const liveHash = listing.get(live)
    if (liveHash !== undefined)
      return Option.some({ path: live, hash: liveHash, deleted: false })
    const deadHash = listing.get(dead)
    return deadHash !== undefined
      ? Option.some({ path: dead, hash: deadHash, deleted: true })
      : Option.none()
  }

  /**
   * A commit merging `theirs` into `ours`, three-way against their base: only what both changed is
   * read and merged; what one changed is taken by its blob. An edge from a file either side changed to
   * a ticket neither has live is dropped (a side's own deletion dropped the links in its files). What
   * the merge has to record is kept before its commit is returned, so a crash loses none of it.
   */
  const mergeCommits = ({
    ours,
    theirs,
  }: {
    readonly ours: CommitHash
    readonly theirs: CommitHash
  }) =>
    Effect.gen(function* () {
      yield* checkLayout(theirs)
      const base = yield* store.mergeBase(ours, theirs)
      const none: Listing = new Map()
      const [baseList, oursList, theirsList] = yield* Effect.all(
        [
          Option.match(base, {
            onNone: () => Effect.succeed(none),
            onSome: store.list,
          }),
          store.list(ours),
          store.list(theirs),
        ],
        { concurrency: 'unbounded' },
      )

      const ids = new Set<TicketId>()
      for (const list of [baseList, oursList, theirsList]) {
        for (const path of list.keys()) {
          for (const folder of ['tickets', 'tombstones']) {
            for (const id of Option.toArray(ticketOfPath(path, folder)))
              ids.add(id)
          }
        }
      }

      const merged = new Map<string, string>()
      // What isn't a ticket's stays: ours, or theirs where ours hasn't it.
      for (const list of [theirsList, oursList]) {
        for (const [path, hash] of list) {
          if (
            Option.isNone(ticketOfPath(path, 'tickets')) &&
            Option.isNone(ticketOfPath(path, 'tombstones'))
          )
            merged.set(path, hash)
        }
      }

      const key = (
        entry: Option.Option<{
          readonly hash: string
          readonly deleted: boolean
        }>,
      ) =>
        Option.match(entry, {
          onNone: () => '',
          onSome: ({ hash, deleted }) => `${deleted ? 'd' : 'l'}${hash}`,
        })

      interface Contest {
        readonly id: TicketId
        readonly base: ReturnType<typeof entryAt>
        readonly ours: ReturnType<typeof entryAt>
        readonly theirs: ReturnType<typeof entryAt>
      }
      const contests: Array<Contest> = []
      const touched = new Set<TicketId>()
      for (const id of ids) {
        const b = entryAt(baseList, id)
        // A side missing a ticket the base has live keeps the base's: only a tombstone deletes one.
        const baseLive = Option.filter(b, entry => !entry.deleted)
        const o = Option.orElse(entryAt(oursList, id), () => baseLive)
        const t = Option.orElse(entryAt(theirsList, id), () => baseLive)
        if (key(o) !== key(b) || key(t) !== key(b)) touched.add(id)
        const take = (entry: ReturnType<typeof entryAt>) => {
          if (Option.isSome(entry))
            merged.set(entry.value.path, entry.value.hash)
        }
        if (key(o) === key(t) || key(t) === key(b)) take(o)
        else if (key(o) === key(b)) take(t)
        else contests.push({ id, base: b, ours: o, theirs: t })
      }

      const hashes = contests.flatMap(contest =>
        [contest.base, contest.ours, contest.theirs].flatMap(entry =>
          Option.toArray(Option.map(entry, ({ hash }) => hash)),
        ),
      )
      const blobs = yield* store.readBlobs(hashes)

      const readEntry = (
        id: TicketId,
        entry: ReturnType<typeof entryAt>,
      ): Effect.Effect<Read<Option.Option<Entry>>> =>
        Option.match(entry, {
          onNone: () => Effect.succeed(good(Option.none<Entry>())),
          onSome: ({ hash, deleted }) => {
            const bytes = blobs.get(hash)
            if (bytes === undefined)
              return Effect.succeed(
                bad<Option.Option<Entry>>(`${hash} is missing`),
              )
            return deleted
              ? Effect.map(
                  readTombstone(id, bytes),
                  (read): Read<Option.Option<Entry>> =>
                    read._tag === 'Good'
                      ? good(
                          Option.some(Entry.Deleted({ tombstone: read.value })),
                        )
                      : bad(read.reason),
                )
              : Effect.map(
                  readTicketFile(id, bytes),
                  (read): Read<Option.Option<Entry>> =>
                    read._tag === 'Good'
                      ? good(Option.some(Entry.Live({ file: read.value })))
                      : bad(read.reason),
                )
          },
        })

      const pending: Array<PendingChange> = []
      const mergedFiles = new Map<TicketId, TicketFile>()
      for (const contest of contests) {
        const [baseRead, oursRead, theirsRead] = yield* Effect.all([
          readEntry(contest.id, contest.base),
          readEntry(contest.id, contest.ours),
          readEntry(contest.id, contest.theirs),
        ])
        if (oursRead._tag === 'Bad' || theirsRead._tag === 'Bad') {
          // A file that doesn't decode stays on the ref as it is, the same one on either engine: a
          // newer engine's is never written over, and the import quarantines it.
          const kept = [
            ...(oursRead._tag === 'Bad' ? Option.toArray(contest.ours) : []),
            ...(theirsRead._tag === 'Bad'
              ? Option.toArray(contest.theirs)
              : []),
          ].sort((a, b) => (a.hash < b.hash ? -1 : 1))[0]
          if (kept !== undefined) merged.set(kept.path, kept.hash)
          continue
        }
        const result = mergeEntry({
          base: baseRead._tag === 'Good' ? baseRead.value : Option.none(),
          ours: oursRead.value,
          theirs: theirsRead.value,
        })
        for (const conflict of result.conflicts)
          pending.push({
            ticket: contest.id,
            change: conflictChange(conflict),
          })
        if (Option.isNone(result.entry)) continue
        yield* Entry.$match(result.entry.value, {
          Live: ({ file }) =>
            Effect.gen(function* () {
              mergedFiles.set(contest.id, file)
              const text = yield* encodeTicketFile(file).pipe(
                Effect.mapError(storeFailed('merging a ticket')),
              )
              merged.set(ticketPath(contest.id), yield* store.writeBlob(text))
            }),
          Deleted: ({ tombstone }) =>
            Effect.gen(function* () {
              const text = yield* encodeTombstone(tombstone).pipe(
                Effect.mapError(storeFailed('merging a tombstone')),
              )
              merged.set(
                tombstonePath(contest.id),
                yield* store.writeBlob(text),
              )
            }),
        })
      }

      // Edges to what is gone, in the files either side changed.
      const liveIds = new Set<string>(
        [...merged.keys()].flatMap(path =>
          Option.toArray(ticketOfPath(path, 'tickets')),
        ),
      )
      const candidates = [...touched].filter(
        id => merged.has(ticketPath(id)) && !mergedFiles.has(id),
      )
      const candidateBytes = yield* store.readBlobs(
        candidates.flatMap(id => {
          const hash = merged.get(ticketPath(id))
          return hash === undefined ? [] : [hash]
        }),
      )
      const filesToCheck = new Map(mergedFiles)
      for (const id of candidates) {
        const hash = merged.get(ticketPath(id))
        const bytes = hash === undefined ? undefined : candidateBytes.get(hash)
        if (bytes === undefined) continue
        const read = yield* readTicketFile(id, bytes)
        if (read._tag === 'Good') filesToCheck.set(id, read.value)
      }
      for (const [id, file] of filesToCheck) {
        const keep = (targets: ReadonlyArray<TicketId>) =>
          targets.filter(target => liveIds.has(target))
        const edges = {
          blocks: keep(file.edges.blocks),
          discovered_from: keep(file.edges.discovered_from),
          parent: keep(file.edges.parent),
          related: keep(file.edges.related),
        }
        const dropped = edgeKinds.flatMap(kind =>
          file.edges[kind]
            .filter(target => !liveIds.has(target))
            .map(to => new Edge({ from: id, to, kind })),
        )
        if (dropped.length === 0) continue
        for (const edge of dropped)
          pending.push({
            ticket: id,
            change: { _tag: 'edge_dropped', edge },
          })
        const text = yield* encodeTicketFile(
          new TicketFile({ ...file, edges }),
        ).pipe(Effect.mapError(storeFailed('merging a ticket')))
        merged.set(ticketPath(id), yield* store.writeBlob(text))
      }

      // The lease and `meta.json`, where the sides differ.
      yield* mergeSingles({ merged, baseList, oursList, theirsList })

      const changed = [...ids].filter(id => {
        const path = ticketPath(id)
        const grave = tombstonePath(id)
        return (
          merged.get(path) !== oursList.get(path) ||
          merged.get(grave) !== oursList.get(grave)
        )
      }).length
      const tree = yield* store.writeTree(merged)
      const commit = yield* store.commitTree({
        tree,
        parents: [ours, theirs],
        message: `tickets: ${changed} changed (${engine})`,
        engine,
      })
      yield* local.keepPending(commit, pending)
      return commit
    })

  /** `lease.json` and `meta.json` merged where the sides differ; one that doesn't decode counts as none. */
  const mergeSingles = ({
    merged,
    baseList,
    oursList,
    theirsList,
  }: {
    readonly merged: Map<string, string>
    readonly baseList: Listing
    readonly oursList: Listing
    readonly theirsList: Listing
  }) =>
    Effect.gen(function* () {
      const readSingle = <A, E extends { readonly message: string }>(
        list: Listing,
        path: string,
        decode: (bytes: Uint8Array) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          const hash = list.get(path)
          if (hash === undefined) return Option.none<A>()
          const bytes = (yield* store.readBlobs([hash])).get(hash)
          if (bytes === undefined) return Option.none<A>()
          const read = yield* readRecord(decode(bytes))
          return read._tag === 'Good'
            ? Option.some(read.value)
            : Option.none<A>()
        })
      if (oursList.get(leasePath) !== theirsList.get(leasePath)) {
        const lease = mergeLease({
          base: yield* readSingle(baseList, leasePath, decodeLease),
          ours: yield* readSingle(oursList, leasePath, decodeLease),
          theirs: yield* readSingle(theirsList, leasePath, decodeLease),
        })
        merged.delete(leasePath)
        if (Option.isSome(lease))
          merged.set(
            leasePath,
            yield* store.writeBlob(
              yield* encodeLease(lease.value).pipe(
                Effect.mapError(storeFailed('merging the lease')),
              ),
            ),
          )
      }
      if (oursList.get(metaPath) !== theirsList.get(metaPath)) {
        const meta = mergeMeta({
          base: yield* readSingle(baseList, metaPath, decodeMeta),
          ours: yield* readSingle(oursList, metaPath, decodeMeta),
          theirs: yield* readSingle(theirsList, metaPath, decodeMeta),
        })
        if (Option.isSome(meta))
          merged.set(
            metaPath,
            yield* store.writeBlob(
              yield* encodeMeta(meta.value).pipe(
                Effect.mapError(storeFailed('merging meta.json')),
              ),
            ),
          )
      }
    })

  // --- Import ----------------------------------------------------------------------------------

  /** Reads what differs between two commits and writes it in one transaction, then records the commit. */
  const importCommit = ({
    from,
    to,
    seen,
    clock,
    replace,
  }: {
    readonly from: Option.Option<CommitHash>
    readonly to: CommitHash
    readonly seen: Option.Option<number>
    readonly clock: Hlc
    readonly replace: boolean
  }) =>
    Effect.gen(function* () {
      const listing = yield* store.list(to)
      const paths = yield* Option.match(from, {
        onNone: () => Effect.succeed([...listing.keys()]),
        onSome: start =>
          Effect.map(store.changedBetween(start, to), changed =>
            changed.filter(file => !file.removed).map(file => file.path),
          ),
      })
      const bytes = yield* store.readBlobs(
        paths.flatMap(path => {
          const hash = listing.get(path)
          return hash === undefined ? [] : [hash]
        }),
      )
      const files: Array<TicketFile> = []
      const tombstones: Array<Tombstone> = []
      const quarantined: Array<QuarantinedFile> = []
      let lastClock = clock
      for (const [index, path] of paths.entries()) {
        if (index % 200 === 199) yield* Effect.yieldNow
        const hash = listing.get(path)
        const blob = hash === undefined ? undefined : bytes.get(hash)
        if (blob === undefined) continue
        const live = ticketOfPath(path, 'tickets')
        const dead = ticketOfPath(path, 'tombstones')
        if (Option.isSome(live)) {
          const read = yield* readTicketFile(live.value, blob)
          if (read._tag === 'Good') {
            files.push(read.value)
            lastClock = pastClocks(lastClock, read.value)
          } else quarantined.push({ path, ticket: live, reason: read.reason })
        } else if (Option.isSome(dead)) {
          const read = yield* readTombstone(dead.value, blob)
          if (read._tag === 'Good') {
            tombstones.push(read.value)
            lastClock = later(lastClock, read.value.clock)
          } else quarantined.push({ path, ticket: dead, reason: read.reason })
        } else if (path === metaPath) {
          const read = yield* decodeMeta(blob).pipe(
            Effect.map(() => good(undefined)),
            Effect.catchTags({
              RecordUndecodable: error =>
                Effect.succeed(bad<undefined>(error.message)),
              RecordTooNew: error =>
                Effect.succeed(bad<undefined>(error.message)),
            }),
          )
          if (read._tag === 'Bad')
            quarantined.push({
              path,
              ticket: Option.none(),
              reason: read.reason,
            })
        } else if (path === leasePath) {
          const read = yield* readRecord(decodeLease(blob))
          if (read._tag === 'Bad')
            quarantined.push({
              path,
              ticket: Option.none(),
              reason: read.reason,
            })
        }
      }
      const pending = yield* local.pendingCommits
      const merges = yield* Effect.filter(pending, commit =>
        store.isAncestor(commit, to),
      )
      const applied = yield* local.applyImport({
        to,
        seen,
        files,
        tombstones,
        quarantined,
        lastClock,
        merges,
        replace,
      })
      for (const edge of applied.droppedEdges)
        yield* Effect.logWarning(
          `tickets sync dropped the ${edge.kind} link from ${edge.from} to ${edge.to}: ${edge.to} is gone`,
        )
      for (const file of quarantined)
        yield* Effect.logWarning(
          `tickets sync quarantined ${file.path}: ${file.reason}`,
        )
      return { changed: applied.changed, files, tombstones, quarantined }
    })

  // --- The cycles ------------------------------------------------------------------------------

  /** Moves the ref to `to`, where it isn't there; a stale move drops the merge kept for it. */
  const moveTo = ({
    to,
    head,
    merge,
  }: {
    readonly to: CommitHash
    readonly head: Option.Option<CommitHash>
    readonly merge: Option.Option<CommitHash>
  }) =>
    Effect.gen(function* () {
      if (Option.getOrUndefined(head) === to) return RefMove.Moved()
      const moved = yield* store.moveRef({ to, expected: head })
      if (moved._tag === 'Stale' && Option.isSome(merge))
        yield* local.dropPending(merge.value)
      return moved
    })

  /** Where a commit and the ref come to: one in the other's history, or a merge; and the merge's commit. */
  const reconcile = ({
    ours,
    theirs,
  }: {
    readonly ours: CommitHash
    readonly theirs: CommitHash
  }) =>
    Effect.gen(function* () {
      const base = yield* store.mergeBase(ours, theirs)
      if (Option.exists(base, commit => commit === theirs))
        return { to: ours, merge: Option.none<CommitHash>() }
      if (Option.exists(base, commit => commit === ours)) {
        yield* checkLayout(theirs)
        return { to: theirs, merge: Option.none<CommitHash>() }
      }
      const merge = yield* mergeCommits({ ours, theirs })
      return { to: merge, merge: Option.some(merge) }
    })

  /** One cycle over the store and the local ref; none when it is to run again. */
  const settleOnce = Effect.gen(function* () {
    const state = yield* local.readState
    const seq = yield* local.lastSeq
    const head = yield* store.head
    const imported = state.lastImported
    const listing = yield* Option.match(imported, {
      onNone: () => Effect.succeed<Listing>(new Map()),
      onSome: store.list,
    })
    const made = yield* exportLocal({ state, listing })
    const ours = Option.isSome(made) ? Option.some(made.value.commit) : imported
    if (sameCommit(ours, head)) {
      if (seq !== state.exportedSeq) yield* local.recordSeen(seq)
      return Option.some<Settled>(nothingSettled)
    }
    // They differ, so at least one of them is a commit.
    const { to, merge } = yield* Option.match(head, {
      onNone: () =>
        Effect.succeed({
          to: Option.getOrElse(ours, () => undefined),
          merge: Option.none<CommitHash>(),
        }),
      onSome: theirs =>
        Option.match(ours, {
          onNone: () =>
            Effect.succeed({ to: theirs, merge: Option.none<CommitHash>() }),
          onSome: commit => reconcile({ ours: commit, theirs }),
        }),
    })
    if (to === undefined) return Option.some<Settled>(nothingSettled)
    const moved = yield* moveTo({ to, head, merge })
    if (moved._tag === 'Stale') return Option.none<Settled>()
    const committed = Option.isSome(made)
    if (
      Option.isSome(made) &&
      made.value.commit === to &&
      sameCommit(head, imported)
    ) {
      yield* local.recordExport({
        commit: to,
        seq,
        files: made.value.files,
        lastClock: made.value.clock,
      })
      return Option.some<Settled>({ committed, imported: 0 })
    }
    return yield* importCommit({
      from: imported,
      to,
      seen: Option.some(seq),
      clock: Option.match(made, {
        onNone: () => state.lastClock,
        onSome: ({ clock }) => clock,
      }),
      replace: false,
    }).pipe(
      Effect.map(({ changed }) =>
        Option.some<Settled>({ committed, imported: changed }),
      ),
      Effect.catchTag('LocalMoved', () =>
        Effect.succeed(Option.none<Settled>()),
      ),
    )
  })

  /** Runs a cycle until it holds, within its tries. */
  const untilHeld = <A, E>(cycle: Effect.Effect<Option.Option<A>, E>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < cycleTries; attempt += 1) {
        const held = yield* cycle
        if (Option.isSome(held)) return held.value
      }
      return yield* new SyncBusy()
    })

  const settle = untilHeld(settleOnce)

  const commit: TicketsSyncShape['commit'] = lock
    .withPermit(Effect.andThen(prepare, settle))
    .pipe(Effect.withSpan('TicketsSync.commit'))

  /** Merges the fetched commit into the local ref. */
  const mergeFetched = (fetched: CommitHash) =>
    untilHeld(
      Effect.gen(function* () {
        const head = yield* store.head
        const { to, merge } = yield* Option.match(head, {
          onNone: () =>
            Effect.map(checkLayout(fetched), () => ({
              to: fetched,
              merge: Option.none<CommitHash>(),
            })),
          onSome: ours => reconcile({ ours, theirs: fetched }),
        })
        const moved = yield* moveTo({ to, head, merge })
        return moved._tag === 'Stale'
          ? Option.none<void>()
          : Option.some(undefined)
      }),
    )

  const pullLocked = (remote: string) =>
    Effect.gen(function* () {
      yield* settle
      const fetched = yield* store.fetch(remote)
      return yield* RefFetch.$match(fetched, {
        Absent: () => Effect.succeed(Pulled.Absent()),
        Unreachable: ({ message }) =>
          Effect.succeed(Pulled.Unreachable({ message })),
        Fetched: ({ commit: remoteHead }) =>
          Effect.gen(function* () {
            yield* mergeFetched(remoteHead)
            const { imported } = yield* settle
            return Pulled.Merged({ imported })
          }),
      })
    })

  const pushLocked = (remote: string) =>
    Effect.gen(function* () {
      yield* settle
      const state = yield* local.readState
      const head = yield* store.head
      if (Option.isNone(head) || sameCommit(state.lastPushed, head))
        return PushOutcome.UpToDate()
      if (!Option.contains(state.namedRemote, remote))
        yield* local.nameRemote(remote, yield* store.remoteUrl(remote))
      const pushed = yield* store.push({ remote, commit: head.value })
      if (pushed._tag === 'Pushed' || pushed._tag === 'UpToDate')
        yield* local.setPushed(head.value)
      return pushed
    })

  const pull: TicketsSyncShape['pull'] = Effect.fn('TicketsSync.pull')(remote =>
    lock.withPermit(Effect.andThen(prepare, pullLocked(remote))),
  )

  const push: TicketsSyncShape['push'] = Effect.fn('TicketsSync.push')(remote =>
    lock.withPermit(Effect.andThen(prepare, pushLocked(remote))),
  )

  const sync: TicketsSyncShape['sync'] = Effect.fn('TicketsSync.sync')(remote =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* prepare
        let pulled = yield* pullLocked(remote)
        for (let attempt = 0; attempt < cycleTries; attempt += 1) {
          if (pulled._tag === 'Unreachable')
            return {
              pulled,
              pushed: PushOutcome.Failed({ message: pulled.message }),
            }
          const pushed = yield* pushLocked(remote)
          if (pushed._tag !== 'NotFastForward') return { pulled, pushed }
          pulled = yield* pullLocked(remote)
        }
        return yield* new SyncBusy()
      }),
    ),
  )

  const rebuild: TicketsSyncShape['rebuild'] = lock
    .withPermit(
      Effect.gen(function* () {
        yield* prepare
        const head = yield* store.head
        if (Option.isNone(head)) return yield* new NoTicketsRef()
        yield* checkLayout(head.value)
        const state = yield* local.readState
        const { files, tombstones, quarantined } = yield* importCommit({
          from: Option.none(),
          to: head.value,
          seen: Option.none(),
          clock: state.lastClock,
          replace: true,
        }).pipe(
          // Only an import with a state to compare is refused.
          Effect.catchTag('LocalMoved', Effect.die),
        )
        return {
          tickets: files.length,
          tombstones: tombstones.length,
          quarantined: quarantined.length,
        }
      }),
    )
    .pipe(Effect.withSpan('TicketsSync.rebuild'))

  return {
    commit,
    pull,
    push,
    sync,
    rebuild,
    state: local.readState,
  } satisfies TicketsSyncShape
})

// --- Commits as the store changes ------------------------------------------------------------------

/** How long changes wait to be committed together, at most (§11.3). */
export const commitBatch = '2 seconds'

const transitionChanges: ReadonlySet<TicketChange['_tag']> = new Set([
  'claimed',
  'released',
  'closed',
  'answered',
])

/** Whether an event is one of a run's transitions, committed at once (§11.3): a claim, a close, a merge, a question asked or answered. */
const isTransition = (
  graph: WorkGraphShape,
  { change, ticketId }: TicketEvent,
): Effect.Effect<boolean> =>
  transitionChanges.has(change._tag)
    ? Effect.succeed(true)
    : change._tag === 'updated'
      ? Effect.succeed(change.fields.includes('mergedCommit'))
      : change._tag === 'created'
        ? Option.match(ticketId, {
            onNone: () => Effect.succeed(false),
            onSome: id =>
              graph.show(id).pipe(
                Effect.map(({ ticket }) => ticket.type === 'question'),
                Effect.orElseSucceed(() => false),
              ),
          })
        : Effect.succeed(false)

/**
 * Commits the store's changes as they come, until the stream ends: a batch at most 2 s after its first
 * change, at once on a run's transition. A commit that stops says why and waits for the next change.
 */
export const commitChanges = Effect.fn('TicketsSync.commitChanges')(function* ({
  graph,
  changes,
  commit,
}: {
  readonly graph: WorkGraphShape
  readonly changes: Stream.Stream<TicketEvent, StoreFailed>
  readonly commit: Effect.Effect<unknown, SyncStopped>
}) {
  const scope = yield* Effect.scope
  const timer = yield* Ref.make(Option.none<Fiber.Fiber<void>>())
  const commitLogged = commit.pipe(
    Effect.catch(error =>
      Effect.logWarning(`the tickets ref wasn't committed: ${error.message}`),
    ),
    Effect.asVoid,
  )
  const cancelTimer = Effect.flatMap(
    Ref.getAndSet(timer, Option.none()),
    Option.match({
      onNone: () => Effect.void,
      onSome: Fiber.interrupt,
    }),
  )
  const afterBatch = Effect.gen(function* () {
    if (Option.isSome(yield* Ref.get(timer))) return
    const fiber = yield* Effect.sleep(commitBatch).pipe(
      Effect.andThen(Ref.set(timer, Option.none())),
      Effect.andThen(commitLogged),
      Effect.forkIn(scope),
    )
    yield* Ref.set(timer, Option.some(fiber))
  })
  yield* changes.pipe(
    Stream.runForEach(event =>
      Effect.flatMap(isTransition(graph, event), atOnce =>
        atOnce ? Effect.andThen(cancelTimer, commitLogged) : afterBatch,
      ),
    ),
  )
})

export type TicketsSync = Effect.Success<ReturnType<typeof makeTicketsSync>>
