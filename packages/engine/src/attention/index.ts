// The attention requests (spec §15.1, §15.2, §8.5): questions, permission requests, maintainer
// tasks and tickets set aside, listed together for every client, and their answers.
export {
  type AutoAnswers,
  autoAnswerFields,
  autoAnswerText,
  autoAnsweredLabel,
  makeAutoAnswers,
  optionToAnswer,
} from './auto-answer'
export { consequentialChoices, isConsequential } from './consequential'
export { withAnswer } from './design'
export {
  type AttentionProjects,
  AttentionItem,
  AttentionRequests,
  type AttentionRequestsShape,
  daemonProjects,
  layer,
  make,
} from './service'
