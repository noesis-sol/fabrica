import { Option } from 'effect'

import type { TicketId } from '@fabrica/contracts'

// A question's answer in the design of each ticket waiting on it (spec §15.2), so their workers see it:
// one block per question, between markers that name it, so a revised answer replaces its block rather
// than adding a second one beside it.

const opening = (question: TicketId) => `<!-- fabrica:answer ${question} -->`
const closing = (question: TicketId) => `<!-- /fabrica:answer ${question} -->`

/** The block that says the question's answer. */
const answerBlock = (answered: {
  readonly question: TicketId
  readonly title: string
  readonly answer: string
}): string =>
  [
    opening(answered.question),
    `The maintainer answered ${answered.question} (${answered.title}): ${answered.answer}`,
    closing(answered.question),
  ].join('\n')

/** `design` with the question's answer in it: its earlier answer's block replaced, else the block added at the end. */
export const withAnswer = (
  design: Option.Option<string>,
  answered: {
    readonly question: TicketId
    readonly title: string
    readonly answer: string
  },
): string => {
  const block = answerBlock(answered)
  const text = Option.getOrElse(design, () => '')
  const start = text.indexOf(opening(answered.question))
  const end = text.indexOf(closing(answered.question), start)
  if (start >= 0 && end >= 0)
    return `${text.slice(0, start)}${block}${text.slice(end + closing(answered.question).length)}`
  return text.trim() === '' ? block : `${text.trimEnd()}\n\n${block}`
}
