import { Effect, Option, Stream } from 'effect'

import {
  type ProjectSettings,
  type ProviderName,
  StreamEpoch,
  UsageWindow,
  UsageWindowItem,
} from '@fabrica/contracts'

import { drawBase36 } from '../workgraph/ids'
import { type ModelProxyShape, ProxyEvent } from './server'
import type { UsageWindowFigure } from './windows'

// The usage windows a project's console shows (spec §12.9, §18.3, H90): those of the provider account
// its workers' model is called on, as the model proxy keeps them, a snapshot of their latest figures,
// then each window as it moves. A project whose settings name no model (the run asks for one) sees
// every account's. Each subscription numbers its own items under an epoch of its own, so a client that
// resumes gets a new snapshot: the windows are few, and the stream keeps no patches. Where the engine
// has no model proxy (its runs are refused), there are none.

/** The provider whose account's windows a project sees; none: every provider's. */
export const usageProvider = (
  settings: Option.Option<ProjectSettings>,
): Option.Option<ProviderName> =>
  Option.map(
    Option.flatMap(settings, ({ model }) => model),
    ({ provider }) => provider,
  )

/** A figure as the console shows it. */
const usageWindowOf = (figure: UsageWindowFigure): UsageWindow =>
  new UsageWindow({
    provider: figure.provider,
    window: figure.window,
    utilization: figure.utilization,
    resetsAt: figure.resetsAt,
  })

/** The windows of `provider`'s account, or of every account, from `proxy`, then each as it moves. */
export const watchUsageWindows = (options: {
  readonly proxy: Option.Option<ModelProxyShape>
  readonly provider: Option.Option<ProviderName>
}): Stream.Stream<UsageWindowItem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const epoch = StreamEpoch.make(`usage-${yield* drawBase36(12)}`)
      const seen = (figure: UsageWindowFigure) =>
        Option.match(options.provider, {
          onNone: () => true,
          onSome: provider => figure.provider === provider,
        })
      const snapshot = (figures: ReadonlyArray<UsageWindowFigure>) =>
        UsageWindowItem.cases.snapshot.make({
          epoch,
          seq: 0,
          value: figures.filter(seen).map(usageWindowOf),
        })
      if (Option.isNone(options.proxy))
        return Stream.concat(Stream.succeed(snapshot([])), Stream.never)
      const proxy = options.proxy.value
      // Subscribed before the figures are read, so no move between the two is missed; one seen in both
      // is sent again, the same.
      const events = yield* proxy.events
      const figures = yield* proxy.windows
      return Stream.concat(
        Stream.succeed(snapshot(figures)),
        events.pipe(
          Stream.filter(ProxyEvent.$is('Windowed')),
          Stream.map(({ figure }) => figure),
          Stream.filter(seen),
          Stream.map((figure, index) =>
            UsageWindowItem.cases.patch.make({
              seq: index + 1,
              value: usageWindowOf(figure),
            }),
          ),
        ),
      )
    }),
  )
