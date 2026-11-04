import { Schema } from 'effect'

import { TicketId } from './ids'
import { Text } from './ticket'
import { type AnyTool, Files, Title, opensWith } from './tools'
import { TreeItem } from './tree'

// The spec breakdown's tools (spec §15.5, §16): the headless breakdown, an organ's session, files the
// root epic and the environment ticket first with `file_root`, so that the run starts on that ticket
// while it goes on; the rest of the tree is its structured answer, which the engine checks whole with
// the root and the environment ticket among its items, named by the keys below, and files in order.

/** The key the root epic goes by in the breakdown's answer. */
export const BreakdownRootKey = 'root'

/** The key the environment ticket goes by in the breakdown's answer. */
export const BreakdownEnvironmentKey = 'environment'

/** The metadata naming the version of the spec a root epic's tree was filed for: set last of all. */
export const SpecSha256Key = 'spec_sha256'

/** The metadata naming the commit that committed that version of the spec. */
export const SpecCommitKey = 'spec_commit'

/** The metadata marking a spec's environment ticket, which every other ticket of its tree waits on. */
export const SpecEnvironmentKey = 'spec_environment'

const opensWithDetail = Schema.makeFilter(
  ({
    title,
    description,
  }: {
    readonly title: string
    readonly description: string
  }) =>
    opensWith(description, title)
      ? {
          path: ['description'],
          issue:
            'the description opens with the detail, not a restatement of the title',
        }
      : undefined,
)

export const FileRootParameters = Schema.Struct({
  root: Schema.Struct({
    title: Title,
    description: Text.annotate({
      description:
        'What the spec builds, summed up: it opens with the detail, not a restatement of the title.',
    }),
  })
    .check(opensWithDetail)
    .annotate({ description: 'The root epic, which holds the whole tree.' }),
  environment: Schema.OptionFromOptionalKey(
    Schema.Struct({
      title: Title,
      description: Text.annotate({
        description:
          "What it sets up: the project's requires list and its pins, the scaffold, the dependencies through setup. It installs no machine tools as ticket work.",
      }),
      acceptance: Schema.OptionFromOptionalKey(
        Text.annotate({ description: 'How its worker knows it is done.' }),
      ),
      files: Files.annotate({
        description:
          'The files it will change, its footprint; "unknown" when they cannot be named yet.',
      }),
    })
      .check(opensWithDetail)
      .annotate({
        description:
          'The environment ticket, when the spec needs a tool the machine lacks or the repository has no code. Left out otherwise.',
      }),
  ),
})
export type FileRootParameters = typeof FileRootParameters.Type

/** The root epic filed, and the environment ticket where one was given. */
export class FiledRoot extends Schema.Class<FiledRoot>('FiledRoot')({
  root: TicketId,
  environment: Schema.OptionFromOptionalKey(TicketId),
}) {}

export const FileRootTool = {
  name: 'file_root',
  description:
    'Files the root epic and, where the spec needs one, the environment ticket under it (solo, ' +
    'priority 0, every other ticket waiting on it), so that the run starts on it while you work out ' +
    'the rest. Call it once, before your answer: the rest of the tree is your answer.',
  parameters: FileRootParameters,
  success: FiledRoot,
} satisfies AnyTool

/** A change to an open ticket of the tree filed for an earlier version of the spec. */
export const SpecTicketChange = Schema.Struct({
  ticket: TicketId.annotate({
    description: 'The open ticket it changes, not yet taken up by a worker.',
  }),
  title: Schema.OptionFromOptionalKey(Title),
  description: Schema.OptionFromOptionalKey(Text),
  design: Schema.OptionFromOptionalKey(Text),
  acceptance: Schema.OptionFromOptionalKey(Text),
  obsolete: Schema.OptionFromOptionalKey(
    Text.annotate({
      description:
        'Why the change makes the ticket obsolete: it is deferred, with this as its note.',
    }),
  ),
})
export type SpecTicketChange = typeof SpecTicketChange.Type

/** The breakdown's answer: the rest of the tree, and an update's changes to what is filed. */
export const BreakdownAnswer = Schema.Struct({
  items: Schema.Array(TreeItem).annotate({
    description:
      'The epics and tickets the tree still needs, each naming its parent by key: "root" for the root epic. The environment ticket goes by "environment"; every ticket waits on it without saying so.',
  }),
  changes: Schema.OptionFromOptionalKey(
    Schema.Array(SpecTicketChange).annotate({
      description:
        'Only when updating the tree for a changed spec: the open tickets the change alters or makes obsolete.',
    }),
  ),
})
export type BreakdownAnswer = typeof BreakdownAnswer.Type
