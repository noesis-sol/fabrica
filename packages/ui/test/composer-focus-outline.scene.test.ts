import { Option } from 'effect'
import { expect as expectScene, given, role, scene } from 'foldkit/scene'

import { describe, test } from '@effect/vitest'
import { OpenedTalk, SessionId, TalkId, TicketId } from '@fabrica/contracts'

import { Message } from '../src/app/message'
import type { Model } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Talks from '../src/screens/talks'
import { consoleScene } from './fixtures/console-scene'

// A focused composer is outlined (spec §18.2 Hover and focus, H63): its input keeps the base
// `:focus-visible` rule of theme/tokens.css (a 2px --c1 outline, 2px off), so focus shows by more
// than the caret. The talk panel's, the Talks screen's and the worker screen's composers carry no
// class that takes the outline away.

/** The look test's console scene, without its History, which needs its list's mount resolved. */
const onConsole: Model = { ...consoleScene(), events: [] }

const received = (...messages: ReadonlyArray<Message>): Model =>
  messages.reduce((before, next) => update(before, next).model, onConsole)

const project = Option.getOrThrow(onConsole.scope)

/** Tailwind's classes that take the outline away, as they are and under a focus variant. */
const unoutlining = ['outline-none', 'outline-hidden', 'outline-0'].flatMap(
  name => [name, `focus:${name}`, `focus-visible:${name}`],
)

/** The composer's input carries none of them: the base rule outlines it once it has focus. */
const outlinedWhenFocused = (shown: Model): void =>
  scene(
    { update, view },
    given(shown),
    expectScene(role('textbox', { name: 'Message' })).toExist(),
    ...unoutlining.map(name =>
      expectScene(role('textbox', { name: 'Message' })).not.toHaveClass(name),
    ),
  )

describe('the focused composer', () => {
  test("the talk panel's is outlined", () => {
    outlinedWhenFocused(onConsole)
  })

  test("the Talks screen's is outlined", () => {
    outlinedWhenFocused(
      received(
        Message.RequestedScreen({ screen: Screen.Talks() }),
        Message.GotTalksMessage({
          message: Talks.Message.OpenedTalk({
            project,
            mode: 'feature',
            opened: new OpenedTalk({
              talk: TalkId.make('t-feature'),
              session: SessionId.make('s-feature'),
              model: 'claude-opus-5-5',
            }),
          }),
        }),
      ),
    )
  })

  test("the worker screen's is outlined", () => {
    outlinedWhenFocused(
      received(
        Message.RequestedScreen({
          screen: Screen.Worker({ project, ticket: TicketId.make('eng-412') }),
        }),
      ),
    )
  })
})
