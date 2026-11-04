import { Data, Effect, Option, Ref, Schema } from 'effect'

import {
  type Actor,
  BreakdownAnswer,
  BreakdownEnvironmentKey,
  BreakdownRootKey,
  type FileRootParameters,
  FiledRoot,
  SpecCommitKey,
  SpecEnvironmentKey,
  SpecSha256Key,
  type SpecTicketChange,
  type Ticket,
  type TicketId,
  ToolRefusal,
  type TreeItem,
  TreeItemType,
} from '@fabrica/contracts'

import { writeFileWhole } from '../files'
import { Git, type GitShape } from '../git'
import type { OrganRuntime } from '../organs'
import { OrganOutcome } from '../organs'
import { record } from '../run/records'
import { type RunLog, warningLine } from '../runlog'
import {
  TreeRefused,
  type WorkGraphShape,
  fileTree,
  treeProblems,
} from '../workgraph'
import type { CommittedSpec } from './read'
import { narrowWarning, treeShape } from './shape'
import { SpecState, treeUnder } from './state'

// The spec breakdown (spec §15.5, §16): an organ's session with read tools and `file_root`. It files the
// root epic and, when the spec needs a tool the machine lacks or the repository has no code, the
// environment ticket (solo, priority 0, every other ticket waiting on it), so that the run starts on
// that ticket while it goes on. The rest of the tree is its answer, checked whole with what is filed
// (`treeProblems`) and given back with every reason; a tree that passes is filed in one transaction,
// and the version of the spec it was filed for is set last of all. Its cost, turns and session are the
// organ's record; at the usage limit it waits as the organ runtime's calls do, its time limit paused.

/** The most trees a breakdown may have refused before it is given up: each comes back with every reason. */
const treeRefusals = 5

/** What an update's breakdown reads, under the checkout's ignored run folder. */
export const specUpdateFile = '.fabrica/run/spec-update.md'

/** How a breakdown ended. */
export type BreakdownEnd = Data.TaggedEnum<{
  Filed: { readonly root: TicketId }
  /** Nothing more was filed: `reason` says why, for the run's stop. */
  NotFiled: { readonly reason: string }
}>
export const BreakdownEnd = Data.taggedEnum<BreakdownEnd>()

const instructions = [
  "You break a spec down into tickets, which Fabrica's workers then carry out with nobody there. Nobody answers questions: where the spec leaves a choice open, take its most conservative reading and write it into the tickets that rest on it, as `Assumed: …`.",
  'Read the spec whole, and the README and the code there is. You have read tools and two tools of your own, and you change nothing else.',
  "First call file_root, once: the root epic, summing the spec up, and, when the spec needs a tool the machine lacks or the repository has no code, the environment ticket. That ticket writes the project's requires list and its pins, scaffolds, and installs the dependencies with setup; it installs no machine tools as ticket work. The run starts on it at once, while you go on.",
  `Then end through answer, with the rest of the tree: an epic for each part of the spec where it has parts, and the tickets under them. Name the root epic by the key "${BreakdownRootKey}" and the environment ticket by "${BreakdownEnvironmentKey}"; every ticket waits on that one without your saying so.`,
  "Each ticket is one session of work. Its description opens with the detail and cites the sections of the spec it builds; it names the files it will change. Make a ticket wait on another only where it builds on that code: a chain over 3, or a tree narrower than the run's concurrency, keeps workers waiting on one another.",
  'A tree that fails its check is refused with every reason, and nothing of it is filed: correct them all and answer again.',
].join('\n\n')

/** The key a ticket filed already goes by in the answer. */
export const filedKey = (id: TicketId): string =>
  `filed-${id.toLowerCase().replace(/[^a-z0-9-]/gu, '-')}`

const isEnvironment = (ticket: Ticket): boolean =>
  ticket.metadata[SpecEnvironmentKey] === true

const isTreeType = Schema.is(TreeItemType)

/** A line of what is filed, as the breakdown reads it. */
const treeLine = (ticket: Ticket, key: string): string =>
  `- ${key}: ${ticket.id} (${ticket.type}, ${ticket.status}) ${ticket.title}`

/** The key `ticket` goes by. */
const keyOf = (ticket: Ticket): string =>
  isEnvironment(ticket) ? BreakdownEnvironmentKey : filedKey(ticket.id)

/** The item of the tree a ticket filed already is, to check what the answer adds with it. */
const filedItem = (
  ticket: Ticket,
  parent: Option.Option<string>,
): TreeItem => ({
  key: Option.isNone(parent) ? BreakdownRootKey : keyOf(ticket),
  type: isTreeType(ticket.type) ? ticket.type : 'task',
  title: ticket.title,
  description: '',
  design: Option.none(),
  acceptance: Option.none(),
  priority: Option.some(ticket.priority),
  files:
    ticket.type === 'epic' ? Option.none() : Option.some('unknown' as const),
  labels: Option.none(),
  parent,
  waitsOn: Option.none(),
})

/** What is amiss with a change, which only an open ticket under the root may take. */
const changeProblems = (
  changes: ReadonlyArray<SpecTicketChange>,
  tree: ReadonlyArray<Ticket>,
): ReadonlyArray<string> =>
  changes.flatMap(({ ticket }) => {
    const found = tree.find(({ id }) => id === ticket)
    if (found === undefined) return [`the change's ${ticket} isn't in the tree`]
    return found.status === 'open'
      ? []
      : [`${ticket} is ${found.status}: only an open ticket changes`]
  })

/** The text of a breakdown's first message, for the state it starts from. */
const promptOf = Effect.fnUntraced(function* (input: {
  readonly spec: CommittedSpec
  readonly state: SpecState
  readonly checkout: string
  readonly graph: WorkGraphShape
  readonly git: GitShape
}) {
  const { spec, state, checkout, graph, git } = input
  const names = `The spec is ${spec.path} in the project's checkout, its SHA-256 ${spec.sha256}, committed as ${spec.commit}.`
  const tree = (root: TicketId) =>
    Effect.map(treeUnder({ graph, root }), ({ tickets }) =>
      tickets
        .filter(ticket => isTreeType(ticket.type))
        .map(ticket => treeLine(ticket, keyOf(ticket)))
        .join('\n'),
    )
  return yield* SpecState.$match(state, {
    New: () => Effect.succeed(`${names} Break it down.`),
    Unchanged: () => Effect.succeed(names),
    Unfinished: ({ root }) =>
      Effect.map(
        tree(root),
        filed =>
          `${names} An earlier breakdown filed its root epic ${root} and didn't finish: don't call file_root. Carry on: answer with what the tree still needs, naming what is filed by these keys.\n${filed}`,
      ),
    Changed: ({ root, filedFor, commit }) =>
      Effect.gen(function* () {
        const before = yield* Option.match(commit, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: revision =>
            git.fileAt({ repo: checkout, revision, path: spec.path }),
        })
        const filed = yield* tree(root)
        yield* writeFileWhole(
          { root: checkout, path: specUpdateFile },
          [
            `# The change to ${spec.path}`,
            '',
            Option.match(before, {
              onNone: () =>
                `The version its tree was filed for (SHA-256 ${filedFor}) can't be read: read the spec whole.`,
              onSome: text =>
                `The version its tree was filed for (SHA-256 ${filedFor}), to compare the spec with:\n\n\`\`\`\`\n${text}\n\`\`\`\``,
            }),
            '',
            '# The tree',
            '',
            filed,
            '',
          ].join('\n'),
        )
        return `${names} It has changed since its tree was filed under the root epic ${root}: update that tree for the change alone, and don't call file_root. ${specUpdateFile} holds the version the tree was filed for, and the tree. Answer with what the change adds, under the same root and naming what is filed by its keys, and in changes the open tickets it alters or makes obsolete. Never change a closed ticket, and leave one in progress alone.`
      }),
  })
})

/** The narrow tree's warning, where its tree is narrow (§15.5): the run goes on all the same. */
const warnNarrow = Effect.fnUntraced(function* (input: {
  readonly graph: WorkGraphShape
  readonly root: TicketId
  readonly concurrent: number
  readonly log: RunLog['Service']
}) {
  const { tickets, edges } = yield* treeUnder(input)
  yield* Option.match(
    narrowWarning(treeShape(tickets, edges), input.concurrent),
    {
      onNone: () => Effect.void,
      onSome: text =>
        record(input.log, {
          kind: 'warn',
          text: warningLine({ tag: 'NARROW_TREE', about: 'run', text }),
        }),
    },
  )
})

/** Breaks the spec down: what its tools filed, and how it ended. */
export const runBreakdown = Effect.fn('Spec.breakdown')(function* (input: {
  readonly runtime: OrganRuntime
  readonly graph: WorkGraphShape
  readonly spec: CommittedSpec
  readonly state: SpecState
  readonly checkout: string
  readonly cores: number
  readonly concurrent: number
  readonly log: RunLog['Service']
  /** The root epic, set as `file_root` files it: the run's scope. */
  readonly root: Ref.Ref<Option.Option<TicketId>>
}) {
  const {
    runtime,
    graph,
    spec,
    state,
    checkout,
    cores,
    concurrent,
    log,
    root,
  } = input
  const git = yield* Git
  const actor: Actor = { _tag: 'organ', organ: 'breakdown' }
  const invalid = (issue: string) => ToolRefusal.cases.invalid.make({ issue })

  /** `file_root`: filed once, together, in one transaction. */
  const fileRoot = (given: FileRootParameters) =>
    Effect.gen(function* () {
      const filedAlready = yield* Ref.get(root)
      if (Option.isSome(filedAlready))
        return yield* Effect.fail(
          invalid(
            `the root epic is filed already, as ${filedAlready.value}: answer with the rest of the tree`,
          ),
        )
      const rootItem: TreeItem = {
        key: BreakdownRootKey,
        type: 'epic',
        title: given.root.title,
        description: given.root.description,
        design: Option.none(),
        acceptance: Option.none(),
        priority: Option.none(),
        files: Option.none(),
        labels: Option.none(),
        parent: Option.none(),
        waitsOn: Option.none(),
      }
      const environment = Option.map(given.environment, (ticket): TreeItem => ({
        key: BreakdownEnvironmentKey,
        type: 'task',
        title: ticket.title,
        description: ticket.description,
        design: Option.none(),
        acceptance: ticket.acceptance,
        priority: Option.some(0),
        files: Option.some(ticket.files),
        labels: Option.some(['solo']),
        parent: Option.some(BreakdownRootKey),
        waitsOn: Option.none(),
      }))
      const filed = yield* fileTree({
        graph,
        items: [rootItem, ...Option.toArray(environment)],
        spec: Option.some(spec.path),
        actor,
        metadata: key =>
          key === BreakdownEnvironmentKey ? { [SpecEnvironmentKey]: true } : {},
      })
      const environmentId = Option.fromUndefinedOr(
        filed.items.find(({ key }) => key === BreakdownEnvironmentKey)?.id,
      )
      yield* Ref.set(root, Option.some(filed.root))
      yield* record(log, {
        kind: 'info',
        text: Option.match(environmentId, {
          onNone: () => `spec: filed the root epic ${filed.root}`,
          onSome: id =>
            `spec: filed the root epic ${filed.root}; starting on ${id}, the environment ticket, while the breakdown files the rest`,
        }),
      })
      return new FiledRoot({ root: filed.root, environment: environmentId })
    }).pipe(
      Effect.catchTag(['TreeRefused', 'InvalidTicket', 'EdgeCycle'], error =>
        Effect.fail(invalid(error.message)),
      ),
      Effect.catchTag(['StoreFailed', 'TicketNotFound'], Effect.die),
    )

  const applyChange = (change: SpecTicketChange) =>
    Option.match(change.obsolete, {
      onSome: reason =>
        Effect.andThen(
          graph.note({ id: change.ticket, body: reason, actor }),
          graph.defer({ id: change.ticket, until: Option.none(), actor }),
        ),
      onNone: () =>
        graph.update({
          id: change.ticket,
          actor,
          changes: {
            ...Option.match(change.title, {
              onNone: () => ({}),
              onSome: title => ({ title }),
            }),
            ...Option.match(change.description, {
              onNone: () => ({}),
              onSome: description => ({
                description: Option.some(description),
              }),
            }),
            ...Option.match(change.design, {
              onNone: () => ({}),
              onSome: design => ({ design: Option.some(design) }),
            }),
            ...Option.match(change.acceptance, {
              onNone: () => ({}),
              onSome: acceptance => ({ acceptance: Option.some(acceptance) }),
            }),
          },
        }),
    })

  /** The answer: checked whole with what is filed, refused with every reason, or filed in one go. */
  const accept = (answer: BreakdownAnswer) =>
    Effect.gen(function* () {
      const known = yield* Ref.get(root)
      if (Option.isNone(known))
        return yield* Effect.fail(
          invalid('file the root epic with file_root first'),
        )
      const [{ ticket: rootTicket }, { tickets: tree }] = yield* Effect.all(
        [graph.show(known.value), treeUnder({ graph, root: known.value })],
        { concurrency: 2 },
      )
      const filed = tree.filter(ticket => isTreeType(ticket.type))
      const hasEnvironment = filed.some(isEnvironment)
      // Every other ticket waits on the environment ticket, whatever the answer says of it.
      const items = answer.items.map((item): TreeItem =>
        item.type === 'epic' || !hasEnvironment
          ? item
          : {
              ...item,
              waitsOn: Option.some([
                ...new Set([
                  ...Option.getOrElse(item.waitsOn, () => []),
                  BreakdownEnvironmentKey,
                ]),
              ]),
            },
      )
      const filedItems = [
        filedItem(rootTicket, Option.none()),
        ...filed.map(ticket =>
          filedItem(ticket, Option.some(BreakdownRootKey)),
        ),
      ]
      const changes = Option.getOrElse(answer.changes, () => [])
      const updating = SpecState.$is('Changed')(state)
      const problems = [
        ...treeProblems([...filedItems, ...items]),
        ...changeProblems(changes, filed),
        ...(!updating &&
        [...filed, ...items].every(({ type }) => type === 'epic')
          ? ['the tree has no tickets: a worker does none of its epics']
          : []),
      ]
      if (problems.length > 0) return yield* new TreeRefused({ problems })
      const keyed = [
        { key: BreakdownRootKey, id: known.value },
        ...filed.map(ticket => ({ key: keyOf(ticket), id: ticket.id })),
      ]
      yield* fileTree({
        graph,
        items: [...filedItems, ...items],
        spec: Option.some(spec.path),
        actor,
        filed: keyed,
      })
      // The run closes an epic whose tickets are done, as the root's only ticket may have been.
      if (items.length > 0) {
        const now = yield* graph.show(known.value)
        if (now.ticket.status === 'closed')
          yield* graph.reopen({ id: known.value, actor })
      }
      // After the filing, so a change that fails loses the answer rather than file the tree again.
      yield* Effect.forEach(changes, applyChange, { discard: true }).pipe(
        Effect.orDie,
      )
    }).pipe(
      Effect.catchTag(['TreeRefused', 'InvalidTicket', 'EdgeCycle'], error =>
        Effect.fail(invalid(error.message)),
      ),
      Effect.catchTag('TransitionRefused', error =>
        Effect.fail(invalid(error.message)),
      ),
      Effect.catchTag(['StoreFailed', 'TicketNotFound'], Effect.die),
    )

  const outcome = yield* runtime.session({
    organ: 'breakdown',
    ticket: Option.none(),
    answer: BreakdownAnswer,
    description:
      'The rest of the tree: every epic and ticket file_root did not file. Checked whole, and refused with every reason.',
    instructions,
    prompt: Effect.orDie(promptOf({ spec, state, checkout, graph, git })),
    cores,
    accept,
    refusals: treeRefusals,
    fileRoot,
  })
  return yield* OrganOutcome.$match(outcome, {
    Disabled: () =>
      Effect.succeed(
        BreakdownEnd.NotFiled({
          reason: `the breakdown organ is turned off (organs.breakdown.enabled), and the spec ${spec.path} needs breaking down`,
        }),
      ),
    NoResult: ({ reason }) =>
      Effect.succeed(
        BreakdownEnd.NotFiled({
          reason: `the breakdown of ${spec.path} gave no tree: ${reason}. What it filed stays filed: run it again to carry on`,
        }),
      ),
    Answered: () =>
      Effect.gen(function* () {
        const known = yield* Ref.get(root)
        if (Option.isNone(known))
          return BreakdownEnd.NotFiled({
            reason: `the breakdown of ${spec.path} filed no root epic`,
          })
        const { ticket } = yield* graph.show(known.value)
        // Last of all: a breakdown stopped before this is carried on by the next run.
        yield* graph.update({
          id: known.value,
          actor,
          changes: {
            metadata: {
              ...ticket.metadata,
              [SpecSha256Key]: spec.sha256,
              [SpecCommitKey]: spec.commit,
            },
          },
        })
        yield* warnNarrow({ graph, root: known.value, concurrent, log })
        return BreakdownEnd.Filed({ root: known.value })
      }),
  })
})
