import { Option } from 'effect'
import * as AsyncData from 'foldkit/asyncData'
import {
  expect as expectScene,
  given as givenScene,
  role,
  scene,
  text,
  within,
} from 'foldkit/scene'
import { Command, given, message, model, story } from 'foldkit/story'

import { describe, expect, test } from '@effect/vitest'
import {
  EngineId,
  GateCounts,
  GateReason,
  ProjectId,
  RunId,
  TicketId,
  protocolVersion,
} from '@fabrica/contracts'

import { Connection, localEngineName } from '../src/app/connection'
import type { EngineProject } from '../src/app/engine-project'
import { type Model, initialModel } from '../src/app/model'
import { Screen } from '../src/app/screen'
import { update } from '../src/app/update'
import { view } from '../src/app/view'
import * as Review from '../src/screens/review'

// What the gate decided, on the Review screen (spec §12.6, §18.4): beside a ticket's diff its counts and
// reasons, beside a run's diff each ticket's, read as the subject is shown; an answer about another
// subject is dropped.

const project = ProjectId.make('p-1')
const scoped: EngineProject = { engine: localEngineName, project }
const ticket = TicketId.make('fa-11')
const other = TicketId.make('fa-12')
const run = RunId.make('r-7')

const ticketSubject = Review.Subject.Ticket({ project: scoped, ticket })
const runSubject = Review.Subject.Run({ project: scoped, run })

const counts = GateCounts.make({
  ticket,
  allowed: 12,
  asked: 1,
  refused: 2,
  reasons: [
    GateReason.make({
      verdict: 'refused',
      reason: 'git push: workers never push',
      count: 2,
    }),
    GateReason.make({
      verdict: 'asked',
      reason: 'writes outside the worktree',
      count: 1,
    }),
  ],
})

const otherCounts = GateCounts.make({
  ticket: other,
  allowed: 3,
  asked: 0,
  refused: 0,
  reasons: [],
})

/** The Review screen on a ticket's diff, its answers yet to come. */
const openTicket = Review.openTicket(Review.init(), {
  project: scoped,
  ticket,
}).model

const connected: Model = {
  ...initialModel({ platform: 'darwin', release: '0.0.0' }),
  connection: Connection.Up({
    engine: EngineId.make('e-1'),
    release: '0.1.0',
    protocol: protocolVersion,
  }),
  scope: Option.some(scoped),
  screen: Screen.Review(),
}

/** The app on the Review screen, showing `review`. */
const showing = (review: Review.Model): Model => ({
  ...connected,
  screens: { ...connected.screens, review },
})

const gate = () => role('region', { name: 'Gate decisions' })

describe("the Review screen's gate decisions", () => {
  test('a ticket shown asks for its own, and an answer about another subject is dropped', () => {
    const opened = Review.openTicket(Review.init(), {
      project: scoped,
      ticket,
    })
    expect(opened.commands?.map(({ name }) => name)).toContain('LoadGate')
    story(
      Review.update,
      given(opened.model),
      message(
        Review.Message.SucceededLoadGate({
          subject: runSubject,
          counts: [otherCounts],
        }),
      ),
      model(shown => {
        expect(AsyncData.isLoading(shown.gate)).toBe(true)
      }),
      message(
        Review.Message.SucceededLoadGate({
          subject: ticketSubject,
          counts: [counts],
        }),
      ),
      model(shown => {
        expect(AsyncData.getData(shown.gate)).toEqual(Option.some([counts]))
      }),
    )
  })

  test("a run's diff asked for from its report reads the run's", () => {
    story(
      Review.update,
      given(openTicket),
      message(Review.Message.RequestedRunDiff({ project: scoped, run })),
      Command.expectExact(
        Review.LoadDiff({ subject: runSubject }),
        Review.LoadGate({ subject: runSubject }),
      ),
      Command.resolveAll(
        [
          Review.LoadDiff,
          Review.Message.FailedLoadDiff({
            subject: runSubject,
            reason: 'gone',
          }),
        ],
        [
          Review.LoadGate,
          Review.Message.SucceededLoadGate({
            subject: runSubject,
            counts: [counts, otherCounts],
          }),
        ],
      ),
      model(shown => {
        expect(AsyncData.getData(shown.gate)).toEqual(
          Option.some([counts, otherCounts]),
        )
      }),
    )
  })

  test('beside a ticket: each verdict counted, and the reasons', () => {
    scene(
      { update, view },
      givenScene(
        showing(
          Review.update(
            openTicket,
            Review.Message.SucceededLoadGate({
              subject: ticketSubject,
              counts: [counts],
            }),
          ).model,
        ),
      ),
      expectScene(
        within(gate(), text('12 allowed · 1 asked · 2 refused')),
      ).toExist(),
      expectScene(
        within(gate(), text('Refused 2×: git push: workers never push')),
      ).toExist(),
      expectScene(
        within(gate(), text('Asked 1×: writes outside the worktree')),
      ).toExist(),
    )
  })

  test('beside a run: each of its tickets, named', () => {
    const onRun = Review.update(
      openTicket,
      Review.Message.RequestedRunDiff({ project: scoped, run }),
    ).model
    scene(
      { update, view },
      givenScene(
        showing(
          Review.update(
            onRun,
            Review.Message.SucceededLoadGate({
              subject: runSubject,
              counts: [counts, otherCounts],
            }),
          ).model,
        ),
      ),
      expectScene(within(gate(), text('fa-11'))).toExist(),
      expectScene(within(gate(), text('fa-12'))).toExist(),
      expectScene(
        within(gate(), text('3 allowed · 0 asked · 0 refused')),
      ).toExist(),
    )
  })

  test('says so where nothing was recorded, or the read failed', () => {
    const answered = (message: Review.Message) =>
      showing(Review.update(openTicket, message).model)
    scene(
      { update, view },
      givenScene(
        answered(
          Review.Message.SucceededLoadGate({
            subject: ticketSubject,
            counts: [],
          }),
        ),
      ),
      expectScene(within(gate(), text('No decisions recorded.'))).toExist(),
    )
    scene(
      { update, view },
      givenScene(
        answered(
          Review.Message.FailedLoadGate({
            subject: ticketSubject,
            reason: 'the store is gone',
          }),
        ),
      ),
      expectScene(
        within(
          gate(),
          text("The gate's decisions couldn't be read: the store is gone"),
        ),
      ).toExist(),
    )
  })
})
