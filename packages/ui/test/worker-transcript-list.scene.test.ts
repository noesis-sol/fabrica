import { Option, Schema } from 'effect'
import {
  Mount,
  Subscription,
  all,
  expectAll,
  expect as expectScene,
  given,
  scene,
  selector,
  text,
  withViewInputs,
} from 'foldkit/scene'

import { describe, expect, test } from '@effect/vitest'
import { ProjectId, TicketId, TranscriptItem } from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { localEngineName } from '../src/app/connection'
import * as Worker from '../src/screens/worker'
import { measured, scrolled } from './virtual-list'

// The worker's transcript as a virtual list (spec §18.5): a long session draws only the blocks in view,
// its end first, so only their tool calls' terminals and their edits' diff views are made; a block
// that leaves the view leaves the page, its Mount's scope closing on its terminal or its diff view. A
// block that comes is followed; text that streams only grows the block it is in.

const worker: Worker.Shown = {
  project: { engine: localEngineName, project: ProjectId.make('p-1') },
  ticket: TicketId.make('fa-7'),
}

const at = Date.UTC(2026, 9, 29, 12, 0, 0)

const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(TranscriptItem))

const snapshot = (...value: ReadonlyArray<unknown>) =>
  decodeItem({ _tag: 'snapshot', epoch: 'epoch-t', seq: 0, value })

const patch = (seq: number, ...value: ReadonlyArray<unknown>) =>
  decodeItem({ _tag: 'patch', seq, value })

/** The `n`th tool call: a bash command, its output, its end. */
const bashCall = (n: number): ReadonlyArray<unknown> => [
  {
    _tag: 'tool_call',
    id: `call-${n}`,
    tool: 'bash',
    input: { command: `echo ${n}` },
    at,
  },
  { _tag: 'tool_output', id: `call-${n}`, chunk: `${n}\n` },
  { _tag: 'tool_end', id: `call-${n}`, ok: true, at },
]

/** How many tool calls the long session made. */
const calls = 300

/** fa-7's worker view, its transcript `calls` tool calls long. */
const long: Worker.Model = Worker.receivedTranscript(
  Worker.opened(Worker.init(), worker).model,
  worker,
  [
    snapshot(
      ...Array.from({ length: calls }, (_, index) => bashCall(index)).flat(),
    ),
  ],
).model

const view = withViewInputs(Worker.view, {
  live: true,
  now: Option.none(),
  row: Option.none(),
  usage: Option.none(),
  runTokens: Option.none(),
})

const listMessage = (message: VirtualList.Message) =>
  Worker.Message.GotListMessage({ message })

const block = selector('[data-block]')
const blocks = all.selector('[data-block]')

const firstVersion = long.list.pendingScrollVersion + 1

/** The long session's height, its blocks as yet unmeasured. */
const longHeight = long.transcript.blocks.reduce(
  (height, each) => height + Worker.estimatedHeightPx(each),
  0,
)

/** Scrolled to its end, as the list asks as it is first measured. */
const atEnd = {
  scrollTop: longHeight - 600,
  scrollHeight: longHeight,
  containerHeight: 600,
}

/**
 * The blocks drawn at either end: 600px show three of a terminal each (a part of one), and two more are
 * drawn beyond them, on the side the list goes on.
 */
const drawn = 5

/** Each of the `count` terminals drawn has drawn its output. */
const outputsShown = (count: number) =>
  Mount.resolveAll(
    ...Array.from(
      { length: count },
      () => [Worker.ShowOutput, Worker.Message.CompletedShowView()] as const,
    ),
  )

describe("the worker's transcript", () => {
  test('a long session draws its end first, and makes terminals only for the blocks in view', () => {
    scene(
      { update: Worker.update, view: view() },
      given(long),
      expectScene(block).toBeAbsent(),
      measured('transcript'),
      scrolled(firstVersion, atEnd),
      expectAll(blocks).toHaveCount(drawn),
      expectScene(text(`bash ✓`)).toExist(),
      expectScene(
        selector(`[data-virtual-list-item-key="tool:call-${calls - 1}"]`),
      ).toExist(),
      expectScene(
        selector('[data-virtual-list-item-key="tool:call-0"]'),
      ).toBeAbsent(),
      Mount.expectExact(
        ...Array.from({ length: drawn }, () => Worker.ShowOutput),
      ),
      outputsShown(drawn),
    )
  })

  test('scrolled to its start, its end leaves the page and as many blocks are drawn there', () => {
    scene(
      { update: Worker.update, view: view() },
      given(long),
      measured('transcript'),
      scrolled(firstVersion, atEnd),
      outputsShown(drawn),
      Subscription.emit(
        listMessage(
          VirtualList.Message.ObservedContainerScroll({
            scrollTop: 0,
            scrollHeight: longHeight,
            containerHeight: 600,
            anchor: { _tag: 'None' },
          }),
        ),
      ),
      expectScene(
        selector('[data-virtual-list-item-key="tool:call-0"]'),
      ).toExist(),
      expectScene(
        selector(`[data-virtual-list-item-key="tool:call-${calls - 1}"]`),
      ).toBeAbsent(),
      expectAll(blocks).toHaveCount(drawn),
    )
  })

  test('a block that comes is followed; streamed text only grows its block', () => {
    const commandNames = (result: ReturnType<typeof Worker.update>) =>
      (result.commands ?? []).map(command => command.name)
    const said = Worker.receivedTranscript(long, worker, [
      patch(1, {
        _tag: 'message',
        id: 'm-1',
        role: 'assistant',
        text: 'Done',
        at,
      }),
    ])
    // `long` waits on its draw: the message is drawn as the wait ends.
    const came = Worker.update(said.model, Worker.Message.CompletedWaitToDraw())
    expect(commandNames(came)).toEqual(['WaitToDraw', 'ApplyScroll'])
    expect(came.model.list.layoutVersion).toBe(long.list.layoutVersion + 1)
    const grew = Worker.update(
      Worker.receivedTranscript(came.model, worker, [
        patch(2, { _tag: 'text', message: 'm-1', delta: ', all green.' }),
      ]).model,
      Worker.Message.CompletedWaitToDraw(),
    )
    expect(commandNames(grew)).toEqual(['WaitToDraw'])
    expect(grew.model.list.layoutVersion).toBe(came.model.list.layoutVersion)
  })

  test("a block's height before it is measured: its diff view's and its terminal's", () => {
    const tool = (input: Option.Option<Schema.Json>, output: string) =>
      Worker.Block.cases.tool.make({
        id: Schema.decodeSync(Worker.Block.cases.tool.fields.id)('call-1'),
        tool: 'edit',
        input,
        output,
        ok: Option.none(),
      })
    const edit = {
      path: 'src/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    }
    expect(Worker.estimatedHeightPx(tool(Option.none(), ''))).toBe(
      Worker.blockHeightPx,
    )
    expect(Worker.estimatedHeightPx(tool(Option.some(edit), ''))).toBe(
      Worker.blockHeightPx + 200,
    )
    expect(Worker.estimatedHeightPx(tool(Option.some(edit), 'ok\n'))).toBe(
      Worker.blockHeightPx + 200 + 12 * 17 + 8,
    )
  })
})
