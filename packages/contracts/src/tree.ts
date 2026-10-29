import { Schema } from 'effect'

import { TicketId } from './ids'
import { LabelName, Priority, Text } from './ticket'
import { type AnyTool, Files, Title, opensWith } from './tools'

// A tree of tickets filed at once (spec §15.4, §15.5): one root epic, the epics and tickets under it,
// and the items each waits on. Its items name one another by keys of the tree's own, since none has
// an ID until it is filed; the engine checks the tree whole (`treeProblems` in the engine's work
// graph) and files it in order, parents first. The refine and feature talks file what they decide
// with `file_tree`.

/** A name the tree gives an item, for the items under it and those waiting on it to name it by. */
export const TreeKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u, {
    expected: 'lower-case letters, digits and hyphens',
  }),
)
export type TreeKey = typeof TreeKey.Type

/** What a tree's item is: an epic holds others, the rest are worked by workers. */
export const TreeItemType = Schema.Literals([
  'epic',
  'task',
  'bug',
  'feature',
  'chore',
])
export type TreeItemType = typeof TreeItemType.Type

/** An item of the tree: a ticket to file, its place in the tree and the items it waits on. */
export const TreeItem = Schema.Struct({
  key: TreeKey.annotate({
    description:
      'The name the tree gives it, unique in the tree: lower-case letters, digits and hyphens.',
  }),
  type: TreeItemType.annotate({
    description:
      'epic for an item holding others, never worked itself; task, bug, feature or chore for one a worker does.',
  }),
  title: Title,
  description: Text.annotate({
    description:
      'Opens with the detail, not a restatement of the title. Name a file only where the ticket will change it.',
  }),
  design: Schema.OptionFromOptionalKey(
    Text.annotate({
      description:
        'The decisions made with the maintainer that its worker must follow.',
    }),
  ),
  acceptance: Schema.OptionFromOptionalKey(
    Text.annotate({ description: 'How its worker knows it is done.' }),
  ),
  priority: Schema.OptionFromOptionalKey(
    Priority.annotate({
      description: '0 (most urgent) to 4 (backlog); 2 when left out.',
    }),
  ),
  files: Schema.OptionFromOptionalKey(
    Files.annotate({
      description:
        'For a ticket, the files it will change, its footprint; "unknown" when they cannot be named yet. An epic names none.',
    }),
  ),
  labels: Schema.OptionFromOptionalKey(
    Schema.Array(LabelName).annotate({
      description:
        'Labels, such as solo for a change most tickets touch (splitting or moving a shared file), which runs with no other ticket beside it.',
    }),
  ),
  parent: Schema.OptionFromOptionalKey(
    TreeKey.annotate({
      description:
        'The key of the epic it is under; left out for the root epic alone.',
    }),
  ),
  waitsOn: Schema.OptionFromOptionalKey(
    Schema.Array(TreeKey).annotate({
      description:
        'The keys of the items that must be done before it starts: what it builds on.',
    }),
  ),
}).check(
  Schema.makeFilter(({ title, description }) =>
    opensWith(description, title)
      ? {
          path: ['description'],
          issue:
            'the description opens with the detail, not a restatement of the title',
        }
      : undefined,
  ),
)
export type TreeItem = typeof TreeItem.Type

export const FileTreeParameters = Schema.Struct({
  items: Schema.Array(TreeItem).check(Schema.isMinLength(1)).annotate({
    description:
      'The root epic, then the epics and tickets under it, each naming its parent by key.',
  }),
})

/** An item of the tree, filed. */
export class FiledItem extends Schema.Class<FiledItem>('FiledItem')({
  key: TreeKey,
  id: TicketId,
}) {}

/** The tree filed: its root epic, and each item's ticket, in the order they were filed. */
export class FiledTree extends Schema.Class<FiledTree>('FiledTree')({
  root: TicketId,
  items: Schema.Array(FiledItem),
}) {}

export const FileTreeTool = {
  name: 'file_tree',
  description:
    'Files a tree of tickets at once, once the maintainer agrees to it: one root epic, the epics and ' +
    'tickets under it (each naming its parent by key), and the items each waits on. The tree is ' +
    'checked whole before anything is filed, and refused with every reason at once: correct them ' +
    'all and call it again. Keep each ticket small enough for one session, and let tickets that ' +
    'change different files run side by side rather than wait on one another.',
  parameters: FileTreeParameters,
  success: FiledTree,
} satisfies AnyTool
