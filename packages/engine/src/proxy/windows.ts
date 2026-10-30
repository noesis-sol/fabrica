import { DateTime, Option } from 'effect'
import type { IncomingHttpHeaders } from 'node:http'

import type { ProviderName } from '@fabrica/contracts'

import type { SecretName } from '../secrets'
import { epochSeconds, headerOf } from './refusal'

// A subscription's usage windows (spec §12.9, H90), read by the model proxy from the headers of every
// response it passes on, allowed ones too, not only refusals: Anthropic's five-hour and seven-day
// utilisation (`anthropic-ratelimit-unified-5h-*`, `-7d-*`: a fraction from 0 to 1, a reset in epoch
// seconds) and OpenAI ChatGPT's primary and secondary windows (`x-codex-primary-*`,
// `x-codex-secondary-*`: a percent from 0 to 100, the window's minutes, a reset in epoch seconds).
// Other providers report none on their responses. Each window is named as the console names it
// (`five_hour`, `seven_day`, …), so the same window reads the same from either provider.

/** One window as a response reported it. */
export interface WindowReading {
  /** `five_hour`, `seven_day`, … */
  readonly window: string
  /** The share of the window used, from 0 to 1. */
  readonly utilization: number
  readonly resetsAt: Option.Option<DateTime.Utc>
}

/** A window's latest figure for a provider's account, as the proxy keeps and serves it. */
export interface UsageWindowFigure extends WindowReading {
  readonly provider: ProviderName
  /** The account's credential name; none for a provider reached with no credential. */
  readonly account: Option.Option<SecretName>
}

const number = (text: string): Option.Option<number> =>
  /^-?\d+(?:\.\d+)?$/u.test(text) ? Option.some(Number(text)) : Option.none()

const share = (fraction: number): number => Math.min(1, Math.max(0, fraction))

/** Anthropic's windows, by their headers' name for them. */
const anthropicWindows: ReadonlyArray<{
  readonly key: string
  readonly window: string
}> = [
  { key: '5h', window: 'five_hour' },
  { key: '7d', window: 'seven_day' },
]

const anthropic = (
  headers: IncomingHttpHeaders,
): ReadonlyArray<WindowReading> =>
  anthropicWindows.flatMap(({ key, window }) => {
    const prefix = `anthropic-ratelimit-unified-${key}`
    return Option.match(
      Option.flatMap(headerOf(headers, `${prefix}-utilization`), number),
      {
        onNone: () => [],
        onSome: utilization => [
          {
            window,
            utilization: share(utilization),
            resetsAt: Option.flatMap(
              headerOf(headers, `${prefix}-reset`),
              epochSeconds,
            ),
          },
        ],
      },
    )
  })

/** ChatGPT's windows by their length in minutes, as the console names them; others by their minutes. */
const windowsByMinutes: ReadonlyMap<number, string> = new Map([
  [300, 'five_hour'],
  [1440, 'one_day'],
  [10_080, 'seven_day'],
])

const codexName = (
  slot: 'primary' | 'secondary',
  minutes: Option.Option<number>,
): string =>
  Option.match(minutes, {
    onNone: () => slot,
    onSome: length => windowsByMinutes.get(length) ?? `${length}_minute`,
  })

const codex = (headers: IncomingHttpHeaders): ReadonlyArray<WindowReading> =>
  (['primary', 'secondary'] as const).flatMap(slot => {
    const prefix = `x-codex-${slot}`
    return Option.match(
      Option.flatMap(headerOf(headers, `${prefix}-used-percent`), number),
      {
        onNone: () => [],
        onSome: percent => [
          {
            window: codexName(
              slot,
              Option.flatMap(
                headerOf(headers, `${prefix}-window-minutes`),
                number,
              ),
            ),
            utilization: share(percent / 100),
            resetsAt: Option.flatMap(
              headerOf(headers, `${prefix}-reset-at`),
              epochSeconds,
            ),
          },
        ],
      },
    )
  })

/** The usage windows a response's headers report, whichever provider's they are; none for most. */
export const windowsOf = (
  headers: IncomingHttpHeaders,
): ReadonlyArray<WindowReading> => [...anthropic(headers), ...codex(headers)]

/** Whether `reading` says something other than `figure`: its share or its reset moved. */
export const windowChanged = (
  figure: WindowReading,
  reading: WindowReading,
): boolean =>
  figure.utilization !== reading.utilization ||
  !Option.makeEquivalence(DateTime.Equivalence)(
    figure.resetsAt,
    reading.resetsAt,
  )
