import { Data, Effect, Match, Option } from 'effect'

import {
  type CommitHash,
  type ProjectOrigin,
  type Push,
  defaultPush,
} from '@fabrica/contracts'

import {
  type CantTell,
  FastForwardOutcome,
  FetchOutcome,
  Git,
  type GitFailed,
  LfsUpload,
  PushOutcome,
  trackingName,
} from '../git'
import { shortCommit } from '../runlog'

// Base, fetching and pushing (spec §10.3, H10): before a run, Base is fetched from its upstream and
// fast-forwarded where the upstream moved and Base has no commits of its own; diverged, the run starts
// on Base as it is and says so (`BASE_DIVERGED`). Base is pushed to its upstream as the project's `push`
// says: never, once the run's full check passes (`after_run`), or after each merge (`after_merge`). A
// push that isn't a fast-forward is not made and is reported (`PUSH_REFUSED`); the engine never forces.
// The run calls these through the ports its start, its end and the merge queue's close expose.

/** What fetching Base's upstream before a run came to. */
export type BaseSynced = Data.TaggedEnum<{
  /** Base has no upstream: nothing to fetch. */
  NoUpstream: {}
  /** Base is at its upstream's commit, `commit`. */
  UpToDate: { readonly upstream: string; readonly commit: CommitHash }
  /** The upstream moved and Base had no commits of its own: Base is fast-forwarded from `from` to `to`. */
  FastForwarded: {
    readonly upstream: string
    readonly from: CommitHash
    readonly to: CommitHash
  }
  /** Base has commits of its own, and the upstream hasn't moved: Base stays as it is, at `commit`. */
  Ahead: { readonly upstream: string; readonly commit: CommitHash }
  /** Base, at `base`, and its upstream, at `theirs`, each have commits the other hasn't: Base stays as it is. */
  Diverged: {
    readonly upstream: string
    readonly base: CommitHash
    readonly theirs: CommitHash
  }
  /** The fetch or the fast-forward couldn't be made, or git's answers read: Base stays as it is. */
  NotSynced: { readonly reason: string }
}>
export const BaseSynced = Data.taggedEnum<BaseSynced>()

/** What pushing Base to its upstream came to. */
export type BasePushed = Data.TaggedEnum<{
  /** Base has no upstream to push to. */
  NoUpstream: {}
  /** The upstream is at Base's commit, `commit`, now. */
  Pushed: { readonly upstream: string; readonly commit: CommitHash }
  /** The upstream was at Base's commit, `commit`, already. */
  UpToDate: { readonly upstream: string; readonly commit: CommitHash }
  /** Not made: not a fast-forward, or the remote refused it; `reason` is git's or the remote's. */
  Refused: {
    readonly upstream: string
    readonly commit: CommitHash
    readonly reason: string
  }
  /** Git couldn't push, or its answers couldn't be read. */
  NotPushed: { readonly reason: string }
}>
export const BasePushed = Data.taggedEnum<BasePushed>()

/** Where a run's step may push Base: at the run's end, once its full check passed, or after a merge. */
export type PushMoment = 'after_run' | 'after_merge'

/** The project's `push`, its origin's default where its settings give none. */
export const pushSetting = (
  push: Option.Option<Push>,
  origin: ProjectOrigin,
): Push => Option.getOrElse(push, () => defaultPush(origin))

/** Whether `push` pushes Base at `moment`. */
export const pushesAt = (push: Push, moment: PushMoment): boolean =>
  push === moment

/** A failure of git's as words. */
const failure = (error: CantTell | GitFailed): string =>
  Match.valueTags(error, {
    CantTell: ({ read, reason }) => `can't tell ${read}: ${reason}`,
    GitFailed: ({ command, reason }) => `git ${command}: ${reason}`,
  })

/**
 * Fetches Base's upstream into the checkout `checkout`, where Base is checked out, and fast-forwards Base
 * to it if the upstream moved and Base has no commits of its own.
 */
export const syncBase = Effect.fn('BaseSync.sync')(function* ({
  checkout,
  base,
}: {
  readonly checkout: string
  readonly base: string
}) {
  const git = yield* Git
  return yield* Effect.gen(function* () {
    const found = yield* git.upstream({ repo: checkout, branch: base })
    if (Option.isNone(found)) return BaseSynced.NoUpstream()
    const { remote, ref, tracking } = found.value
    const upstream = trackingName(tracking)
    // An upstream in the same repository (`.`) has nothing to fetch.
    if (remote !== '.') {
      const fetched = yield* git.fetch({ repo: checkout, remote, ref })
      if (FetchOutcome.$is('Failed')(fetched))
        return BaseSynced.NotSynced({
          reason: `${upstream} couldn't be fetched: ${fetched.message}`,
        })
    }
    const [ours, theirs] = yield* Effect.all(
      [
        git.commitHash({ repo: checkout, revision: `refs/heads/${base}` }),
        git.commitHash({ repo: checkout, revision: tracking }),
      ],
      { concurrency: 'unbounded' },
    )
    if (Option.isNone(ours))
      return BaseSynced.NotSynced({ reason: `${base} has no commit` })
    if (Option.isNone(theirs))
      return BaseSynced.NotSynced({
        reason: `${upstream} names no commit once fetched`,
      })
    if (ours.value === theirs.value)
      return BaseSynced.UpToDate({ upstream, commit: ours.value })
    const [behind, ahead] = yield* Effect.all(
      [
        git.isOnBase({
          repo: checkout,
          branch: ours.value,
          base: theirs.value,
        }),
        git.isOnBase({
          repo: checkout,
          branch: theirs.value,
          base: ours.value,
        }),
      ],
      { concurrency: 'unbounded' },
    )
    if (ahead) return BaseSynced.Ahead({ upstream, commit: ours.value })
    if (!behind)
      return BaseSynced.Diverged({
        upstream,
        base: ours.value,
        theirs: theirs.value,
      })
    const forwarded = yield* git.fastForward({
      checkout,
      base,
      to: theirs.value,
    })
    const notForwarded = (why: string) =>
      BaseSynced.NotSynced({
        reason: `${base} couldn't be fast-forwarded to ${upstream}: ${why}`,
      })
    return FastForwardOutcome.$match(forwarded, {
      FastForwarded: ({ from, to }) =>
        BaseSynced.FastForwarded({ upstream, from, to }),
      NotFastForward: ({ base: at }) =>
        notForwarded(`${base} moved to ${shortCommit(at)} meanwhile`),
      OffBranch: ({ branch }) =>
        notForwarded(
          Option.match(branch, {
            onNone: () => 'the checkout is on no branch',
            onSome: other => `the checkout is on ${other}`,
          }),
        ),
      Refused: ({ message }) => notForwarded(message),
    })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(BaseSynced.NotSynced({ reason: failure(error) })),
    ),
  )
})

/** Uploads the git-lfs objects of the commits a push would bring `remote`; why not, where they couldn't be. */
const uploadPointers = Effect.fnUntraced(function* ({
  checkout,
  base,
  remote,
  commit,
}: {
  readonly checkout: string
  readonly base: string
  readonly remote: string
  readonly commit: CommitHash
}) {
  const git = yield* Git
  // An upstream in the same repository already has the objects.
  if (remote === '.') return Option.none<string>()
  const holds = yield* git.holdsLfsPointers({ repo: checkout, commit, remote })
  if (!holds) return Option.none<string>()
  const commands = yield* git.lfsTransferCommands({ repo: checkout })
  if (commands.length > 0)
    return Option.some(
      `${base} holds git-lfs files, and the repository's configuration makes git-lfs run a command (${commands.join(', ')}), which the engine doesn't run: unset it, or push by hand`,
    )
  const uploaded = yield* git.uploadLfs({ repo: checkout, remote, commit })
  return LfsUpload.$match(uploaded, {
    Uploaded: () => Option.none<string>(),
    NotInstalled: () =>
      Option.some(
        `${base} holds git-lfs files, and git-lfs isn't installed here to upload them: install it, or push by hand`,
      ),
    Failed: ({ message }) =>
      Option.some(`git-lfs couldn't upload ${base}'s files: ${message}`),
  })
})

/** Pushes Base, checked out in `checkout`, to its upstream: its commit as read now, never forced. */
export const pushBase = Effect.fn('BaseSync.push')(function* ({
  checkout,
  base,
}: {
  readonly checkout: string
  readonly base: string
}) {
  const git = yield* Git
  return yield* Effect.gen(function* () {
    const [found, commit] = yield* Effect.all(
      [
        git.upstream({ repo: checkout, branch: base }),
        git.commitHash({ repo: checkout, revision: `refs/heads/${base}` }),
      ],
      { concurrency: 'unbounded' },
    )
    if (Option.isNone(found)) return BasePushed.NoUpstream()
    if (Option.isNone(commit))
      return BasePushed.NotPushed({ reason: `${base} has no commit` })
    const { remote, ref, tracking } = found.value
    const upstream = trackingName(tracking)
    // git-lfs uploads in its pre-push hook, which the engine's git doesn't run (§10.3, §20.2), so the
    // engine uploads first: the ref would land pointing at objects the remote doesn't have.
    const uploadFailed = yield* uploadPointers({
      checkout,
      base,
      remote,
      commit: commit.value,
    })
    if (Option.isSome(uploadFailed))
      return BasePushed.NotPushed({ reason: uploadFailed.value })
    const pushed = yield* git.push({
      repo: checkout,
      remote,
      commit: commit.value,
      ref,
    })
    return PushOutcome.$match(pushed, {
      Pushed: () => BasePushed.Pushed({ upstream, commit: commit.value }),
      UpToDate: () => BasePushed.UpToDate({ upstream, commit: commit.value }),
      NotFastForward: ({ reason }) =>
        BasePushed.Refused({
          upstream,
          commit: commit.value,
          reason: `not a fast-forward (${reason})`,
        }),
      Rejected: ({ reason }) =>
        BasePushed.Refused({
          upstream,
          commit: commit.value,
          reason: `the remote refused it (${reason})`,
        }),
      Failed: ({ message }) => BasePushed.NotPushed({ reason: message }),
    })
  }).pipe(
    Effect.catch(error =>
      Effect.succeed(BasePushed.NotPushed({ reason: failure(error) })),
    ),
  )
})

/** What the run says of a sync or a push: a warning under its tag, or progress. */
export type BaseNote = Data.TaggedEnum<{
  Warning: { readonly tag: string; readonly text: string }
  Progress: { readonly text: string }
}>
export const BaseNote = Data.taggedEnum<BaseNote>()

/** What the run says of Base's sync at its start; nothing where Base has no upstream. */
export const syncedNote = (
  synced: BaseSynced,
  base: string,
): Option.Option<BaseNote> =>
  BaseSynced.$match(synced, {
    NoUpstream: () => Option.none(),
    UpToDate: ({ upstream, commit }) =>
      Option.some(
        BaseNote.Progress({
          text: `start: ${base} is up to date with ${upstream} at ${shortCommit(commit)}`,
        }),
      ),
    FastForwarded: ({ upstream, from, to }) =>
      Option.some(
        BaseNote.Progress({
          text: `start: ${base} fast-forwarded to ${upstream}, ${shortCommit(from)}..${shortCommit(to)}`,
        }),
      ),
    Ahead: ({ upstream, commit }) =>
      Option.some(
        BaseNote.Progress({
          text: `start: ${base}, at ${shortCommit(commit)}, has commits of its own that ${upstream} hasn't`,
        }),
      ),
    Diverged: ({ upstream, base: ours, theirs }) =>
      Option.some(
        BaseNote.Warning({
          tag: 'BASE_DIVERGED',
          text: `${base} (${shortCommit(ours)}) and ${upstream} (${shortCommit(theirs)}) have diverged: the run starts on ${base} as it is`,
        }),
      ),
    NotSynced: ({ reason }) =>
      Option.some(
        BaseNote.Warning({
          tag: 'BASE_NOT_SYNCED',
          text: `${reason}: the run starts on ${base} as it is`,
        }),
      ),
  })

/** What the run says of a push of Base. */
export const pushedNote = (pushed: BasePushed, base: string): BaseNote =>
  BasePushed.$match(pushed, {
    NoUpstream: () =>
      BaseNote.Warning({
        tag: 'PUSH_FAILED',
        text: `${base} has no upstream to push to`,
      }),
    Pushed: ({ upstream, commit }) =>
      BaseNote.Progress({
        text: `pushed ${base} to ${upstream} at ${shortCommit(commit)}`,
      }),
    UpToDate: ({ upstream, commit }) =>
      BaseNote.Progress({
        text: `${upstream} has ${base}'s ${shortCommit(commit)} already`,
      }),
    Refused: ({ upstream, commit, reason }) =>
      BaseNote.Warning({
        tag: 'PUSH_REFUSED',
        text: `${base} (${shortCommit(commit)}) wasn't pushed to ${upstream}: ${reason}; the engine never forces`,
      }),
    NotPushed: ({ reason }) =>
      BaseNote.Warning({
        tag: 'PUSH_FAILED',
        text: `${base} couldn't be pushed: ${reason}`,
      }),
  })

/**
 * The pushes a run makes as `push` says, each said through `say`: `after_run` at its end, once its full
 * check passed, and `after_merge` after each merge; each does nothing where `push` is another.
 */
export const basePushes = Effect.fn('BaseSync.pushes')(function* (input: {
  readonly checkout: string
  readonly base: string
  readonly push: Push
  readonly say: (note: BaseNote) => Effect.Effect<void>
}) {
  const git = yield* Git
  const at = (moment: PushMoment): Effect.Effect<void> =>
    pushesAt(input.push, moment)
      ? pushBase({ checkout: input.checkout, base: input.base }).pipe(
          Effect.flatMap(pushed => input.say(pushedNote(pushed, input.base))),
          Effect.provideService(Git, git),
        )
      : Effect.void
  const pushes: Readonly<Record<PushMoment, Effect.Effect<void>>> = {
    after_run: at('after_run'),
    after_merge: at('after_merge'),
  }
  return pushes
})
