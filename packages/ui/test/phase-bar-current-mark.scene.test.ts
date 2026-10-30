import {
  expect as expectScene,
  given,
  scene,
  selector,
  within,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'

import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as InProgress from '../src/console/in-progress'
import { consoleScene } from './fixtures/console-scene'

// The phase bar's current segment is marked by its shape as well as its colour (spec H63, §18.2,
// H45): twice as tall as the passed and ahead segments, centred on the bar, which keeps its height,
// so that working and verifying tell apart without colour even when the step line shows a worker's
// action instead of the phase.

/** The look test's console scene, without its History, which needs its list's mount resolved. */
const withoutHistory = { ...consoleScene(), events: [] }

const card = (ticket: string) => selector(`[data-ticket="${ticket}"]`)
const bar = (ticket: string) =>
  within(card(ticket), selector('[data-phase-bar]'))
const segment = (ticket: string, name: string) =>
  within(card(ticket), selector(`[data-segment="${name}"]`))

describe("the phase bar's current segment", () => {
  test('working: the first segment taller than those ahead', () => {
    scene(
      { update, view },
      given(withoutHistory),
      expectScene(segment('eng-412', 'working')).toHaveStyle(
        'height',
        InProgress.currentSegmentHeight,
      ),
      ...['verifying', 'waiting_to_merge', 'merging'].map(name =>
        expectScene(segment('eng-412', name)).toHaveStyle(
          'height',
          InProgress.barHeight,
        ),
      ),
    )
  })

  test('verifying: its segment taller than the passed one, which is as tall as those ahead', () => {
    scene(
      { update, view },
      given(withoutHistory),
      expectScene(segment('eng-398', 'verifying')).toHaveStyle(
        'height',
        InProgress.currentSegmentHeight,
      ),
      ...['working', 'waiting_to_merge', 'merging'].map(name =>
        expectScene(segment('eng-398', name)).toHaveStyle(
          'height',
          InProgress.barHeight,
        ),
      ),
    )
  })

  test('waiting to merge: its segment taller than the passed ones', () => {
    scene(
      { update, view },
      given(withoutHistory),
      expectScene(segment('eng-421', 'waiting_to_merge')).toHaveStyle(
        'height',
        InProgress.currentSegmentHeight,
      ),
      ...['working', 'verifying', 'merging'].map(name =>
        expectScene(segment('eng-421', name)).toHaveStyle(
          'height',
          InProgress.barHeight,
        ),
      ),
    )
  })

  test('the bar keeps its height, its segments centred on it, so the card does not move', () => {
    scene(
      { update, view },
      given(withoutHistory),
      ...['eng-412', 'eng-398', 'eng-421', 'eng-430'].flatMap(ticket => [
        expectScene(bar(ticket)).toHaveStyle('height', InProgress.barHeight),
        expectScene(bar(ticket)).toHaveClass('items-center'),
      ]),
    )
  })
})
