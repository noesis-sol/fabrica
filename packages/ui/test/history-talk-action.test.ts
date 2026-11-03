import { Option } from 'effect'

import { describe, expect, test } from '@effect/vitest'
import { LocalTime, RunEvent, RunId, TicketId } from '@fabrica/contracts'

import { historyLine } from '../src/console/history'

// The run talk's actions in History (spec §15.4, §18.3): each in `c5`, with its own line.

describe('History', () => {
  test('shows the run talk’s action in c5, as its line', () => {
    expect(
      historyLine(
        RunEvent.cases.talk_action.make({
          time: LocalTime.make('2026-10-29T10:15:00.000+02:00'),
          run: RunId.make('2026-10-29T10:00:00.000+02:00'),
          actor: 'run_talk',
          tool: 'drain_run',
          ticket: TicketId.make('fa-7'),
          text: 'Run talk drained the run',
        }),
      ),
    ).toStrictEqual(
      Option.some({ role: 'c5', text: 'Run talk drained the run' }),
    )
  })
})
