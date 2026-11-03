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

const secretPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ['a private key block', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u],
  [
    'a GitHub token',
    /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{22,})\b/u,
  ],
  ['a GitLab token', /\bglpat-[0-9A-Za-z_-]{20,}\b/u],
  ['a Slack token', /\bxox[abeoprs]-[0-9A-Za-z-]{10,}\b/u],
  ['an Anthropic key', /\bsk-ant-[0-9A-Za-z_-]{20,}\b/u],
  ['an OpenAI key', /\bsk-(?:proj-)?[0-9A-Za-z_-]{32,}\b/u],
  ['a Stripe key', /\b[rs]k_live_[0-9A-Za-z]{16,}\b/u],
]

/** The patterns `text` matches, by name. */
export const secretsIn = (text: string): ReadonlyArray<string> =>
  secretPatterns.flatMap(([name, pattern]) =>
    pattern.test(text) ? [name] : [],
  )

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
