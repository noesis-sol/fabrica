import { Array, Effect, Match, Option, Schema } from 'effect'
import type { Html, HtmlBuilder } from 'foldkit/html'

import {
  MessageId,
  MessageRole,
  ModelName,
  type OpenedTalk,
  ProjectId,
  type TalkContext,
  TalkId,
  type TalkMode,
  Text,
  ToolCallId,
  type TranscriptEntry,
  type TranscriptItem,
} from '@fabrica/contracts'

import { requestEngine } from '../app/connection'
import { sayTokens, tokenTotal } from './stats'

// A talk as the app holds it (spec §15.4, §18.3, §18.4; Appendix A.2): the talk the engine opened, its
// transcript folded into the lines a chat pane draws (messages, and tool calls on one line each; thinking
// stays out), and the context its last turn used. Its requests (open, send, close) and its drawing (the
// header with the model and context use, the messages bottom-aligned, the composer) are this module's,
// for the console's talk panel and the Talks screen alike.

/** A line of a talk's chat pane. */
export const Line = Schema.TaggedUnion({
  /** A message, with its text so far. */
  said: { id: MessageId, role: MessageRole, text: Schema.String },
  /** A tool call; `ok` once it has ended. */
  tool: {
    id: ToolCallId,
    tool: Schema.String,
    ok: Schema.Option(Schema.Boolean),
  },
})
export type Line = typeof Line.Type

/** A talk the app holds, and its transcript so far. */
export const Conversation = Schema.Struct({
  talk: TalkId,
  project: ProjectId,
  mode: Schema.Literals(['refine', 'feature', 'answer', 'run']),
  model: ModelName,
  lines: Schema.Array(Line),
  /** The context the last turn used, in tokens; none before a turn has ended. */
  context: Schema.Option(Schema.Int),
  /** The transcript ended: the engine no longer has the talk. */
  ended: Schema.Boolean,
})
export type Conversation = typeof Conversation.Type

/** A talk just opened on `project` in `mode`, its transcript still to come. */
export const opened = (
  project: ProjectId,
  mode: TalkMode,
  talk: OpenedTalk,
): Conversation => ({
  talk: talk.talk,
  project,
  mode,
  model: talk.model,
  lines: [],
  context: Option.none(),
  ended: false,
})

/** `lines` with the line `matches` finds changed by `change`; the rest keep their identity. */
const changeLine = (
  lines: ReadonlyArray<Line>,
  matches: (line: Line) => boolean,
  change: (line: Line) => Line,
): ReadonlyArray<Line> =>
  lines.map(line => (matches(line) ? change(line) : line))

const isSaid =
  (id: MessageId) =>
  (line: Line): boolean =>
    line._tag === 'said' && line.id === id

const isTool =
  (id: ToolCallId) =>
  (line: Line): boolean =>
    line._tag === 'tool' && line.id === id

/** A conversation with one transcript entry applied. */
const applyEntry = (
  conversation: Conversation,
  entry: TranscriptEntry,
): Conversation =>
  Match.valueTags(entry, {
    message: ({ id, role, text }) => ({
      ...conversation,
      lines: [...conversation.lines, Line.cases.said.make({ id, role, text })],
    }),
    text: ({ message, delta }) => ({
      ...conversation,
      lines: changeLine(conversation.lines, isSaid(message), line =>
        line._tag === 'said' ? { ...line, text: line.text + delta } : line,
      ),
    }),
    thinking: () => conversation,
    tool_call: ({ id, tool }) => ({
      ...conversation,
      lines: [
        ...conversation.lines,
        Line.cases.tool.make({ id, tool, ok: Option.none() }),
      ],
    }),
    tool_output: () => conversation,
    tool_end: ({ id, ok }) => ({
      ...conversation,
      lines: changeLine(conversation.lines, isTool(id), line =>
        line._tag === 'tool' ? { ...line, ok: Option.some(ok) } : line,
      ),
    }),
    turn_end: ({ tokens }) => ({
      ...conversation,
      context: Option.match(tokens, {
        onNone: () => conversation.context,
        onSome: spent => Option.some(tokenTotal(spent)),
      }),
    }),
  })

/**
 * The conversation with a frame's transcript items applied: a snapshot is the transcript so far, which
 * takes the lines' place; a patch holds the entries since, which go on after them.
 */
export const applyTranscript = (
  conversation: Conversation,
  items: Array.NonEmptyReadonlyArray<TranscriptItem>,
): Conversation =>
  Array.reduce(items, conversation, (current, item) =>
    Array.reduce(
      item.value,
      item._tag === 'snapshot'
        ? { ...current, lines: [], context: Option.none() }
        : current,
      applyEntry,
    ),
  )

/** The header's model and context use, as the handoff writes them: `claude-opus-5-5 · 14k ctx`. */
export const modelWords = (conversation: Conversation): string =>
  Option.match(conversation.context, {
    onNone: () => conversation.model,
    onSome: tokens => `${conversation.model} · ${sayTokens(tokens)} ctx`,
  })

/** Each mode's name, as the header and the Talks screen's list say it. */
export const modeTitle: Record<TalkMode, string> = {
  run: 'Run talk',
  answer: 'Answer talk',
  refine: 'Refine',
  feature: 'Feature',
}

// The requests.

/** Opens a talk on `project` in `context`, with the project's model (§15.4). */
export const openTalk = (project: ProjectId, context: TalkContext) =>
  requestEngine(client =>
    client.rpc['talk.open']({ project, context, model: Option.none() }),
  )

const decodeText = Schema.decodeUnknownOption(Text)

/** The text a composer sends: its draft, trimmed, where it has any. */
export const sendable = (draft: string): Option.Option<string> =>
  decodeText(draft.trim())

/** Sends the maintainer's `text` to the talk. */
export const sendToTalk = (talk: TalkId, text: string) =>
  requestEngine(client => client.rpc['talk.send']({ talk, text }))

/** Closes the talk; one the engine no longer has is closed already. */
export const closeTalk = (talk: TalkId) =>
  requestEngine(client => client.rpc['talk.close']({ talk })).pipe(
    Effect.catch(() => Effect.void),
  )

// The composer.

/** What a composer's last send came to: nothing, a send going, or one that failed, with why. */
export const Sending = Schema.TaggedUnion({
  idle: {},
  sending: {},
  failed: { reason: Schema.String },
})
export type Sending = typeof Sending.Type

/** A composer: the text typed, and its last send. */
export const Composer = Schema.Struct({
  draft: Schema.String,
  sending: Sending,
})
export type Composer = typeof Composer.Type

export const emptyComposer: Composer = {
  draft: '',
  sending: Sending.cases.idle.make({}),
}

// The drawing.

/** What a conversation's view sends, and what its header and composer say. */
export interface ViewOptions<Message> {
  /** The header's name: the agent's, the handoff's "Hivemind". */
  readonly name: string
  /** The header's note beside the name: "orchestrator", or the talk's mode. */
  readonly note: string
  readonly placeholder: string
  readonly composer: Composer
  readonly typed: (text: string) => Message
  readonly submitted: Message
  /** Lines drawn above the composer, after the messages: a choice the panel asks for. */
  readonly footer?: ReadonlyArray<Html>
  /** Drawn in the header's right end, before the model: a control of the panel's. */
  readonly controls?: ReadonlyArray<Html>
  /** Said where there are no messages yet. */
  readonly empty?: string
}

const authorColour: Record<MessageRole, string> = {
  user: 'text-c1',
  assistant: 'text-c5',
  engine: 'text-muted',
}

const authorName = (role: MessageRole, agent: string): string =>
  role === 'user' ? 'You' : role === 'assistant' ? agent : 'Engine'

const lineView = <Message>(
  line: Line,
  agent: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    line.id,
    [
      h.DataAttribute('line', line._tag),
      h.Class('grid gap-8'),
      h.Style({ gridTemplateColumns: '64px minmax(0,1fr)' }),
    ],
    line._tag === 'said'
      ? [
          h.span(
            [
              h.Class(`font-extrabold ${authorColour[line.role]}`),
              h.Style({ fontSize: '12px' }),
            ],
            [authorName(line.role, agent)],
          ),
          h.span([h.Class('whitespace-pre-wrap break-words')], [line.text]),
        ]
      : [
          h.span(
            [h.Class('font-mono text-muted'), h.Style({ fontSize: '12px' })],
            ['tool'],
          ),
          h.span(
            [h.Class('font-mono text-muted'), h.Style({ fontSize: '12px' })],
            [
              Option.match(line.ok, {
                onNone: () => `${line.tool} …`,
                onSome: ok => `${line.tool} ${ok ? '✓' : '✗'}`,
              }),
            ],
          ),
        ],
  )

const header = <Message>(
  conversation: Option.Option<Conversation>,
  options: ViewOptions<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('flex items-center gap-8 border-b border-line'),
      h.Style({ padding: '8px 12px' }),
    ],
    [
      h.span([h.Class('bg-c5'), h.Style({ width: '8px', height: '8px' })]),
      h.h2(
        [h.Class('font-extrabold'), h.Style({ fontSize: '13px' })],
        [options.name],
      ),
      h.span([h.Class('text-xs text-muted')], [options.note]),
      h.div(
        [h.Class('ml-auto flex items-center gap-8')],
        [
          ...(options.controls ?? []),
          ...Option.match(conversation, {
            onNone: () => [],
            onSome: shown => [
              h.span(
                [
                  h.DataAttribute('talk-model', ''),
                  h.Class('font-mono text-muted'),
                  h.Style({ fontSize: '11px' }),
                ],
                [modelWords(shown)],
              ),
            ],
          }),
        ],
      ),
    ],
  )

const composerView = <Message>(
  options: ViewOptions<Message>,
  enabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [
      h.AriaLabel('Composer'),
      h.OnSubmit(options.submitted),
      h.Class('flex items-center gap-8 border-t border-line'),
      h.Style({ padding: '8px 12px' }),
    ],
    [
      h.span([h.Class('font-mono font-bold text-c1')], ['›']),
      h.input([
        h.Type('text'),
        h.AriaLabel('Message'),
        h.Placeholder(options.placeholder),
        h.Value(options.composer.draft),
        h.Disabled(!enabled),
        h.OnInput(options.typed),
        h.Class(
          'min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus-visible:outline-none',
        ),
        h.Style({ fontSize: '13px' }),
      ]),
      h.button(
        [
          h.Type('submit'),
          h.AriaLabel('Send'),
          h.Disabled(
            !enabled ||
              Option.isNone(sendable(options.composer.draft)) ||
              options.composer.sending._tag === 'sending',
          ),
          h.Class('border border-line font-mono text-muted'),
          h.Style({ fontSize: '11px', padding: '1px 6px' }),
        ],
        ['⏎'],
      ),
    ],
  )

/**
 * A conversation's pane: its header (the agent's name, its note, the model and the context use), its
 * messages bottom-aligned and scrolling once they overflow, a failed send's reason, and its composer.
 * With no conversation, the header and composer alone, `empty` said between them. The messages are one
 * column inside a reversed one: a short talk sits at the bottom, a long one scrolls up to its first
 * line and stays on its newest as lines arrive (`justify-content: flex-end` would push the overflow
 * above the scroll box, out of reach).
 */
export const view = <Message>(
  conversation: Option.Option<Conversation>,
  options: ViewOptions<Message>,
  enabled: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const lines = Option.match(conversation, {
    onNone: () => [],
    onSome: shown => shown.lines,
  })
  return h.div(
    [h.Class('flex min-h-0 flex-1 flex-col')],
    [
      header(conversation, options, h),
      h.div(
        [
          h.Role('log'),
          h.AriaLabel('Messages'),
          h.Class('flex min-h-0 flex-1 flex-col-reverse overflow-auto'),
          h.Style({
            padding: '8px 12px',
            fontSize: '12.5px',
            lineHeight: '1.35',
          }),
        ],
        [
          h.div(
            [h.Class('flex flex-col'), h.Style({ gap: '6px' })],
            [
              ...(lines.length === 0 && options.empty !== undefined
                ? [h.p([h.Class('text-xs text-muted')], [options.empty])]
                : lines.map(line => lineView(line, options.name, h))),
              ...(Option.exists(conversation, shown => shown.ended)
                ? [
                    h.p(
                      [h.Class('text-xs text-muted')],
                      ['The talk has ended.'],
                    ),
                  ]
                : []),
              ...(options.footer ?? []),
              ...(options.composer.sending._tag === 'failed'
                ? [
                    h.p(
                      [h.Role('alert'), h.Class('text-xs text-c3')],
                      [`Not sent: ${options.composer.sending.reason}`],
                    ),
                  ]
                : []),
            ],
          ),
        ],
      ),
      composerView(options, enabled, h),
    ],
  )
}
