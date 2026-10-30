// The attention requests (spec §15.1, §15.2, §8.5): questions, permission requests and maintainer
// tasks, listed together for every client, and their answers.
export { consequentialChoices, isConsequential } from './consequential'
export { withAnswer } from './design'
export {
  type AttentionProjects,
  AttentionItem,
  AttentionRequests,
  type AttentionRequestsShape,
  type Revised,
  daemonProjects,
  layer,
  make,
} from './service'
