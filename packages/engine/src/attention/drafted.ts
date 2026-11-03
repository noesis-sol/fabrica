import { LabelName } from '@fabrica/contracts'

// Drafted options (spec §15.3): the answer talk drafts options for a question filed without them, and
// they are marked so wherever they are shown. The mark is a label on the question.

/** The label of a question whose options a talk drafted. */
export const draftedLabel = LabelName.make('options-drafted')
