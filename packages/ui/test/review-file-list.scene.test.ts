import { Option } from 'effect'
import {
  Subscription,
  all,
  click,
  expectAll,
  expect as expectScene,
  given,
  role,
  scene,
  text,
  withViewInputs,
} from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import {
  CommitHash,
  Diff,
  FileDiff,
  ProjectId,
  TicketId,
} from '@fabrica/contracts'
import * as VirtualList from '@foldkit/ui/virtualList'

import { localEngineName } from '../src/app/connection'
import * as Review from '../src/screens/review'
import { measured } from './virtual-list'

// Review's changed files as a virtual list (spec §18.5): a diff of many files draws only the rows in
// view, and the file chosen from further down is shown as one chosen from the top is. Another diff
// opened is listed from its top, its first file shown.

const project = { engine: localEngineName, project: ProjectId.make('p-1') }
const ticket = TicketId.make('fa-11')

/** How many files the diff changes: binary ones, which Monaco doesn't draw. */
const count = 500

const binary = (n: number, folder: string) => {
  const path = `${folder}/icon-${n}.png`
  return FileDiff.make({
    path,
    change: 'added',
    from: Option.none(),
    patch: `diff --git a/${path} b/${path}\nBinary files /dev/null and b/${path} differ\n`,
  })
}

const diffOf = (folder: string) =>
  Diff.make({
    base: CommitHash.make('a'.repeat(40)),
    head: CommitHash.make('b'.repeat(40)),
    files: Array.from({ length: count }, (_, n) => binary(n, folder)),
  })

const diff = diffOf('assets')

/** fa-11's branch diff, read. */
const shown: Review.Model = Review.update(
  Review.openTicket(Review.init(), { project, ticket }).model,
  Review.Message.SucceededLoadDiff({
    subject: Review.Subject.Ticket({ project, ticket }),
    diff,
  }),
).model

const view = withViewInputs(Review.view, { today: Option.none() })

const files = all.role('button', { name: /^assets\/icon-/u })

const file = (n: number, folder = 'assets') =>
  role('button', { name: new RegExp(`^${folder}/icon-${n}\\.png`, 'u') })

/** 600px show 14 rows of 44px, the 14th in part; 5 more are drawn below them. */
const drawnAtTop = 14 + 5

describe("a diff's changed files", () => {
  test('many files draw only the rows in view; one further down is chosen as one at the top', () => {
    const height = count * Review.fileRowHeightPx
    scene(
      { update: Review.update, view: view() },
      given(shown),
      measured('review-files'),
      expectAll(files).toHaveCount(drawnAtTop),
      expectScene(file(0)).toHaveAttr('aria-pressed', 'true'),
      expectScene(file(count - 1)).toBeAbsent(),
      Subscription.emit(
        Review.Message.GotFilesMessage({
          message: VirtualList.Message.ObservedContainerScroll({
            scrollTop: height - 600,
            scrollHeight: height,
            containerHeight: 600,
            anchor: { _tag: 'None' },
          }),
        }),
      ),
      expectScene(file(0)).toBeAbsent(),
      click(file(count - 1)),
      expectScene(file(count - 1)).toHaveAttr('aria-pressed', 'true'),
      expectScene(
        text(new RegExp(`b/assets/icon-${count - 1}\\.png differ`, 'u')),
      ).toExist(),
    )
  })

  test('another diff opened is listed from its top, its first file shown', () => {
    const height = count * Review.fileRowHeightPx
    const scrolledDown = Review.update(
      shown,
      Review.Message.GotFilesMessage({
        message: VirtualList.Message.ObservedContainerScroll({
          scrollTop: height - 600,
          scrollHeight: height,
          containerHeight: 600,
          anchor: { _tag: 'None' },
        }),
      }),
    ).model
    const other = TicketId.make('fa-12')
    const opened = Review.update(
      Review.openTicket(scrolledDown, { project, ticket: other }).model,
      Review.Message.SucceededLoadDiff({
        subject: Review.Subject.Ticket({ project, ticket: other }),
        diff: diffOf('other'),
      }),
    ).model
    scene(
      { update: Review.update, view: view() },
      given(opened),
      measured('review-files'),
      expectScene(file(0, 'other')).toHaveAttr('aria-pressed', 'true'),
      expectAll(all.role('button', { name: /^other\/icon-/u })).toHaveCount(
        drawnAtTop,
      ),
    )
  })
})
