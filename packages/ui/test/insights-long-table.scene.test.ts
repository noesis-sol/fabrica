import { Option, Schema } from 'effect'
import * as AsyncData from 'foldkit/asyncData'
import {
  Subscription,
  all,
  expectAll,
  expect as expectScene,
  given,
  role,
  scene,
  selector,
  withViewInputs,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import { InsightsTable } from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import * as Insights from '../src/screens/insights'
import { measured } from './virtual-list'

// A long Insights table as a virtual list (spec §18.5): its rows are a list at most `rowsInView` rows
// high under its column headers, only the rows in view drawn, the others as they are scrolled to.

/** How many rows the tokens' answer has: a run each. */
const count = 1_000

const tokens = Schema.decodeUnknownSync(InsightsTable)({
  columns: [
    { name: 'Run', unit: 'text' },
    { name: 'Tokens in', unit: 'tokens' },
  ],
  rows: Array.from({ length: count }, (_, n) => [`r-${n}`, 1_000 * n]),
})

/** The screen with the tokens answered: the other panels still ask. */
const answered: Insights.Model = {
  ...Insights.init(),
  tables: { ...Insights.init().tables, tokens: AsyncData.succeed(tokens) },
}

const view = withViewInputs(Insights.view, {
  projectName: Option.none(),
  today: Option.none(),
})

const rows = all.selector('[data-virtual-list-item-index]')

const row = (n: number) => selector(`[data-virtual-list-item-index="${n}"]`)

/** The rows in view, and 5 more drawn below them. */
const drawnAtTop = Insights.rowsInView + 5

describe('a long Insights table', () => {
  test('draws only the rows in view, the others as they are scrolled to', () => {
    const height = Insights.rowsInView * Insights.rowHeightPx
    scene(
      { update: Insights.update, view: view() },
      given(answered),
      // The list scrolls, in a holder `rowsInView` rows high.
      expectScene(selector('[data-rows]')).toHaveStyle('height', `${height}px`),
      expectScene(
        role('list', { name: Insights.panelTitle.tokens }),
      ).toHaveStyle('overflow', 'auto'),
      measured('insights-tokens', height),
      expectAll(rows).toHaveCount(drawnAtTop),
      expectScene(row(0)).toContainText('r-0'),
      expectScene(row(count - 1)).toBeAbsent(),
      Subscription.emit(
        Insights.Message.GotListMessage({
          panelId: 'tokens',
          message: VirtualList.Message.ObservedContainerScroll({
            scrollTop: count * Insights.rowHeightPx - height,
            scrollHeight: count * Insights.rowHeightPx,
            containerHeight: height,
            anchor: { _tag: 'None' },
          }),
        }),
      ),
      expectScene(row(0)).toBeAbsent(),
      expectScene(row(count - 1)).toContainText(`r-${count - 1}999k`),
    )
  })
})
