import { Effect, Option, Schema } from 'effect'

import { codeIn } from './code'
import { extensionOf, setOf } from './names'
import type { Repository } from './repository'
import type { ReadSource } from './sources'
import { eachPathWord } from './text'

// The check commands' files and the files those commands run (spec §13.4): nearly every ticket asks
// for the checks to pass without changing them, so they hold no tickets apart (744 of tutti's 862
// held minutes were over a check script one ticket's acceptance named). A command runs the tracked
// files it names (`scripts/check-fast.sh`, `node scripts/test-rerun.ts`), a package manager's
// script of the root `package.json` (`pnpm run test`, `npm test`), the root Makefile where it runs
// make (`make check`), and a script or Makefile it runs runs what its code names in turn; each file
// is read once, so a script calling itself ends.

/** The scripts read for what they run in turn: the shell's, and files without an extension. */
const scriptExtensions = setOf('sh bash zsh')

const isScript = (path: string): boolean => {
  const extension = extensionOf(path)
  return extension === '' || scriptExtensions.has(extension)
}

// A package manager running a script: pnpm run test, pnpm --recursive run typecheck, npm test,
// yarn lint. Its flags are passed over; a name the manifest has no script for runs nothing named.
const scriptRun =
  /(?:^|[\s;&|(])(?:pnpm|npm|yarn|bun)(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:run\s+(?:--?[\w-]+(?:=\S+)?\s+)*)?([\w:.-]+)/gu

// make running the root Makefile: make check, make -j4 test.
const makeRun = /(?:^|[\s;&|(])g?make(?=\s|$)/u

/** The names make reads its root Makefile by, in the order it looks for them. */
const makefiles = ['GNUmakefile', 'makefile', 'Makefile']

const Manifest = Schema.Struct({
  scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const decodeManifest = Schema.decodeUnknownOption(Manifest)

const parseJson = (text: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(text))
  } catch {
    return Option.none()
  }
}

/** The root manifest's scripts, by name; none where it is untracked or unreadable. */
const manifestScripts = (
  repository: Repository,
  read: ReadSource,
): Effect.Effect<ReadonlyMap<string, string>> => {
  const manifest = repository.tracked('package.json')
  if (manifest === undefined) return Effect.succeed(new Map())
  return Effect.map(read(manifest), text =>
    Option.match(
      Option.flatMap(text, json =>
        Option.flatMap(parseJson(json), decodeManifest),
      ),
      {
        onNone: () => new Map(),
        onSome: ({ scripts }) => new Map(Object.entries(scripts ?? {})),
      },
    ),
  )
}

/** The files the check commands name and run, as git tracks them. */
export const checkFiles = Effect.fn('Footprints.checkFiles')(function* (input: {
  /** The check commands' lines: `check_own`, `check_fast`, `check_full`, as the settings give them. */
  readonly commands: ReadonlyArray<string>
  readonly repository: Repository
  readonly read: ReadSource
}) {
  const scripts = yield* manifestScripts(input.repository, input.read)
  const files = new Set<string>()
  const ranScripts = new Set<string>()
  const toRead: Array<string> = []
  const add = (file: string) => {
    if (files.has(file)) return
    files.add(file)
    if (isScript(file)) toRead.push(file)
  }
  const makefile = makefiles
    .map(name => input.repository.tracked(name))
    .find(file => file !== undefined)
  // What a command line, or a script's code, runs.
  const runs = (code: string) => {
    eachPathWord(code, ({ word, quoted }) => {
      const named = input.repository.named(word, quoted)
      for (const file of named) add(file)
      return named.length > 0
    })
    if (makefile !== undefined && makeRun.test(code)) add(makefile)
    for (const [, name] of code.matchAll(scriptRun)) {
      const script = name === undefined ? undefined : scripts.get(name)
      if (name === undefined || script === undefined || ranScripts.has(name))
        continue
      ranScripts.add(name)
      runs(script)
    }
  }
  for (const command of input.commands) runs(command)
  for (let next = toRead.shift(); next !== undefined; next = toRead.shift()) {
    const file = next
    const text = yield* input.read(file)
    if (Option.isSome(text)) runs(codeIn(file, text.value))
  }
  return files
})
