import { Schema } from 'effect'

import { ProjectId, TicketId } from '../ids'
import { Text } from '../ticket'

// Errors more than one group answers with. A group's own errors are in its file.

/** No project with that ID on this engine. */
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  'ProjectNotFound',
  { project: ProjectId },
) {}

/** No ticket with that ID in the project's work graph. */
export class TicketNotFound extends Schema.TaggedError<TicketNotFound>()(
  'TicketNotFound',
  { project: ProjectId, ticket: TicketId },
) {}

/** The engine understood the request and refused it, saying why: a cycle, a ticket with open children. */
export class Refused extends Schema.TaggedError<Refused>()('Refused', {
  reason: Text,
}) {}
