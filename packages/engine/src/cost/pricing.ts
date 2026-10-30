import { Data, Option } from 'effect'

import { calculateCost } from '@earendil-works/pi-ai/models'
import {
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all'
import type { ModelName, ProviderName, Tokens } from '@fabrica/contracts'

// A model call's price (spec §14.4), from pi-ai's tables: each built-in model's price in US dollars
// per million tokens of each kind, with its input-size tiers, as pi-ai's `calculateCost` reads them
// (the providers spike, fab-mgi.2.4). A call on an API key is priced in money; a subscription's call
// is counted in tokens, and priced at the same table as its API-price equivalent, shown as such
// (subscription-only catalogs, `openai-codex` and `github-copilot`, carry API-equivalent prices). A
// model the tables don't have (a local model's, one newer than the pinned Pi) is left unpriced.

/** How a provider's calls are paid for: an API key's in money, a subscription's in its own allowance. */
export type Billing = 'api_key' | 'subscription'

/** A model call's price. */
export type Price = Data.TaggedEnum<{
  /** Money: an API-key call at its model's price. */
  Paid: { readonly usd: number }
  /** A subscription's call at the API price it would have cost. */
  Equivalent: { readonly usd: number }
  /** The tables have no price for its model. */
  Unpriced: {}
}>
export const Price = Data.taggedEnum<Price>()

/** A call to price: its provider and model, the tokens it used, and how its provider is paid for. */
export interface PricedCall {
  readonly provider: ProviderName
  readonly model: ModelName
  readonly tokens: Tokens
  readonly billing: Billing
}

/** What a call's tokens cost at its model's price, in US dollars; none where the tables have no price for it. */
export type PriceTable = (call: {
  readonly provider: ProviderName
  readonly model: ModelName
  readonly tokens: Tokens
}) => Option.Option<number>

type CatalogModel = ReturnType<typeof getBuiltinModels>[number]

/** A model's ID in its provider's catalog: `<provider>/<id>` names it with its provider, which the catalog doesn't. */
const idOf = (provider: ProviderName, model: ModelName): string =>
  model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model

/**
 * pi-ai's tables, its built-in chat models read once by provider and model ID. Tokens are orchestra's
 * four, so a cache write is priced at the model's write price; the dearer price of Anthropic's one-hour
 * cache writes, which the proxy doesn't tell apart, isn't applied.
 */
export const piPriceTable = (): PriceTable => {
  const catalog: ReadonlyMap<string, CatalogModel> = new Map(
    getBuiltinProviders().flatMap(provider =>
      getBuiltinModels(provider).map(
        model => [`${provider}\n${model.id}`, model] as const,
      ),
    ),
  )
  return ({ provider, model, tokens }) =>
    Option.map(
      Option.fromNullishOr(
        catalog.get(`${provider}\n${idOf(provider, model)}`),
      ),
      found =>
        calculateCost(found, {
          input: tokens.input,
          output: tokens.output,
          cacheRead: tokens.cache_read,
          cacheWrite: tokens.cache_write,
          totalTokens:
            tokens.input +
            tokens.output +
            tokens.cache_read +
            tokens.cache_write,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }).total,
    )
}

/** `call`'s price at `table`: money on an API key, its equivalent on a subscription. */
export const priceOf = (table: PriceTable, call: PricedCall): Price =>
  Option.match(table(call), {
    onNone: () => Price.Unpriced(),
    onSome: usd =>
      call.billing === 'subscription'
        ? Price.Equivalent({ usd })
        : Price.Paid({ usd }),
  })
