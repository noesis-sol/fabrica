import { Option } from 'effect'

import type { QuestionChoices } from '@fabrica/contracts'

// Consequential questions (spec §15.2, H53): a question whose options would close, cancel, defer or
// freeze work is marked so when it is asked, whether its asker said so or not, so no option of it is
// preselected and nothing answers it in a batch. The engine reads it from the options' words: a label
// or a trade-off that names one of those acts. A word read where it meant something else only costs
// the maintainer a deliberate pick.

/** The acts that make an option consequential, in their forms. */
const acts =
  /\b(?:clos(?:e|es|ed|ing|ure)|cancel(?:s|led|ed|ling|ing|lation)?|defer(?:s|red|ring|ral)?|freez(?:e|es|ing)|froze|frozen)\b/iu

/** Whether the options would close, cancel, defer or freeze work. */
export const consequentialChoices = (
  choices: Option.Option<QuestionChoices>,
): boolean =>
  Option.exists(choices, ({ options }) =>
    options.some(
      option => acts.test(option.label) || acts.test(option.tradeOff),
    ),
  )

/** Whether a question is consequential: as its asker marked it, or as its options say. */
export const isConsequential = (question: {
  readonly consequential: boolean
  readonly choices: Option.Option<QuestionChoices>
}): boolean => question.consequential || consequentialChoices(question.choices)
