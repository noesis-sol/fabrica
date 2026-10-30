import {
  Array,
  type DateTime,
  Duration,
  Effect,
  Match,
  Option,
  Schema,
} from 'effect'
import { Command, Mount, Update } from 'foldkit'
import * as AsyncData from 'foldkit/asyncData'
import { type Html, type HtmlBuilder, childAttributes } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { defineView } from 'foldkit/submodel'

import {
  Line,
  MessageId,
  MessageRole,
  type NewTicket,
  Text,
  TicketDetail,
  TicketId,
  Tokens,
  ToolCallId,
  type TranscriptEntry,
  TranscriptItem,
  type UsageWindow,
  type WorkerRow,
  edgeWords,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { sayElapsed } from '../app/clock'
import { EngineProject, sameProject } from '../app/engine-project'
import { type EngineServices, requestProject } from '../app/engine-route'
import * as Conversation from '../console/conversation'
import { sayTokens, tokenTotal } from '../console/stats'
import { tighterWindow, windowName } from '../console/titlebar'
import { showDiff } from '../mounts/monaco'
import { outputAttribute, showOutput, terminalRows } from '../mounts/terminal'

// The Worker view (spec §18.4, §18.5, H91): the ticket on top (its ID, type and priority, its title and
// the start of its description; the whole ticket a key or a click away), beside it the figures that move
// during a turn (its time, its context use against the model's window, its share of the provider's
// usage window, marked an estimate); the transcript as it happens (messages, thinking collapsed, tool
// calls with their output in xterm.js, an edit's or a write's change in Monaco, bare URLs as links); and
// a composer to message or interrupt the worker, which steers it until it is released. Once the worker
// has finished, the composer keeps its text and offers to file it as a ticket. No spending panel: cost
// is in Insights.
//
// The transcript is drawn at most every `drawEvery` (§18.5): a frame that arrives while a draw's wait
// runs waits for its end, then goes on with every frame that came meanwhile. A tool call's input is
// never drawn while it streams, only once its `tool_call` brings it whole. Only the worker shown has its
// transcript watched, so an inactive worker costs nothing (§18.5). The transcript is a virtual list
// (§18.5): only the blocks in view are drawn, each measured as it is, so a tool call's terminal and an
// edit's diff view are made as their block comes into view and disposed of as it leaves. It follows
// its end while it is scrolled there, and stays where it is read otherwise.

// MODEL

/** The worker shown: its project, named with its engine, and its ticket. */
export const Shown = Schema.Struct({ project: EngineProject, ticket: TicketId })
export type Shown = typeof Shown.Type

/** Whether `a` and `b` are the same worker. */
export const sameWorker = (a: Shown, b: Shown): boolean =>
  a.ticket === b.ticket && sameProject(a.project, b.project)

/** A block of the transcript as drawn. */
export const Block = Schema.TaggedUnion({
  /** A message, its text and its thinking so far. */
  said: {
    id: MessageId,
    role: MessageRole,
    text: Schema.String,
    thinking: Schema.String,
  },
  /** A tool call: its input once whole, its output so far, and how it ended. */
  tool: {
    id: ToolCallId,
    tool: Schema.String,
    input: Schema.Option(Schema.Json),
    output: Schema.String,
    ok: Schema.Option(Schema.Boolean),
  },
})
export type Block = typeof Block.Type

/** Whether a draw's wait runs: what arrives meanwhile waits for its end. */
export const Draw = Schema.Literals(['Idle', 'Waiting'])
export type Draw = typeof Draw.Type

/** The worker's transcript: what is drawn, what waits for the next draw, and whether it ended. */
export const Transcript = Schema.Struct({
  blocks: Schema.Array(Block),
  /** Frames that arrived during a draw's wait, in order. */
  waiting: Schema.Array(TranscriptItem),
  draw: Draw,
  /** The watch ended: the engine no longer has the worker, which has finished. */
  ended: Schema.Boolean,
  /** Why the watch couldn't read it, where it couldn't. */
  failure: Schema.Option(Schema.String),
})
export type Transcript = typeof Transcript.Type

const emptyTranscript: Transcript = {
  blocks: [],
  waiting: [],
  draw: 'Idle',
  ended: false,
  failure: Option.none(),
}

/** A request to the worker (a message, an interrupt, a release): none, one going, or one that failed. */
export const Request = defineTaggedUnion({
  None: {},
  Pending: {},
  Failed: { reason: Schema.String },
})
export type Request = typeof Request.Type

/** Filing the composer's text as a ticket, once the worker has finished. */
export const Filing = defineTaggedUnion({
  None: {},
  Filing: {},
  Filed: { ticket: TicketId },
  Failed: { reason: Schema.String },
})
export type Filing = typeof Filing.Type

export const Model = Schema.Struct({
  shown: Schema.Option(Shown),
  ticket: AsyncData.Schema(TicketDetail, Schema.String).schema,
  /** The whole ticket is shown, not only the start of its description. */
  wholeTicket: Schema.Boolean,
  transcript: Transcript,
  /** The messages whose thinking is opened. */
  openThinking: Schema.Array(MessageId),
  composer: Conversation.Composer,
  /** An interrupt or a release going, or the last one's failure. */
  request: Request,
  /** Messaged or interrupted from here: the engine sends it nothing until it is released. */
  steered: Schema.Boolean,
  filing: Filing,
  /** What a terminal or a diff view said where it couldn't draw. */
  viewProblem: Schema.Option(Schema.String),
  /** The transcript's list: where it is scrolled to, and the heights of the blocks drawn so far. */
  list: VirtualList.Model,
})
export type Model = typeof Model.Type

/** A block's height before it is drawn and measured: a line of text with the gap below it. */
export const blockHeightPx = 40

/** The height of an edit's or a write's diff view. */
const changeHeightPx = 200

/** The height of a tool call's terminal: its rows, and the padding around them. */
const outputHeightPx = terminalRows * 17 + 8

export const init = (): Model => ({
  shown: Option.none(),
  ticket: AsyncData.Idle(),
  wholeTicket: false,
  transcript: emptyTranscript,
  openThinking: [],
  composer: Conversation.emptyComposer,
  request: Request.None(),
  steered: false,
  filing: Filing.None(),
  viewProblem: Option.none(),
  list: VirtualList.init({
    id: 'transcript',
    rowHeightPx: blockHeightPx,
    initialScroll: { target: VirtualList.ScrollTarget.End() },
    followEnd: { thresholdPx: 8 },
  }),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadTicket: { worker: Shown, detail: TicketDetail },
  FailedLoadTicket: { worker: Shown, reason: Schema.String },
  /** A draw's wait ended: what came meanwhile is drawn. */
  CompletedWaitToDraw: {},
  ToggledWholeTicket: {},
  ToggledThinking: { message: MessageId, open: Schema.Boolean },
  TypedDraft: { text: Schema.String },
  SubmittedDraft: {},
  SucceededSend: {},
  FailedSend: { reason: Schema.String },
  ClickedInterrupt: {},
  ClickedRelease: {},
  SucceededInterrupt: {},
  SucceededRelease: {},
  FailedRequest: { reason: Schema.String },
  ClickedFileTicket: {},
  SucceededFileTicket: { ticket: TicketId },
  FailedFileTicket: { reason: Schema.String },
  /** A terminal or a diff view drew, or couldn't. */
  CompletedShowView: {},
  FailedShowView: { reason: Schema.String },
  GotListMessage: { message: VirtualList.Message },
})
export type Message = typeof Message.Type

// COMMAND

/** The longest streamed text waits to be drawn, and the shortest time between two draws (§18.5). */
export const drawEvery = Duration.millis(33)

/** Waits `drawEvery` before the transcript is drawn again. */
export const WaitToDraw = Command.define('WaitToDraw', {
  messages: [Message.CompletedWaitToDraw],
  execute: Effect.as(Effect.sleep(drawEvery), Message.CompletedWaitToDraw()),
})

/** The worker's ticket, whole: its fields, labels, links and notes. */
export const LoadTicket = Command.define('LoadTicket', {
  args: { worker: Shown },
  messages: [Message.SucceededLoadTicket, Message.FailedLoadTicket],
  execute: ({ worker }) =>
    requestProject(worker.project, client =>
      client.rpc['tickets.show']({
        project: worker.project.project,
        ticket: worker.ticket,
      }),
    ).pipe(
      Effect.map(detail => Message.SucceededLoadTicket({ worker, detail })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedLoadTicket({ worker, reason })),
      ),
    ),
})

/** Messages the worker, which steers it: the engine sends it nothing more until it is released. */
export const SendToWorker = Command.define('SendToWorker', {
  args: { worker: Shown, text: Text },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ worker, text }) =>
    requestProject(worker.project, client =>
      client.rpc['worker.message']({
        project: worker.project.project,
        ticket: worker.ticket,
        text,
      }),
    ).pipe(
      Effect.as(Message.SucceededSend()),
      Effect.catch(reason => Effect.succeed(Message.FailedSend({ reason }))),
    ),
})

export const InterruptWorker = Command.define('InterruptWorker', {
  args: { worker: Shown },
  messages: [Message.SucceededInterrupt, Message.FailedRequest],
  execute: ({ worker }) =>
    requestProject(worker.project, client =>
      client.rpc['worker.interrupt']({
        project: worker.project.project,
        ticket: worker.ticket,
      }),
    ).pipe(
      Effect.as(Message.SucceededInterrupt()),
      Effect.catch(reason => Effect.succeed(Message.FailedRequest({ reason }))),
    ),
})

/** Hands the steered worker back to the engine. */
export const ReleaseWorker = Command.define('ReleaseWorker', {
  args: { worker: Shown },
  messages: [Message.SucceededRelease, Message.FailedRequest],
  execute: ({ worker }) =>
    requestProject(worker.project, client =>
      client.rpc['worker.release']({
        project: worker.project.project,
        ticket: worker.ticket,
      }),
    ).pipe(
      Effect.as(Message.SucceededRelease()),
      Effect.catch(reason => Effect.succeed(Message.FailedRequest({ reason }))),
    ),
})

/** A task of `title`, described by `description`, everything else left to the engine's defaults. */
const filedTicket = ({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}): NewTicket => ({
  type: 'task',
  title,
  description: Option.some(description),
  design: Option.none(),
  acceptance: Option.none(),
  priority: Option.none(),
  labels: Option.none(),
  parent: Option.none(),
  metadata: Option.none(),
  model: Option.none(),
})

/** Files `ticket` in the worker's project. */
export const FileTicket = Command.define('FileTicket', {
  args: {
    project: EngineProject,
    ticket: Schema.Struct({ title: Line, description: Text }),
  },
  messages: [Message.SucceededFileTicket, Message.FailedFileTicket],
  execute: ({ project, ticket }) =>
    requestProject(project, client =>
      client.rpc['tickets.create']({
        project: project.project,
        ticket: filedTicket(ticket),
      }),
    ).pipe(
      Effect.map(({ id }) => Message.SucceededFileTicket({ ticket: id })),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedFileTicket({ reason })),
      ),
    ),
})

/** A tool call's output in a read-only terminal, drawn in the element it is mounted on until it goes. */
export const ShowOutput = Mount.define('ShowOutput', {
  messages: [Message.CompletedShowView, Message.FailedShowView],
  execute: ({ element }) =>
    showOutput({ element }).pipe(
      Effect.as(Message.CompletedShowView()),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedShowView({ reason })),
      ),
    ),
})

/** An edit's or a write's change, in Monaco's diff view. */
export const ShowChange = Mount.define('ShowChange', {
  args: {
    path: Text,
    key: Schema.String,
    original: Schema.String,
    modified: Schema.String,
  },
  messages: [Message.CompletedShowView, Message.FailedShowView],
  execute: ({ element, path, key, original, modified }) =>
    showDiff({ element, path, key, sides: { original, modified } }).pipe(
      Effect.as(Message.CompletedShowView()),
      Effect.catch(reason =>
        Effect.succeed(Message.FailedShowView({ reason })),
      ),
    ),
})

// THE TRANSCRIPT

const changeBlock = (
  blocks: ReadonlyArray<Block>,
  matches: (block: Block) => boolean,
  change: (block: Block) => Block,
): ReadonlyArray<Block> =>
  blocks.map(block => (matches(block) ? change(block) : block))

const isSaid =
  (id: MessageId) =>
  (block: Block): boolean =>
    block._tag === 'said' && block.id === id

const isTool =
  (id: ToolCallId) =>
  (block: Block): boolean =>
    block._tag === 'tool' && block.id === id

/** The transcript with one entry drawn. A tool call's streamed input only makes its block: it waits whole. */
const applyEntry = (
  transcript: Transcript,
  entry: TranscriptEntry,
): Transcript =>
  Option.match(entryBlocks(transcript, entry), {
    onNone: () => transcript,
    onSome: blocks => ({ ...transcript, blocks }),
  })

const entryBlocks = (
  transcript: Transcript,
  entry: TranscriptEntry,
): Option.Option<ReadonlyArray<Block>> => {
  const { blocks } = transcript
  const toolBlock = (
    id: ToolCallId,
    tool: string,
    input: Option.Option<Schema.Json>,
  ): ReadonlyArray<Block> =>
    blocks.some(isTool(id))
      ? changeBlock(blocks, isTool(id), block =>
          block._tag === 'tool' ? { ...block, tool, input } : block,
        )
      : [
          ...blocks,
          Block.cases.tool.make({
            id,
            tool,
            input,
            output: '',
            ok: Option.none(),
          }),
        ]
  return Match.valueTags(entry, {
    message: ({ id, role, text }) =>
      Option.some([
        ...blocks,
        Block.cases.said.make({ id, role, text, thinking: '' }),
      ]),
    text: ({ message, delta }) =>
      Option.some(
        changeBlock(blocks, isSaid(message), block =>
          block._tag === 'said'
            ? { ...block, text: block.text + delta }
            : block,
        ),
      ),
    thinking: ({ message, delta }) =>
      Option.some(
        changeBlock(blocks, isSaid(message), block =>
          block._tag === 'said'
            ? { ...block, thinking: block.thinking + delta }
            : block,
        ),
      ),
    tool_input: ({ id, tool }) =>
      blocks.some(isTool(id))
        ? Option.none()
        : Option.some(toolBlock(id, tool, Option.none())),
    tool_call: ({ id, tool, input }) =>
      Option.some(toolBlock(id, tool, Option.some(input))),
    tool_output: ({ id, chunk }) =>
      Option.some(
        changeBlock(blocks, isTool(id), block =>
          block._tag === 'tool'
            ? { ...block, output: block.output + chunk }
            : block,
        ),
      ),
    tool_end: ({ id, ok }) =>
      Option.some(
        changeBlock(blocks, isTool(id), block =>
          block._tag === 'tool' ? { ...block, ok: Option.some(ok) } : block,
        ),
      ),
    turn_end: () => Option.none(),
  })
}

/**
 * The transcript with frames' items drawn: a snapshot is the transcript so far, which takes the blocks'
 * place; a patch holds the entries since, which go on after them.
 */
export const drawItems = (
  transcript: Transcript,
  items: ReadonlyArray<TranscriptItem>,
): Transcript =>
  Array.reduce(items, transcript, (current, item) =>
    Array.reduce(
      item.value,
      item._tag === 'snapshot' ? { ...current, blocks: [] } : current,
      applyEntry,
    ),
  )

// UPDATE

type Return = Update.Return<Model, Message, EngineServices>

const waitingDraw: Draw = 'Waiting'
const idleDraw: Draw = 'Idle'

const showing = (model: Model, worker: Shown): boolean =>
  Option.exists(model.shown, shown => sameWorker(shown, worker))

/**
 * The view opened on `worker`: the same worker keeps what it holds, and its ticket is read again;
 * another starts afresh, its ticket read and its transcript to come.
 */
export const opened = (model: Model, worker: Shown): Return =>
  showing(model, worker)
    ? {
        model: modifyFields(model, {
          ticket: ticket =>
            Option.getOrElse(AsyncData.revalidateOrLoad(ticket), () => ticket),
        }),
        commands: [LoadTicket({ worker })],
      }
    : {
        model: modifyFields(init(), {
          shown: () => Option.some(worker),
          ticket: () => AsyncData.Loading(),
        }),
        commands: [LoadTicket({ worker })],
      }

/** A block's key in the transcript's list. */
export const blockKey = (block: Block): string => `${block._tag}:${block.id}`

const foldList = Update.foldChild({
  update: VirtualList.update,
  read: (model: Model) => Option.some(model.list),
  write: (model: Model, list: VirtualList.Model) =>
    modifyFields(model, { list: () => list }),
  toParentMessage: (message: VirtualList.Message) =>
    Message.GotListMessage({ message }),
})

const foldBlocksChanged = Update.foldChild({
  update: VirtualList.informItemsChanged,
  read: (model: Model) => Option.some(model.list),
  write: (model: Model, list: VirtualList.Model) =>
    modifyFields(model, { list: () => list }),
  toParentMessage: (message: VirtualList.Message) =>
    Message.GotListMessage({ message }),
})

/**
 * The list told of the blocks drawn since `before`, where one came or a snapshot took their place, so
 * that it follows the end or keeps the block read in place. A block that only grew is measured anew.
 */
const informList =
  (before: Model) =>
  (model: Model): Return => {
    const was = before.transcript.blocks.map(blockKey)
    const keys = model.transcript.blocks.map(blockKey)
    return was.length === keys.length &&
      was.every((key, index) => key === keys[index])
      ? { model }
      : foldBlocksChanged(model, keys)
  }

/** The worker shown's transcript changed by `change`; another worker's leaves the Model as it is. */
const changeTranscript = (
  model: Model,
  worker: Shown,
  change: (transcript: Transcript) => Transcript,
): Model =>
  showing(model, worker) ? modifyFields(model, { transcript: change }) : model

/**
 * A frame of the worker's transcript (§18.5): drawn now where no draw's wait runs, and a wait started;
 * else kept for the wait's end. A frame for another worker is dropped.
 */
export const receivedTranscript = (
  model: Model,
  worker: Shown,
  items: ReadonlyArray<TranscriptItem>,
): Return =>
  !showing(model, worker)
    ? { model }
    : model.transcript.draw === 'Idle'
      ? Update.combine(model, [
          shown => ({
            model: changeTranscript(shown, worker, transcript =>
              modifyFields(drawItems(transcript, items), {
                draw: () => waitingDraw,
                failure: () => Option.none(),
              }),
            ),
            commands: [WaitToDraw()],
          }),
          informList(model),
        ])
      : {
          model: changeTranscript(model, worker, transcript =>
            modifyFields(transcript, {
              waiting: waiting => [...waiting, ...items],
              failure: () => Option.none(),
            }),
          ),
        }

/** The worker's transcript ended: the worker has finished. */
export const endedTranscript = (model: Model, worker: Shown): Return => ({
  model: changeTranscript(model, worker, transcript =>
    modifyFields(transcript, { ended: () => true }),
  ),
})

/** The worker's transcript couldn't be read, and why. */
export const failedTranscript = (
  model: Model,
  worker: Shown,
  reason: string,
): Return => ({
  model: changeTranscript(model, worker, transcript =>
    modifyFields(transcript, { failure: () => Option.some(reason) }),
  ),
})

/** The view's keys (§18.5): the whole ticket, interrupting the worker, releasing it. */
export const Key = Schema.Literals(['ticket', 'interrupt', 'release'])
export type Key = typeof Key.Type

/** A key of the view's, as its button's click. */
export const pressedKey = (model: Model, key: Key): Return =>
  update(
    model,
    key === 'ticket'
      ? Message.ToggledWholeTicket()
      : key === 'interrupt'
        ? Message.ClickedInterrupt()
        : Message.ClickedRelease(),
  )

/** The worker shown, where its view has one, with `use`'s result; else nothing changes. */
const withShown = (model: Model, use: (worker: Shown) => Return): Return =>
  Option.match(model.shown, { onNone: () => ({ model }), onSome: use })

const decodeText = Schema.decodeUnknownOption(Text)
const decodeLine = Schema.decodeUnknownOption(Line)

/** How long a filed ticket's title may be, its first line cut there. */
export const titleLength = 80

/**
 * The ticket the finished worker's composer text files: its first line the title (cut at
 * `titleLength`), the whole text its description, saying where it came from.
 */
export const ticketFrom = (
  draft: string,
  from: TicketId,
): Option.Option<{ readonly title: string; readonly description: string }> =>
  Option.flatMap(Conversation.sendable(draft), text =>
    Option.all({
      title: decodeLine(
        (text.split('\n')[0] ?? text).trim().slice(0, titleLength),
      ),
      description: decodeText(`${text}\n\nFiled from ${from}'s worker view.`),
    }),
  )

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SucceededLoadTicket: ({ worker, detail }) => ({
      model: showing(model, worker)
        ? modifyFields(model, { ticket: () => AsyncData.succeed(detail) })
        : model,
    }),
    FailedLoadTicket: ({ worker, reason }) => ({
      model: showing(model, worker)
        ? modifyFields(model, { ticket: () => AsyncData.fail(reason) })
        : model,
    }),
    CompletedWaitToDraw: () =>
      Array.isReadonlyArrayNonEmpty(model.transcript.waiting)
        ? Update.combine(model, [
            shown => ({
              model: modifyFields(shown, {
                transcript: transcript =>
                  modifyFields(drawItems(transcript, transcript.waiting), {
                    waiting: () => [],
                  }),
              }),
              commands: [WaitToDraw()],
            }),
            informList(model),
          ])
        : {
            model: modifyFields(model, {
              transcript: transcript =>
                modifyFields(transcript, { draw: () => idleDraw }),
            }),
          },
    ToggledWholeTicket: () => ({
      model: modifyFields(model, { wholeTicket: whole => !whole }),
    }),
    ToggledThinking: ({ message: id, open }) => ({
      model: modifyFields(model, {
        openThinking: ids =>
          open
            ? ids.includes(id)
              ? ids
              : [...ids, id]
            : ids.filter(each => each !== id),
      }),
    }),
    TypedDraft: ({ text }) => ({
      model: modifyFields(model, {
        composer: composer => modifyFields(composer, { draft: () => text }),
        filing: filing =>
          Filing.guards.Filing(filing) ? filing : Filing.None(),
      }),
    }),
    SubmittedDraft: () =>
      withShown(model, worker =>
        model.transcript.ended || model.composer.sending._tag === 'sending'
          ? { model }
          : Option.match(Conversation.sendable(model.composer.draft), {
              onNone: () => ({ model }),
              onSome: text => ({
                model: modifyFields(model, {
                  composer: composer =>
                    modifyFields(composer, {
                      sending: () =>
                        Conversation.Sending.cases.sending.make({}),
                    }),
                }),
                commands: [SendToWorker({ worker, text })],
              }),
            }),
      ),
    SucceededSend: () => ({
      model: modifyFields(model, {
        composer: () => Conversation.emptyComposer,
        steered: () => true,
      }),
    }),
    FailedSend: ({ reason }) => ({
      model: modifyFields(model, {
        composer: composer =>
          modifyFields(composer, {
            sending: () => Conversation.Sending.cases.failed.make({ reason }),
          }),
      }),
    }),
    ClickedInterrupt: () =>
      withShown(model, worker =>
        model.transcript.ended || Request.guards.Pending(model.request)
          ? { model }
          : {
              model: modifyFields(model, { request: () => Request.Pending() }),
              commands: [InterruptWorker({ worker })],
            },
      ),
    ClickedRelease: () =>
      withShown(model, worker =>
        model.transcript.ended || Request.guards.Pending(model.request)
          ? { model }
          : {
              model: modifyFields(model, { request: () => Request.Pending() }),
              commands: [ReleaseWorker({ worker })],
            },
      ),
    SucceededInterrupt: () => ({
      model: modifyFields(model, {
        request: () => Request.None(),
        steered: () => true,
      }),
    }),
    SucceededRelease: () => ({
      model: modifyFields(model, {
        request: () => Request.None(),
        steered: () => false,
      }),
    }),
    FailedRequest: ({ reason }) => ({
      model: modifyFields(model, { request: () => Request.Failed({ reason }) }),
    }),
    ClickedFileTicket: () =>
      withShown(model, worker =>
        !model.transcript.ended || Filing.guards.Filing(model.filing)
          ? { model }
          : Option.match(ticketFrom(model.composer.draft, worker.ticket), {
              onNone: () => ({ model }),
              onSome: ticket => ({
                model: modifyFields(model, { filing: () => Filing.Filing() }),
                commands: [FileTicket({ project: worker.project, ticket })],
              }),
            }),
      ),
    SucceededFileTicket: ({ ticket }) => ({
      model: modifyFields(model, {
        filing: () => Filing.Filed({ ticket }),
        composer: () => Conversation.emptyComposer,
      }),
    }),
    FailedFileTicket: ({ reason }) => ({
      model: modifyFields(model, { filing: () => Filing.Failed({ reason }) }),
    }),
    CompletedShowView: () => ({ model }),
    FailedShowView: ({ reason }) => ({
      model: modifyFields(model, { viewProblem: () => Option.some(reason) }),
    }),
    GotListMessage: ({ message }) => foldList(model, message),
  })

// VIEW

/** What the frame gives the view, read from the run view and the clock. */
export interface ViewInputs {
  /** The worker's engine is connected. */
  readonly live: boolean
  readonly now: Option.Option<DateTime.Zoned>
  /** The worker's row in its run's view, where the scoped run is its run. */
  readonly row: Option.Option<WorkerRow>
  /** The project's provider account's usage windows. */
  readonly usage: Option.Option<ReadonlyArray<UsageWindow>>
  /** What the worker's run has spent, every worker's together. */
  readonly runTokens: Option.Option<Tokens>
}

/** How much of a description the top shows before the whole ticket is asked for. */
export const descriptionStart = 280

/** The start of a description: its first `descriptionStart` characters, cut at a word, with an ellipsis. */
export const startOf = (description: string): string => {
  const text = description.trim()
  if (text.length <= descriptionStart) {
    return text
  }
  const cut = text.slice(0, descriptionStart)
  const space = cut.lastIndexOf(' ')
  return `${(space > descriptionStart / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/**
 * The worker's share of the provider's usage window, estimated: the tighter window's use, in the part
 * the worker's spending is of its run's, both as the model proxy counts each call, so that it moves
 * during a turn (H91). None where either is unknown or the run has spent nothing.
 */
export const usageShare = (
  spent: Option.Option<Tokens>,
  run: Option.Option<Tokens>,
  windows: Option.Option<ReadonlyArray<UsageWindow>>,
): Option.Option<{ readonly share: number; readonly window: string }> =>
  Option.flatMap(
    Option.all({
      spent,
      run,
      window: Option.flatMap(windows, tighterWindow),
    }),
    ({ spent: own, run: all, window }) => {
      const total = tokenTotal(all)
      return total === 0
        ? Option.none()
        : Option.some({
            share: window.utilization * Math.min(1, tokenTotal(own) / total),
            window: windowName(window.window),
          })
    },
  )

/** A share as a percentage, to a tenth under 10 %: `0.4%`, `12%`. */
const percent = (share: number): string => {
  const value = share * 100
  return value < 10
    ? `${Math.round(value * 10) / 10}%`
    : `${Math.round(value)}%`
}

/** A bare URL in agent text, its trailing punctuation left out. */
const urlPattern = /https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/gu

/** Text with its bare URLs as links, opened in the system browser (§20.1). */
export const withLinks = <Message>(
  text: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  const link = (url: string): Html =>
    h.a(
      [
        h.Href(url),
        h.Target('_blank'),
        h.Rel('noreferrer'),
        h.Class('text-c1 underline'),
      ],
      [url],
    )
  const { from, parts } = Array.reduce(
    Array.fromIterable(text.matchAll(urlPattern)),
    { from: 0, parts: Array.empty<Html | string>() },
    (sofar, match) => ({
      from: match.index + match[0].length,
      parts: [
        ...sofar.parts,
        ...(match.index > sofar.from
          ? [text.slice(sofar.from, match.index)]
          : []),
        link(match[0]),
      ],
    }),
  )
  return from < text.length ? [...parts, text.slice(from)] : parts
}

const EditInput = Schema.Struct({
  path: Text,
  edits: Schema.Array(
    Schema.Struct({ oldText: Schema.String, newText: Schema.String }),
  ),
})
const WriteInput = Schema.Struct({ path: Text, content: Schema.String })
const decodeEdit = Schema.decodeUnknownOption(EditInput)
const decodeWrite = Schema.decodeUnknownOption(WriteInput)

/** A file change a tool call makes, as its two sides. */
export interface Change {
  readonly path: string
  readonly original: string
  readonly modified: string
}

/** The change an edit or a write makes, from its input: an edit's replacements, a write's whole file. */
export const changeOf = (
  tool: string,
  input: Schema.Json,
): Option.Option<Change> =>
  tool === 'edit'
    ? Option.map(decodeEdit(input), ({ path, edits }) => ({
        path,
        original: edits.map(edit => edit.oldText).join('\n'),
        modified: edits.map(edit => edit.newText).join('\n'),
      }))
    : tool === 'write'
      ? Option.map(decodeWrite(input), ({ path, content }) => ({
          path,
          original: '',
          modified: content,
        }))
      : Option.none()

const authorColour: Record<MessageRole, string> = {
  user: 'text-c1',
  assistant: 'text-c5',
  engine: 'text-muted',
}

const authorName: Record<MessageRole, string> = {
  user: 'You',
  assistant: 'Worker',
  engine: 'Engine',
}

const note = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('text-xs text-muted')], [text])

const problem = <Message>(text: string, h: HtmlBuilder<Message>): Html =>
  h.p([h.Role('alert'), h.Class('text-xs text-c3')], [text])

const button = <Message>(
  label: string,
  message: Message,
  enabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Disabled(!enabled),
      h.OnClick(message),
      h.Class('rounded-button border border-line px-6 text-xs text-fg'),
    ],
    [label],
  )

const wholeTicketView = (
  detail: TicketDetail,
  h: HtmlBuilder<Message>,
): Html => {
  const { ticket } = detail
  const section = (title: string, body: ReadonlyArray<Html | string>) =>
    h.section(
      [h.AriaLabel(title), h.Class('flex flex-col gap-4')],
      [h.h3([h.Class('text-xs font-extrabold text-muted')], [title]), ...body],
    )
  const prose = (text: string) =>
    h.p([h.Class('whitespace-pre-wrap break-words')], withLinks(text, h))
  const field = (title: string, value: Option.Option<string>) =>
    Option.match(value, {
      onNone: () => h.empty,
      onSome: text => section(title, [prose(text)]),
    })
  const blocks = detail.edges.filter(
    edge => edge.kind === 'blocks' && edge.from === ticket.id,
  )
  return h.div(
    [
      h.Role('region'),
      h.AriaLabel('Whole ticket'),
      h.Class('flex flex-col gap-10 text-xs'),
    ],
    [
      field('Description', ticket.description),
      field('Design', ticket.design),
      field('Acceptance', ticket.acceptance),
      detail.notes.length === 0
        ? h.empty
        : section(
            'Notes',
            detail.notes.map(each =>
              h.keyed('p')(
                each.id,
                [h.Class('whitespace-pre-wrap break-words')],
                withLinks(each.body, h),
              ),
            ),
          ),
      detail.edges.length === 0
        ? h.empty
        : section('Links', [
            h.ul(
              [h.Class('flex flex-col font-mono')],
              detail.edges.map(edge =>
                h.keyed('li')(
                  `${edge.kind}:${edge.from}:${edge.to}`,
                  [],
                  [edgeWords(edge)],
                ),
              ),
            ),
          ]),
      section('Blocks', [
        blocks.length === 0
          ? note('It blocks no ticket.', h)
          : h.p(
              [h.Class('font-mono')],
              [blocks.map(edge => edge.to).join(', ')],
            ),
      ]),
    ],
  )
}

const ticketView = (
  model: Model,
  worker: Shown,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel('Ticket'), h.Class('flex min-w-0 flex-1 flex-col gap-6')],
    AsyncData.matchData(model.ticket, {
      onEmpty: () => [
        h.h2([h.Class('font-mono font-extrabold')], [worker.ticket]),
        note('Reading the ticket…', h),
      ],
      onFailure: reason => [
        h.h2([h.Class('font-mono font-extrabold')], [worker.ticket]),
        problem(`The ticket couldn't be read: ${reason}`, h),
      ],
      onData: detail => [
        h.div(
          [h.Class('flex items-center gap-8 text-xs')],
          [
            h.span([h.Class('font-mono font-extrabold')], [detail.ticket.id]),
            h.span([h.Class('text-muted')], [detail.ticket.type]),
            h.span(
              [h.Class('font-mono text-muted')],
              [`P${detail.ticket.priority}`],
            ),
            h.button(
              [
                h.Type('button'),
                h.AriaExpanded(model.wholeTicket),
                h.OnClick(Message.ToggledWholeTicket()),
                h.Class(
                  'ml-auto rounded-button border border-line px-6 text-xs text-fg',
                ),
              ],
              [model.wholeTicket ? 'Hide the whole ticket' : 'Whole ticket'],
            ),
          ],
        ),
        h.h2(
          [h.Class('font-extrabold'), h.Style({ fontSize: '15px' })],
          [detail.ticket.title],
        ),
        model.wholeTicket
          ? wholeTicketView(detail, h)
          : Option.match(detail.ticket.description, {
              onNone: () => note('No description.', h),
              onSome: description =>
                h.p(
                  [
                    h.DataAttribute('description-start', ''),
                    h.Class(
                      'whitespace-pre-wrap break-words text-xs text-muted',
                    ),
                  ],
                  withLinks(startOf(description), h),
                ),
            }),
      ],
    }),
  )

const figure = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.DataAttribute('figure', label), h.Class('flex flex-col')],
    [
      h.span([h.Class('text-xs text-muted')], [label]),
      h.span([h.Class('font-mono')], [value]),
    ],
  )

const figuresView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const time = Option.match(Option.all({ row: inputs.row, now: inputs.now }), {
    onNone: () => '—',
    onSome: ({ row, now }) => sayElapsed(row.startedAt, now),
  })
  const context = Option.match(
    Option.flatMap(inputs.row, row => row.context),
    {
      onNone: () => '—',
      onSome: ({ used, window }) =>
        `${sayTokens(used)} of ${sayTokens(window)} · ${percent(used / window)}`,
    },
  )
  const usage = Option.match(
    usageShare(
      Option.map(inputs.row, row => row.tokens),
      inputs.runTokens,
      inputs.usage,
    ),
    {
      onNone: () => '—',
      onSome: ({ share, window }) => `≈ ${percent(share)} of ${window}`,
    },
  )
  return h.aside(
    [
      h.AriaLabel('Figures'),
      h.Class('grid gap-10 text-xs'),
      h.Style({ gridTemplateColumns: 'repeat(3, minmax(0, auto))' }),
    ],
    [
      figure('Time', time, h),
      figure('Context', context, h),
      h.div(
        [h.DataAttribute('figure', 'Usage'), h.Class('flex flex-col')],
        [
          h.span([h.Class('text-xs text-muted')], ['Usage (estimate)']),
          h.span([h.Class('font-mono')], [usage]),
        ],
      ),
    ],
  )
}

const saidView = (
  model: Model,
  block: Extract<Block, { readonly _tag: 'said' }>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.span(
    [
      h.Class(`font-extrabold ${authorColour[block.role]}`),
      h.Style({ fontSize: '12px' }),
    ],
    [authorName[block.role]],
  ),
  h.div(
    [h.Class('flex min-w-0 flex-col gap-4')],
    [
      block.thinking === ''
        ? h.empty
        : h.details(
            [
              h.Open(model.openThinking.includes(block.id)),
              h.OnToggle(open =>
                Message.ToggledThinking({ message: block.id, open }),
              ),
              h.Class('text-xs text-muted'),
            ],
            [
              h.summary([h.Class('cursor-pointer')], ['Thinking']),
              h.p(
                [h.Class('whitespace-pre-wrap break-words font-mono')],
                [block.thinking],
              ),
            ],
          ),
      h.p(
        [h.Class('whitespace-pre-wrap break-words')],
        withLinks(block.text, h),
      ),
    ],
  ),
]

const inputView = (
  block: Extract<Block, { readonly _tag: 'tool' }>,
  input: Schema.Json,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(changeOf(block.tool, input), {
    onNone: () =>
      h.pre(
        [
          h.DataAttribute('tool-input', ''),
          h.Class(
            'whitespace-pre-wrap break-words font-mono text-xs text-muted',
          ),
        ],
        [JSON.stringify(input, null, 2)],
      ),
    onSome: change =>
      h.div([
        h.Role('region'),
        h.AriaLabel(`Change to ${change.path}`),
        h.Class('overflow-hidden rounded-card bg-panel'),
        h.Style({ height: `${changeHeightPx}px` }),
        h.OnMount(
          ShowChange({
            path: change.path,
            key: block.id,
            original: change.original,
            modified: change.modified,
          }),
        ),
      ]),
  })

const toolView = (
  block: Extract<Block, { readonly _tag: 'tool' }>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.span(
    [h.Class('font-mono text-muted'), h.Style({ fontSize: '12px' })],
    ['tool'],
  ),
  h.div(
    [h.Class('flex min-w-0 flex-col gap-4')],
    [
      h.span(
        [h.Class('font-mono text-xs')],
        [
          Option.match(block.ok, {
            onNone: () => `${block.tool} …`,
            onSome: ok => `${block.tool} ${ok ? '✓' : '✗'}`,
          }),
        ],
      ),
      Option.match(block.input, {
        onNone: () => note('Writing its input…', h),
        onSome: input => inputView(block, input, h),
      }),
      block.output === ''
        ? h.empty
        : h.div([
            h.Role('log'),
            h.AriaLabel(`Output of ${block.tool}`),
            h.Attribute(outputAttribute, block.output),
            h.Class('overflow-hidden rounded-card bg-panel'),
            h.Style({ height: `${outputHeightPx}px`, padding: '4px' }),
            h.OnMount(ShowOutput()),
          ]),
    ],
  ),
]

const blockView = (model: Model, block: Block, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute('block', block._tag),
      h.Class('grid gap-8'),
      h.Style({
        gridTemplateColumns: '64px minmax(0,1fr)',
        padding: '4px 12px',
      }),
    ],
    block._tag === 'said' ? saidView(model, block, h) : toolView(block, h),
  )

/**
 * A block's height before it is measured: a tool call's from its input and output, whose diff view and
 * terminal have heights of their own; a message's a line.
 */
export const estimatedHeightPx = (block: Block): number =>
  block._tag === 'said'
    ? blockHeightPx
    : blockHeightPx +
      Option.match(block.input, {
        onNone: () => 0,
        onSome: input =>
          Option.isSome(changeOf(block.tool, input)) ? changeHeightPx : 0,
      }) +
      (block.output === '' ? 0 : outputHeightPx)

const transcriptView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('log'),
      h.AriaLabel('Transcript'),
      h.Class('flex min-h-0 flex-1 flex-col'),
      h.Style({ fontSize: '12.5px', lineHeight: '1.35' }),
    ],
    [
      model.transcript.blocks.length === 0
        ? h.div([h.Style({ padding: '8px 12px' })], [note('Nothing yet.', h)])
        : h.submodel({
            slotId: 'transcript-list',
            model: model.list,
            view: VirtualList.view<Block>(),
            viewInputs: {
              items: model.transcript.blocks,
              itemToKey: blockKey,
              itemToView: block => blockView(model, block, h),
              dynamicRowHeights: true,
              itemToEstimatedRowHeightPx: estimatedHeightPx,
              contentAlignment: 'End',
              overscan: 2,
              containerClassName: 'min-h-0 flex-1',
              containerAttributes: childAttributes([h.AriaLabel('Blocks')]),
            },
            toParentMessage: message => Message.GotListMessage({ message }),
          }),
      model.transcript.ended ||
      Option.isSome(model.transcript.failure) ||
      Option.isSome(model.viewProblem)
        ? h.div(
            [h.Class('flex flex-col gap-4'), h.Style({ padding: '4px 12px' })],
            [
              model.transcript.ended
                ? note('The worker has finished.', h)
                : h.empty,
              Option.match(model.transcript.failure, {
                onNone: () => h.empty,
                onSome: reason =>
                  problem(`The transcript couldn't be read: ${reason}`, h),
              }),
              Option.match(model.viewProblem, {
                onNone: () => h.empty,
                onSome: reason => problem(`Couldn't draw it: ${reason}`, h),
              }),
            ],
          )
        : h.empty,
    ],
  )

const composerView = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const finished = model.transcript.ended
  const steered = model.steered || Option.exists(inputs.row, row => row.steered)
  const canSend =
    inputs.live &&
    !finished &&
    Option.isSome(Conversation.sendable(model.composer.draft)) &&
    model.composer.sending._tag !== 'sending'
  const canAct =
    inputs.live && !finished && !Request.guards.Pending(model.request)
  return h.div(
    [
      h.Class('flex flex-col gap-6 border-t border-line'),
      h.Style({ padding: '8px 12px' }),
    ],
    [
      steered && !finished
        ? h.p(
            [h.DataAttribute('steered', ''), h.Class('text-xs text-c2')],
            ['Steered: the engine sends it nothing until you release it.'],
          )
        : h.empty,
      model.composer.sending._tag === 'failed'
        ? problem(`Not sent: ${model.composer.sending.reason}`, h)
        : h.empty,
      Request.guards.Failed(model.request)
        ? problem(`Not done: ${model.request.reason}`, h)
        : h.empty,
      Filing.match(model.filing, {
        None: () => h.empty,
        Filing: () => note('Filing it…', h),
        Filed: ({ ticket }) => note(`Filed as ${ticket}.`, h),
        Failed: ({ reason }) => problem(`Not filed: ${reason}`, h),
      }),
      finished
        ? note(
            'The worker has finished: your text is kept, and can be filed as a ticket.',
            h,
          )
        : h.empty,
      h.form(
        [
          h.AriaLabel('Composer'),
          h.OnSubmit(Message.SubmittedDraft()),
          h.Class('flex items-center gap-8'),
        ],
        [
          h.span([h.Class('font-mono font-bold text-c1')], ['›']),
          h.input([
            h.Type('text'),
            h.AriaLabel('Message'),
            h.Placeholder(
              finished ? 'Say what to file…' : 'Message the worker…',
            ),
            h.Value(model.composer.draft),
            h.OnInput(text => Message.TypedDraft({ text })),
            h.Class(
              'min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted',
            ),
            h.Style({ fontSize: '13px' }),
          ]),
          ...(finished
            ? [
                button(
                  'File as a ticket',
                  Message.ClickedFileTicket(),
                  inputs.live &&
                    Option.isSome(
                      Conversation.sendable(model.composer.draft),
                    ) &&
                    !Filing.guards.Filing(model.filing),
                  h,
                ),
              ]
            : [
                h.button(
                  [
                    h.Type('submit'),
                    h.AriaLabel('Send'),
                    h.Disabled(!canSend),
                    h.Class('border border-line font-mono text-muted'),
                    h.Style({ fontSize: '11px', padding: '1px 6px' }),
                  ],
                  ['⏎'],
                ),
                button('Interrupt', Message.ClickedInterrupt(), canAct, h),
                ...(steered
                  ? [button('Release', Message.ClickedRelease(), canAct, h)]
                  : []),
              ]),
        ],
      ),
    ],
  )
}

export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  Option.match(model.shown, {
    onNone: () => note('No worker chosen.', h),
    onSome: worker =>
      h.div(
        [
          h.DataAttribute('layout', 'worker'),
          h.Class(
            'flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-line bg-panel',
          ),
        ],
        [
          h.div(
            [
              h.Class('flex items-start gap-16 border-b border-line'),
              h.Style({ padding: '12px' }),
            ],
            [ticketView(model, worker, h), figuresView(model, inputs, h)],
          ),
          transcriptView(model, h),
          composerView(model, inputs, h),
        ],
      ),
  }),
)
