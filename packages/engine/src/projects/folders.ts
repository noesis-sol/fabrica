import { Array, Effect, Option, Order, Schema } from 'effect'
import type { Dirent } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  FolderListing,
  FolderUnreadable,
  HostFolder,
  Text,
} from '@fabrica/contracts'

import { errorCode } from '../files'

// The engine host's folders, as a client browses them for a checkout to add (spec §10.1): the app
// sees the engine's host only through the engine, so a remote engine's checkouts are found the same
// way as a local one's. A folder is listed by its subfolders, by name, hidden ones left out, each
// marked where it is a git checkout's top folder: it holds `.git`, a folder or the file a linked
// worktree has (adding the checkout says what is wrong with it). A link to a folder is listed as a
// folder. A folder that isn't there, isn't a folder or can't be read is refused, saying which.

const isText = Schema.is(Text)

/** What is wrong with listing `folder`, in words, from the error reading it threw. */
const unreadable = (folder: string, cause: unknown): FolderUnreadable =>
  new FolderUnreadable({
    path: folder,
    reason: Option.match(errorCode(cause), {
      onNone: () => `${folder} couldn't be read: ${String(cause)}`,
      onSome: code => {
        switch (code) {
          case 'ENOENT':
            return `there is no folder at ${folder}`
          case 'ENOTDIR':
            return `${folder} is not a folder`
          case 'EACCES':
          case 'EPERM':
            return `${folder} can't be read: permission denied`
          default:
            return `${folder} couldn't be read (${code})`
        }
      },
    }),
  })

/** Whether `folder` is a git checkout's top folder: it holds `.git`. */
const isCheckout = (folder: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => lstat(NodePath.join(folder, '.git'))).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/** Whether the entry is a folder, a link to one included; one that can't be told isn't. */
const isFolder = (folder: string, entry: Dirent): Effect.Effect<boolean> =>
  entry.isDirectory()
    ? Effect.succeed(true)
    : entry.isSymbolicLink()
      ? Effect.tryPromise(() => stat(NodePath.join(folder, entry.name))).pipe(
          Effect.map(found => found.isDirectory()),
          Effect.orElseSucceed(() => false),
        )
      : Effect.succeed(false)

/** The subfolder `entry` of `folder`, where it is one to list. */
const subfolder = (
  folder: string,
  entry: Dirent,
): Effect.Effect<Option.Option<HostFolder>> =>
  entry.name.startsWith('.') || !isText(entry.name)
    ? Effect.succeedNone
    : Effect.flatMap(isFolder(folder, entry), found => {
        if (!found) return Effect.succeedNone
        const path = NodePath.join(folder, entry.name)
        return Effect.map(isCheckout(path), checkout =>
          Option.some(new HostFolder({ name: entry.name, path, checkout })),
        )
      })

const byName = Order.mapInput(Order.String, (folder: HostFolder) => folder.name)

/** How many subfolders are looked at side by side. */
const looks = 16

/** The folder at the absolute `path` and its subfolders; a relative path is refused. */
export const listFolders = Effect.fn('Projects.folders')(function* (
  path: string,
) {
  if (!NodePath.isAbsolute(path))
    return yield* new FolderUnreadable({
      path,
      reason: `${path} is not an absolute path`,
    })
  const folder = NodePath.resolve(path)
  const [entries, checkout] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => readdir(folder, { withFileTypes: true }),
        catch: cause => unreadable(folder, cause),
      }),
      isCheckout(folder),
    ],
    { concurrency: 'unbounded' },
  )
  const folders = yield* Effect.forEach(
    entries,
    entry => subfolder(folder, entry),
    { concurrency: looks },
  )
  const parent = NodePath.dirname(folder)
  return new FolderListing({
    path: folder,
    parent: parent === folder ? Option.none() : Option.some(parent),
    checkout,
    folders: Array.sort(Array.getSomes(folders), byName),
  })
})
