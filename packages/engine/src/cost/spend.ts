import { Option } from 'effect'

import type { ModelName, Tokens, TokensByModel } from '@fabrica/contracts'

import { Price } from './pricing'

// What model calls spent, added up (spec §14.4): tokens by model, money, and a subscription's API-price
// equivalent apart from money, each where a call gave one. The event stream's records carry it as
// `tokens`, `cost_usd` and `equivalent_usd` (§13.12), each left out where it has no value.

export interface Spend {
  readonly tokens: TokensByModel
  /** Money: the API-key calls priced. None where no call was. */
  readonly costUsd: Option.Option<number>
  /** A subscription's calls at their API-price equivalent. None where no call was. */
  readonly equivalentUsd: Option.Option<number>
}

/** Nothing spent. */
export const noSpend: Spend = {
  tokens: {},
  costUsd: Option.none(),
  equivalentUsd: Option.none(),
}

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_write: a.cache_write + b.cache_write,
  cache_read: a.cache_read + b.cache_read,
})

/** No tokens. */
export const noTokens: Tokens = {
  input: 0,
  output: 0,
  cache_write: 0,
  cache_read: 0,
}

/** `spend`'s tokens, every model's together. */
export const tokensOf = (spend: Spend): Tokens =>
  Object.values(spend.tokens).reduce(addTokens, noTokens)

const addUsd = (
  total: Option.Option<number>,
  usd: Option.Option<number>,
): Option.Option<number> =>
  Option.isNone(usd)
    ? total
    : Option.some(Option.getOrElse(total, () => 0) + usd.value)

/** `spend` with a call of `model` added: its tokens, and its price where it has one. */
export const addCall = (
  spend: Spend,
  call: {
    readonly model: ModelName
    readonly tokens: Tokens
    readonly price: Price
  },
): Spend => {
  const before = spend.tokens[call.model]
  const none = () => Option.none<number>()
  const usd = ({ usd }: { readonly usd: number }) => Option.some(usd)
  return {
    tokens: {
      ...spend.tokens,
      [call.model]:
        before === undefined ? call.tokens : addTokens(before, call.tokens),
    },
    costUsd: addUsd(
      spend.costUsd,
      Price.$match(call.price, { Paid: usd, Equivalent: none, Unpriced: none }),
    ),
    equivalentUsd: addUsd(
      spend.equivalentUsd,
      Price.$match(call.price, { Paid: none, Equivalent: usd, Unpriced: none }),
    ),
  }
}

/** A record's fields for `spend`: `tokens`, `cost_usd` and `equivalent_usd`, each where it has a value. */
export const spendFields = (
  spend: Spend,
): {
  readonly tokens?: TokensByModel
  readonly cost_usd?: number
  readonly equivalent_usd?: number
} => ({
  ...(Object.keys(spend.tokens).length === 0 ? {} : { tokens: spend.tokens }),
  ...Option.match(spend.costUsd, {
    onNone: () => ({}),
    onSome: usd => ({ cost_usd: usd }),
  }),
  ...Option.match(spend.equivalentUsd, {
    onNone: () => ({}),
    onSome: usd => ({ equivalent_usd: usd }),
  }),
})
