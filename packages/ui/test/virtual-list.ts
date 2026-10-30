import { Effect, Schema } from 'effect'
import { Command } from 'foldkit'
import { Mount, Command as SceneCommand } from 'foldkit/scene'

import * as VirtualList from '@foldkit/ui/virtualList'

// A virtual list's steps in a scene: the list measured by its Mount (`ObserveVirtualList`, matched by its
// name), as the browser reports it, since rows are drawn only once it is; and a scroll it asks for, as
// it moves to its end or keeps the row read in place, taken as done.

const decodeMessage = Schema.decodeUnknownSync(VirtualList.Message)

/** The list `id` measured `height` high: its rows in view are drawn. */
export const measured = (id: string, height = 600, width = 800) =>
  Mount.resolve(
    { name: 'ObserveVirtualList', args: { id } },
    decodeMessage({
      _tag: 'ResizedContainer',
      containerWidth: width,
      containerHeight: height,
    }),
  )

/**
 * A stand-in for the list's `ApplyScroll`, which @foldkit/ui doesn't export: a scene resolves a pending
 * Command by its definition's name.
 */
const ApplyScroll = Command.define('ApplyScroll', {
  messages: [VirtualList.Message.CompletedApplyScroll],
  execute: Effect.die('a stand-in, never run'),
})

/** Where the browser scrolled the list to, and how high its content and its view are. */
export interface Scroll {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly containerHeight: number
}

/** The list's pending scroll, its `version`th, done: the list at `scroll`, by default its content in view. */
export const scrolled = (
  version: number,
  scroll: Scroll = { scrollTop: 0, scrollHeight: 600, containerHeight: 600 },
) =>
  SceneCommand.resolve(
    ApplyScroll,
    decodeMessage({
      _tag: 'CompletedApplyScroll',
      version,
      outcome: { _tag: 'Applied', ...scroll, anchor: { _tag: 'None' } },
    }),
  )
