import { Schema } from 'effect'

import { TicketResult } from '@fabrica/contracts'

// What stays off the tickets ref (spec §11.7): a result over 64 KB stays local, and a secret pattern in
// what is to be exported blocks the commit. The patterns are a small built-in set: cloud keys, private
// key blocks and provider tokens. A finding names the pattern, never the text it matched.

/** The largest result the ref carries, in bytes as its file would hold it. */
export const resultCap = 64 * 1024

const encodeResult = Schema.encodeSync(TicketResult)

/** Whether a result stays local: past the cap once encoded. */
export const isOverCap = (result: TicketResult): boolean =>
  Buffer.byteLength(JSON.stringify(encodeResult(result)), 'utf8') > resultCap

// A prefix distinctive enough opens its pattern with no boundary, as what comes before a secret can be
// anything. One that ends ordinary words (`task-`, `highs_`, `work_live_`) must follow no letter or digit,
// `_` being none, so `KEY_` still comes before a secret.
const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ['an AWS access key', /AKIA[0-9A-Z]{16}(?![0-9A-Z])/u],
  ['an AWS access key', /(?<![0-9A-Za-z])ASIA[0-9A-Z]{16}(?![0-9A-Z])/u],
  ['a Google API key', /AIza[0-9A-Za-z_-]{35}/u],
  ['a private key block', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u],
  [
    'a GitHub token',
    /(?<![0-9A-Za-z])gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{22,}/u,
  ],
  ['a GitLab token', /glpat-[0-9A-Za-z_-]{20,}/u],
  ['a Slack token', /xox[abeoprs]-[0-9A-Za-z-]{10,}/u],
  ['an Anthropic key', /(?<![0-9A-Za-z])sk-ant-[0-9A-Za-z_-]{20,}/u],
  ['an OpenAI key', /(?<![0-9A-Za-z])sk-(?:proj-)?[0-9A-Za-z_-]{32,}/u],
  ['a Stripe key', /(?<![0-9A-Za-z])[rs]k_live_[0-9A-Za-z]{16,}/u],
]

/**
 * The escapes of text held as text, however deep: JSON's and a shell's backslashes, a URL's percents. The
 * last letter or digit of one would pass for the word before a secret.
 */
const heldEscape =
  /\\+(?:[bfnrtve0"'/]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})|%[0-9a-fA-F]{2}/gu

/** The patterns `text` matches, by name, each once. */
export const secretsIn = (text: string): ReadonlyArray<string> => {
  const plain = text.replace(heldEscape, ' ')
  return [
    ...new Set(
      secretPatterns.flatMap(([name, pattern]) =>
        pattern.test(plain) ? [name] : [],
      ),
    ),
  ]
}

/** Every string a JSON value holds, its keys too. */
const stringsIn = (value: unknown): ReadonlyArray<string> =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsIn)
      : typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => [
            key,
            ...stringsIn(inner),
          ])
        : []

/**
 * The patterns a file of the ref matches, by name, each once. Its strings are read decoded: encoded, a
 * newline before a secret is the two characters `\n`, whose `n` hides the word boundary a pattern opens with.
 */
export const secretsInFile = (json: string): ReadonlyArray<string> => [
  ...new Set(stringsIn(JSON.parse(json)).flatMap(secretsIn)),
]

/** A remote's URL with no credentials in it, as it may be kept and shown (§11.7: the engine stores none). */
export const withoutCredentials = (url: string): string =>
  url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/iu, '$1')
