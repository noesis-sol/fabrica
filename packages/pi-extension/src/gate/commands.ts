import { Data, Option } from 'effect'
import { basename } from 'node:path'

import { Expansion, expandBraces } from './braces'
import {
  Confinement,
  type LastLink,
  Locations,
  type PathContext,
  Place,
  confine,
  folderReadings,
  isInside,
  locations,
  realFolder,
  worst,
} from './paths'
import { Script, type SimpleCommand, type Word, parseScript } from './shell'

// The command policy (spec §12.6): what a bash command line does that the gate's levels weigh. Each
// simple command, wrappers (`env`, `timeout`, `xargs`, `bash -c`, `find -exec`) seen through, is
// read for what is always refused (`git push`; `sudo`; history rewrites of other branches; removals
// outside the worktree), what the maintainer is asked about (writes and commands outside the
// worktree, network-reaching commands not on the list, risky commands, whatever the gate can't
// tell) and what writes the worktree's branch, which waits while the ticket merges (H59). Package
// managers reach the network without asking; their global installs and publishing ask.

export type Finding = Data.TaggedEnum<{
  /** A push, refused at every level. */
  Push: { readonly command: string }
  /** Refused at every level but `full`. */
  Refused: { readonly reason: string }
  /** Asked at `workspace`. */
  Ask: { readonly reason: string }
  /** A write to the worktree's branch, refused while the ticket waits to merge or merges. */
  BranchWrite: { readonly command: string }
}>
export const Finding = Data.taggedEnum<Finding>()

/** The facts commands are read with: the worktree, the home folder where known, and how the agent's shell searches for a `cd` target. */
export interface CommandContext {
  readonly worktree: string
  readonly home: Option.Option<string>
  /** The agent's environment sets `CDPATH`, so a `cd` may land under one of its folders. */
  readonly cdPath: boolean
  /** The agent's environment turns `cdable_vars` on (through `BASHOPTS`), so a `cd` may land where a variable names. */
  readonly cdableVariables: boolean
}

/** How deep `bash -c` and `eval` are followed before the gate asks instead. */
const maxDepth = 8

const refusedUsers = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0'])

const gitVariables = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_NAMESPACE',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
])

const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'hush'])

/** Shells whose grammar is further from bash's than the POSIX shell's. */
const otherGrammars = new Set(['zsh', 'ksh'])

const removals = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash'])

/** Commands writing each of their operands, with the options that take a value. */
const writers: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['mkdir', new Set(['-m', '--mode'])],
  ['touch', new Set(['-r', '-d', '-t', '--reference', '--date'])],
  ['tee', new Set<string>()],
  ['truncate', new Set(['-s', '-r', '--size', '--reference'])],
  ['chflags', new Set<string>()],
])

/** Commands whose first operand is a mode or an owner, and whose others they change. */
const modeWriters = new Set(['chmod', 'chown', 'chgrp'])

/** Commands copying or linking to their last operand, or to `-t`'s folder. */
const copiers = new Set(['cp', 'ln', 'install'])

/** The options of `mv`, and of the copiers, that take a value. */
const moverValues = new Set(['-t', '-S', '--target-directory', '--suffix'])
const copierValues = new Set([
  ...moverValues,
  '-m',
  '-o',
  '-g',
  '--mode',
  '--owner',
  '--group',
])

/** `sed`'s short option that edits in place, its suffix attached; those before it in a group take no value on BSD, where `-l` takes none. */
const sedInPlace = /^-[a-dghj-zA-HJ-Z]*[iI]/u

/** `sed`'s options that take a script. */
const sedScripts = new Set(['-e', '-f', '--expression', '--file'])

/** `sort`'s options that take a value. */
const sortValues = new Set([
  '-k',
  '-o',
  '-S',
  '-t',
  '-T',
  '--key',
  '--output',
  '--buffer-size',
  '--field-separator',
  '--temporary-directory',
  '--batch-size',
  '--compress-program',
  '--files0-from',
  '--parallel',
  '--random-source',
  '--sort',
])

/** `git init`'s options that take a value. */
const gitInitValues = new Set([
  '-b',
  '--initial-branch',
  '--object-format',
  '--ref-format',
  '--separate-git-dir',
  '--template',
])

const network = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ftp',
  'http',
  'https',
  'xh',
  'gh',
  'hub',
  'glab',
  'aws',
  'gcloud',
  'gsutil',
  'az',
  'ping',
  'dig',
  'nslookup',
  'host',
  'whois',
])

const risky: ReadonlyMap<string, string> = new Map([
  ['pkill', 'stops processes by name, other workers’ among them'],
  ['killall', 'stops processes by name, other workers’ among them'],
  ['shutdown', 'stops the machine'],
  ['reboot', 'restarts the machine'],
  ['halt', 'stops the machine'],
  ['poweroff', 'stops the machine'],
  ['launchctl', 'controls the system’s services'],
  ['systemctl', 'controls the system’s services'],
  ['service', 'controls the system’s services'],
  ['crontab', 'schedules commands'],
  ['mount', 'changes the mounted disks'],
  ['umount', 'changes the mounted disks'],
  ['diskutil', 'changes disks'],
  ['fdisk', 'changes disks'],
  ['parted', 'changes disks'],
  ['chroot', 'runs commands in another root'],
  ['docker', 'drives containers'],
  ['podman', 'drives containers'],
  ['kubectl', 'drives a cluster'],
  ['security', 'reads and changes the keychain'],
  ['osascript', 'scripts other applications'],
  ['defaults', 'changes the system’s settings'],
  ['brew', 'installs system packages'],
  ['apt', 'installs system packages'],
  ['apt-get', 'installs system packages'],
  ['yum', 'installs system packages'],
  ['dnf', 'installs system packages'],
  ['pacman', 'installs system packages'],
  ['apk', 'installs system packages'],
  ['port', 'installs system packages'],
  ['snap', 'installs system packages'],
])

const nodePackageManagers = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/** Package managers' subcommands that install outside the worktree. */
const globalInstalls: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['cargo', new Set(['install'])],
  ['go', new Set(['install'])],
  ['gem', new Set(['install'])],
  ['pipx', new Set(['install'])],
])

/** Package managers' subcommands that publish. */
const publishing: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['npm', new Set(['publish'])],
  ['pnpm', new Set(['publish'])],
  ['yarn', new Set(['publish', 'npm'])],
  ['bun', new Set(['publish'])],
  ['cargo', new Set(['publish'])],
  ['gem', new Set(['push'])],
  ['twine', new Set(['upload'])],
  ['poetry', new Set(['publish'])],
  ['uv', new Set(['publish'])],
])

/** Files a redirection may always write. */
const harmlessTargets = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/u

/** In a command line the gate can't read, a push or a command run as another user, by their words. */
const unreadPush = /\bgit\b[\s\S]*\b(?:push|send-pack|http-push|dcommit)\b/u
const unreadSudo = /(?:^|[^\w-])(?:sudo|doas|pkexec|run0)\b/u

const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u

/** Builtins that set the variables their operands name. */
const setters = new Set([
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'unset',
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'let',
  'shopt',
])

/** A word that may name a variable known only when it runs: dynamic before its `=`, or dynamic without one. */
const dynamicName = ({ text, dynamic }: Word): boolean => {
  if (!dynamic) return false
  const equals = text.indexOf('=')
  return equals === -1 || /[$`<>]/u.test(text.slice(0, equals))
}

/** Builtins whose `-n` makes a name refer to another variable, which assigning to it sets. */
const namerefs = new Set(['declare', 'typeset', 'local'])

/** `word`'s text and each of its brace alternatives, its escapes dropped: every way the shell may spell it. */
const spellings = (word: Word): ReadonlyArray<string> =>
  Expansion.$match(expandBraces(word.pattern), {
    Refused: () => [word.text],
    Expanded: ({ alternatives }) => [
      word.text,
      ...alternatives.map(alternative => alternative.replace(/\\(.)/gsu, '$1')),
    ],
  })

/** A word made by the gate, standing for a path. */
const syntheticWord = (word: Word, suffix: string): Word => ({
  text: `${word.text}${suffix}`,
  pattern: `${word.pattern}${suffix}`,
  dynamic: word.dynamic,
})

/** In a group of short options (`-rt`, `-rtdir`), the first that takes a value in `values`, and where its value starts in `text`. */
const valuedShort = (
  text: string,
  values: ReadonlySet<string>,
): Option.Option<{ readonly option: string; readonly start: number }> => {
  if (!text.startsWith('-')) return Option.none()
  for (let at = 1; at < text.length; at++) {
    const letter = text[at] ?? ''
    if (!/[A-Za-z0-9]/u.test(letter)) return Option.none()
    const option = `-${letter}`
    if (values.has(option)) return Option.some({ option, start: at + 1 })
  }
  return Option.none()
}

/** Whether `text`, an option with any value joined by `=`, names the long option `long`, which it may shorten as GNU's and git's parsers let it. */
const namesLong = (text: string, long: string): boolean => {
  const name = text.split('=')[0] ?? ''
  return name.length > 2 && name.startsWith('--') && long.startsWith(name)
}

/** Whether `text`, an option, leaves its value to the next word. */
const takesNextWord = (text: string, values: ReadonlySet<string>): boolean =>
  values.has(text) ||
  Option.exists(valuedShort(text, values), ({ start }) => start === text.length)

/** `word` from `start`, where the characters before it are an option's, written the same in its text and its pattern. */
const attachedValue = (word: Word, start: number): Word => ({
  text: word.text.slice(start),
  pattern: word.pattern.slice(start),
  dynamic: word.dynamic,
})

/** The operands of `words`: past their options, those taking a value in `values` skipped with it. */
const operands = (
  words: ReadonlyArray<Word>,
  values: ReadonlySet<string> = new Set(),
): ReadonlyArray<Word> => {
  const found: Array<Word> = []
  let ended = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === undefined) continue
    if (
      ended ||
      word.dynamic ||
      !word.text.startsWith('-') ||
      word.text === '-'
    )
      found.push(word)
    else if (word.text === '--') ended = true
    else if (takesNextWord(word.text, values)) index++
  }
  return found
}

/** Whether `words` hold the option `option`, alone or in a group of short options. */
const hasOption = (
  words: ReadonlyArray<Word>,
  ...options: ReadonlyArray<string>
): boolean =>
  words.some(
    ({ text, dynamic }) =>
      !dynamic &&
      options.some(option =>
        option.startsWith('--')
          ? text === option || text.startsWith(`${option}=`)
          : text === option ||
            (/^-[A-Za-z]+$/u.test(text) && text.includes(option.slice(1))),
      ),
  )

/** Whether `words` hold the option `option`, up to `--`, where `values` are the options that take a value: the letters of a value are no options. */
const hasFlag = (
  words: ReadonlyArray<Word>,
  values: ReadonlySet<string>,
  ...options: ReadonlyArray<string>
): boolean => {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === undefined || word.text === '--') return false
    const { text, dynamic } = word
    if (!dynamic && text.startsWith('-') && text !== '-') {
      const end = Option.match(valuedShort(text, values), {
        onNone: () => text.length,
        onSome: ({ start }) => start - 1,
      })
      if (
        options.some(option =>
          option.startsWith('--')
            ? namesLong(text, option)
            : !text.startsWith('--') &&
              text.slice(1, end).includes(option[1] ?? ''),
        )
      )
        return true
    }
    if (takesNextWord(text, values)) index++
  }
  return false
}

/** The values given to the option called `names` in `words` (`-t dir`, `-tdir`, `-rt dir`, `--target=dir`), read up to `--`; `values` are the options that take one. */
const optionValues = (
  words: ReadonlyArray<Word>,
  names: ReadonlyArray<string>,
  values: ReadonlySet<string>,
): ReadonlyArray<Word> => {
  const found: Array<Word> = []
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === undefined || word.text === '--') break
    const { text } = word
    const equals = text.indexOf('=')
    if (text.startsWith('--') && equals !== -1) {
      if (names.some(name => namesLong(text, name)))
        found.push(attachedValue(word, equals + 1))
      continue
    }
    const short = valuedShort(text, values)
    const named =
      names.includes(text) ||
      names.some(name => namesLong(text, name)) ||
      Option.exists(short, ({ option }) => names.includes(option))
    const next =
      takesNextWord(text, values) || names.some(name => namesLong(text, name))
    if (named && next) {
      const value = words[index + 1]
      if (value !== undefined) found.push(value)
    } else if (named && Option.isSome(short))
      found.push(attachedValue(word, short.value.start))
    if (next) index++
  }
  return found
}

/** The settings that change what git runs. */
const gitRunsSetting =
  /^(?:alias\.|core\.(?:hookspath|sshcommand|fsmonitor)=|init\.templatedir=)/iu

/** git config's options that take a value, the next word when not joined by `=`. */
const configValues = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
  '--url',
])

/**
 * Whether git config's arguments `words` only read settings: a reading option or subcommand
 * (`--get`, `--list`, `get`, `list`), or a name alone. Anything else writes (`<name> <value>`,
 * `set`, `--unset`, `--edit`, …), as does a form the gate can't read.
 */
const configReads = (words: ReadonlyArray<Word>): boolean => {
  if (
    hasOption(
      words,
      '--add',
      '--replace-all',
      '--unset',
      '--unset-all',
      '--rename-section',
      '--remove-section',
      '-e',
      '--edit',
    )
  )
    return false
  if (
    hasOption(
      words,
      '--get',
      '--get-all',
      '--get-regexp',
      '--get-urlmatch',
      '--get-color',
      '--get-colorbool',
      '-l',
      '--list',
    )
  )
    return true
  const named = operands(words, configValues)
  const first = named[0]
  if (first === undefined) return true
  if (named.some(({ dynamic }) => dynamic)) return false
  if (first.text === 'get' || first.text === 'list') return true
  return (
    named.length === 1 &&
    !['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(
      first.text,
    )
  )
}

/** What `find` does with what it finds, beyond reading it. */
const findActions = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir'])

/** What `sed`'s arguments say, read up to `--`: whether it edits in place, whether an option gives a script, and its words but the in-place option and any script known only when it runs. */
const sedArguments = (
  args: ReadonlyArray<Word>,
): {
  readonly inPlace: boolean
  readonly scripted: boolean
  readonly words: ReadonlyArray<Word>
} => {
  const words: Array<Word> = []
  let inPlace = false
  let scripted = false
  for (let index = 0; index < args.length; index++) {
    const word = args[index]
    if (word === undefined) break
    const { text, dynamic } = word
    if (text === '--') {
      words.push(...args.slice(index))
      break
    }
    if (sedInPlace.test(text) || namesLong(text, '--in-place')) {
      inPlace = true
      continue
    }
    const script =
      namesLong(text, '--expression') ||
      namesLong(text, '--file') ||
      Option.isSome(valuedShort(text, sedScripts))
    if (script) scripted = true
    if (script && dynamic) continue
    words.push(word)
    const value = args[index + 1]
    if (takesNextWord(text, sedScripts) && value !== undefined) {
      words.push(value)
      index++
    }
  }
  return { inPlace, scripted, words }
}

/** `find`'s primaries writing to the file named by the word after them. */
const findOutputs = new Set(['-fprint', '-fprint0', '-fprintf', '-fls'])

/** `find`'s primaries that `-f` and a root attached (BSD's `-froot`) would read otherwise. */
const findPrimaries =
  /^-f(?:alse|ollow|print|print0|printf|ls|stype|iles0-from)$/u

/** `find`'s arguments past the options before its roots (`-H`, `-L`, `-O2`, `-D tree`, `--`), and the roots they give (BSD's `-f root`). */
const findOptions = (
  args: ReadonlyArray<Word>,
): {
  readonly words: ReadonlyArray<Word>
  readonly rootsGiven: ReadonlyArray<Word>
} => {
  const rootsGiven: Array<Word> = []
  let index = 0
  for (; index < args.length; index++) {
    const word = args[index]
    if (word === undefined || word.dynamic) break
    if (word.text === '--') {
      index++
      break
    }
    if (word.text === '-D') {
      index++
      continue
    }
    if (/^-(?:[HLPEXdsx]+|O\d*)$/u.test(word.text)) continue
    // BSD's `-f root`, the root attached or the option last in a group: `-fout`, `-Hf out`.
    const given = /^-[HLPEXdsx]*f(.*)$/u.exec(word.text)?.[1]
    if (given === undefined || findPrimaries.test(word.text)) break
    if (given !== '')
      rootsGiven.push({
        text: given,
        pattern: word.pattern.slice(word.pattern.length - given.length),
        dynamic: false,
      })
    else {
      const value = args[index + 1]
      if (value !== undefined) rootsGiven.push(value)
      index++
    }
  }
  return { words: args.slice(index), rootsGiven }
}

/** A word of `find -exec`'s command: `{}`, alone or in a longer word, stands for anything below `root`, a link among it. */
const foundWord = (part: Word, root: Word): Word =>
  part.text.includes('{}')
    ? {
        text: part.text.replaceAll('{}', () => `${root.text}/**`),
        pattern: part.pattern.replaceAll(
          /\\?\{\\?\}/gu,
          () => `${root.pattern}/**`,
        ),
        dynamic: part.dynamic || root.dynamic,
      }
    : part

/** A link's target as the system reads it: from the folder the link is made in, which `link` names. */
const fromLink = (target: Word, link: Word): Word => {
  const slash = link.pattern.lastIndexOf('/')
  if (slash === -1 || /^[/~]/u.test(target.text)) return target
  return {
    text: `${link.text.slice(0, link.text.lastIndexOf('/'))}/${target.text}`,
    pattern: `${link.pattern.slice(0, slash)}/${target.pattern}`,
    dynamic: target.dynamic || link.dynamic,
  }
}

/**
 * The folders a command may run in, none where the gate can't tell one. The gate reads a command
 * line as one list, without knowing which of its commands run (one in a subshell, after a failing
 * `cd`, in a branch, in a function never called), so a `cd` adds the folder it lands in to the
 * folders before it and drops none: a path is placed from each.
 */
type Folders = ReadonlyArray<Option.Option<string>>

const unknownFolder: Folders = [Option.none()]

/** How many folders the gate follows; past them, it can't tell where commands run. */
const maxFolders = 64

/** A folder's key among others: its path, absolute, or a word no path is for the unknown one. */
const folderKey = (folder: Option.Option<string>): string =>
  Option.getOrElse(folder, () => 'unknown')

/** `folders` and `more`, each folder once; the unknown folder alone past `maxFolders`. */
const joined = (folders: Folders, more: Folders): Folders => {
  const all = [...folders]
  const seen = new Set(all.map(folderKey))
  for (const folder of more) {
    const key = folderKey(folder)
    if (seen.has(key)) continue
    if (all.length >= maxFolders) return unknownFolder
    seen.add(key)
    all.push(folder)
  }
  return all
}

/** A `cd` target bash looks up in `CDPATH`: relative, its first segment neither `.` nor `..`. */
const searched = (target: string): boolean =>
  !target.startsWith('/') &&
  !target.startsWith('~') &&
  !/^\.\.?(?:\/|$)/u.test(target)

/** What the command line may set, anywhere in it, that moves where `cd` and `~` land. */
interface Moved {
  /** `CDPATH`, so a `cd` may land under one of its folders. */
  readonly cdPath: boolean
  /** `cdable_vars`, so a `cd` may land where a variable names. */
  readonly cdableVariables: boolean
  /** `HOME`, so `~`, `$HOME` and a bare `cd` land where the gate can't tell. */
  readonly home: boolean
}

const sameMoved = (one: Moved, other: Moved): boolean =>
  one.cdPath === other.cdPath &&
  one.cdableVariables === other.cdableVariables &&
  one.home === other.home

/** Reads a command line's findings, the folders each command may run in followed through `cd`. */
class Policy {
  readonly findings: Array<Finding> = []
  /** The command line runs more than one command, so what's on disk now may be gone when one runs. */
  several = false

  constructor(
    readonly context: CommandContext,
    /** What the command line sets, as read so far: it only grows. */
    public moved: Moved,
  ) {}

  /** The home folder, unknown once the command line may set `HOME`. */
  get home(): Option.Option<string> {
    return this.moved.home ? Option.none() : this.context.home
  }

  ask(reason: string): void {
    this.findings.push(Finding.Ask({ reason }))
  }

  refuse(reason: string): void {
    this.findings.push(Finding.Refused({ reason }))
  }

  paths(cwd: Option.Option<string>): PathContext {
    return { worktree: this.context.worktree, home: this.home, cwd }
  }

  /** Where `word` lands, read from each of `cwd`: outside where it is from any. */
  place(word: Word, cwd: Folders, last: LastLink = 'followed'): Confinement {
    if (word.dynamic)
      return Confinement.Unknown({
        reason: `${word.text} is known only when it runs`,
      })
    return worst(
      cwd.map(folder => confine(word.pattern, this.paths(folder), last)),
    )
  }

  written(word: Word, cwd: Folders): void {
    if (!word.dynamic && harmlessTargets.test(word.text)) return
    Confinement.$match(this.place(word, cwd), {
      Inside: () => undefined,
      Outside: ({ path }) => this.ask(`writes outside the worktree: ${path}`),
      Unknown: ({ reason }) =>
        this.ask(`writes ${word.text}, which the gate can’t place: ${reason}`),
      Refused: ({ reason }) => this.refuse(reason),
    })
  }

  removed(word: Word, cwd: Folders, last: LastLink = 'kept'): void {
    Confinement.$match(this.place(word, cwd, last), {
      Inside: () => undefined,
      Outside: ({ path }) =>
        this.refuse(`removes outside the worktree: ${path}`),
      Unknown: ({ reason }) =>
        this.ask(`removes ${word.text}, which the gate can’t place: ${reason}`),
      Refused: ({ reason }) => this.refuse(reason),
    })
  }

  /** `ln -s`: a link made here isn't on disk yet for the rest of the line to be read through, so one out of the worktree asks. */
  linked(word: Word, cwd: Folders): void {
    Confinement.$match(this.place(word, cwd), {
      Inside: () => undefined,
      Outside: ({ path }) => this.ask(`links to ${path}, outside the worktree`),
      Unknown: ({ reason }) =>
        this.ask(
          `links to ${word.text}, which the gate can’t place: ${reason}`,
        ),
      Refused: ({ reason }) => this.refuse(reason),
    })
  }

  /**
   * `ln -s`'s `made` targets with the link's name last on its line: `ln` makes each link inside it
   * where it is already a folder, so a target is read from there, or else from the folder it's made in.
   * A folder is only known to be one where nothing else on the line can replace it first.
   */
  linkedTo(
    made: ReadonlyArray<Word>,
    link: Word,
    last: LastLink | 'never a folder',
    cwd: Folders,
  ): void {
    for (const from of cwd) {
      const readings =
        link.dynamic || last === 'never a folder'
          ? []
          : folderReadings(link.pattern, this.paths(from), last)
      const inFolder = readings.some(folder => folder)
      for (const target of made) {
        if (inFolder)
          this.linked(fromLink(target, syntheticWord(link, '/_')), [from])
        if (!inFolder || this.several || readings.some(folder => !folder))
          this.linked(fromLink(target, link), [from])
      }
    }
  }

  /** The folders `word` names from each of `cwd`: every brace alternative, a glob read as `..` where it can be. */
  folder(word: Word, cwd: Folders): Folders {
    if (word.dynamic) return unknownFolder
    return cwd.reduce<Folders>(
      (landed, from) =>
        joined(
          landed,
          Locations.$match(locations(word.pattern, this.paths(from)), {
            Refused: ({ reason }) => {
              this.refuse(reason)
              return unknownFolder
            },
            Located: ({ places }) =>
              places.map(place =>
                Place.$match(place, {
                  At: ({ path }) => Option.some(path),
                  Unknown: () => Option.none<string>(),
                }),
              ),
          }),
        ),
      [],
    )
  }

  /** The folders `cd` or `pushd` with `args` may land in from `cwd`. */
  changeFolder(name: string, args: ReadonlyArray<Word>, cwd: Folders): Folders {
    const target = operands(args)[0]
    if (target === undefined) return name === 'cd' ? [this.home] : unknownFolder
    if (
      target.text === '-' ||
      (name === 'pushd' && /^\+\d+$/u.test(target.text))
    )
      return unknownFolder
    const landed = this.folder(target, cwd)
    return this.moved.cdableVariables ||
      (this.moved.cdPath && (target.dynamic || searched(target.text)))
      ? joined(landed, unknownFolder)
      : landed
  }

  /** Every command of `source`, run from `cwd`; the folders it may leave the shell in. */
  script(source: string, cwd: Folders, depth: number): Folders {
    if (depth > maxDepth) {
      this.ask('runs shells nested deeper than the gate follows')
      return joined(cwd, unknownFolder)
    }
    return Script.$match(parseScript(source, this.home), {
      Unparsable: ({ reason }) => {
        // What can't be read may still push or run as another user: their words alone refuse it.
        if (unreadPush.test(source))
          this.findings.push(Finding.Push({ command: 'git push' }))
        if (unreadSudo.test(source))
          this.refuse('sudo: commands never run as another user')
        this.ask(`the gate can’t read the command: ${reason}`)
        return joined(cwd, unknownFolder)
      },
      Parsed: ({ commands, unnamed, doubts }) => {
        for (const doubt of doubts) this.ask(doubt)
        if (commands.length > 1) this.several = true
        // Set anywhere, even after a `cd` (in a loop, it runs before the next one), they move it.
        const texts = [
          ...commands.flatMap(({ words, writes }) => [...words, ...writes]),
          ...unnamed,
        ].flatMap(spellings)
        const named = (name: string) => texts.some(text => text.includes(name))
        // `${!v:=x}` assigns to the variable `v` names, in the bash versions that take it.
        const indirect = texts.some(text => /\$\{![^}]*=/u.test(text))
        this.moved = {
          cdPath: this.moved.cdPath || indirect || named('CDPATH'),
          cdableVariables:
            this.moved.cdableVariables || indirect || named('cdable_vars'),
          home: this.moved.home || indirect || named('HOME'),
        }
        return commands.reduce(
          (folders, command) => this.command(command, folders, depth),
          cwd,
        )
      },
    })
  }

  /**
   * A command that may set a variable whose name is known only when it runs (`declare "${v}PATH=.."`,
   * `read "$v"`, `printf -v "$v"`), which may be any of those that move `cd` and `~`; a nameref
   * (`declare -n r`), which makes every assignment to its name one to another variable, is asked about.
   */
  setsUnnamed(first: Word, args: ReadonlyArray<Word>): void {
    const names = spellings(first).map(text => basename(text))
    const options = [first, ...args].flatMap(spellings)
    const option = (pattern: RegExp) => options.some(text => pattern.test(text))
    const dynamicOperand = args.some(dynamicName)
    const nameref =
      names.some(name => namerefs.has(name)) &&
      (dynamicOperand || option(/^-[A-Za-z]*n/u))
    if (nameref)
      this.ask(
        `${first.text} may make a name refer to another variable, which the gate can’t follow`,
      )
    if (
      nameref ||
      (dynamicOperand &&
        names.some(
          name =>
            setters.has(name) ||
            (name === 'printf' &&
              (option(/^-v/u) || args[0]?.dynamic === true)) ||
            (shells.has(name) && option(/^[-+]O/u)),
        ))
    )
      this.moved = { cdPath: true, cdableVariables: true, home: true }
  }

  /** A simple command's findings, run from `cwd`; the folders it may leave the shell in. */
  command(command: SimpleCommand, cwd: Folders, depth: number): Folders {
    for (const target of command.writes) this.written(target, cwd)
    return this.words(command.words, cwd, depth)
  }

  /** A command's words: wrappers seen through, then the command itself. */
  words(words: ReadonlyArray<Word>, cwd: Folders, depth: number): Folders {
    let index = 0
    for (; index < words.length; index++) {
      const word = words[index]
      const name =
        word === undefined ? undefined : assignment.exec(word.text)?.[1]
      if (word === undefined || name === undefined) break
      if (gitVariables.has(name))
        this.ask(`sets ${name}, pointing git elsewhere`)
    }
    const rest = words.slice(index)
    const first = rest[0]
    if (first === undefined) return cwd
    if (first.dynamic) {
      this.ask(`the command ${first.text} is known only when it runs`)
      return cwd
    }
    // A name spelled by brace expansion: bash runs the first alternative, the others its first arguments.
    const alternatives = spellings(first).slice(1)
    if (alternatives.length > 1) {
      this.ask(`the command ${first.text} is spelled by brace expansion`)
      return this.words(
        [
          ...alternatives.map(text => ({
            text,
            pattern: text.replace(/[\\{},]/gu, '\\$&'),
            dynamic: false,
          })),
          ...rest.slice(1),
        ],
        cwd,
        depth,
      )
    }
    const name = basename(first.text)
    const args = rest.slice(1)
    this.setsUnnamed(first, args)

    if (refusedUsers.has(name)) {
      this.refuse(`${name}: commands never run as another user`)
      return cwd
    }
    if (name === 'cd' || name === 'pushd')
      return joined(cwd, this.changeFolder(name, args, cwd))
    if (name === 'popd') return joined(cwd, unknownFolder)

    const wrapped = this.wrapped(name, args)
    if (wrapped !== undefined) return this.words(wrapped, cwd, depth)

    this.runsIn(name, cwd)

    if (shells.has(name)) {
      const flag = args.findIndex(
        ({ text, dynamic }) => !dynamic && /^-[A-Za-z]*c[A-Za-z]*$/u.test(text),
      )
      if (flag === -1) {
        if (operands(args).length === 0)
          this.ask(
            `${name} runs a script from its input, which the gate can’t read`,
          )
        return cwd
      }
      const source = args
        .slice(flag + 1)
        .find(({ text }) => !text.startsWith('-'))
      if (source === undefined) return cwd
      if (source.dynamic)
        this.ask(`${name} -c runs a script known only when it runs`)
      else {
        // The gate reads a script as bash does, and the others read some otherwise.
        if (otherGrammars.has(name))
          this.ask(`${name} reads its script by rules the gate doesn’t know`)
        else if (name !== 'bash' && /\$['"]/u.test(source.text))
          this.ask(
            `${name} may not know $'…' or $"…", so the gate can’t tell where they end`,
          )
        this.script(source.text, cwd, depth + 1)
      }
      return cwd
    }
    if (name === 'eval') {
      if (args.some(({ dynamic }) => dynamic)) {
        this.ask('eval runs a command known only when it runs')
        return cwd
      }
      return this.script(args.map(({ text }) => text).join(' '), cwd, depth + 1)
    }
    if (name === 'find') {
      this.find(args, cwd, depth)
      return cwd
    }
    if (name === 'git') {
      this.git(args, cwd)
      return cwd
    }
    this.plain(name, args, cwd)
    return cwd
  }

  /** The command a wrapper runs (`env`, `nohup`, `timeout`, `xargs`…), or none for a command of its own. */
  wrapped(
    name: string,
    args: ReadonlyArray<Word>,
  ): ReadonlyArray<Word> | undefined {
    const after = (values: ReadonlySet<string>, positionals = 0) => {
      let index = 0
      let skipped = 0
      for (; index < args.length; index++) {
        const word = args[index]
        if (word === undefined) break
        if (word.text === '--') return args.slice(index + 1)
        if (!word.dynamic && word.text.startsWith('-') && word.text !== '-') {
          if (values.has(word.text)) index++
          continue
        }
        if (skipped === positionals) break
        skipped++
      }
      return args.slice(index)
    }
    switch (name) {
      case 'env': {
        if (hasOption(args, '-S', '--split-string')) {
          this.ask('env -S runs a command the gate doesn’t split')
          return []
        }
        if (hasOption(args, '-C', '--chdir')) {
          this.ask('env -C runs a command in another folder')
          return []
        }
        return after(new Set(['-u', '--unset']))
      }
      case 'command':
      case 'builtin':
        return hasOption(args, '-v', '-V') ? [] : after(new Set())
      case 'exec':
        return after(new Set(['-a']))
      case 'nohup':
      case 'time':
      case 'chronic':
      case 'unbuffer':
      case 'caffeinate':
        return after(new Set())
      case 'nice':
        return after(new Set(['-n', '--adjustment']))
      case 'ionice':
        return after(new Set(['-c', '-n', '--class', '--classdata']))
      case 'stdbuf':
        return after(new Set(['-i', '-o', '-e']))
      case 'timeout':
        return after(new Set(['-s', '-k', '--signal', '--kill-after']), 1)
      case 'watch':
        return after(new Set(['-n', '-d', '--interval']))
      case 'busybox':
      case 'toybox':
        if (args[0]?.text === '--install') {
          this.ask(`${name} --install writes its links where it’s told`)
          return []
        }
        return args
      case 'xargs': {
        const command = after(
          new Set([
            '-I',
            '-n',
            '-P',
            '-L',
            '-s',
            '-d',
            '-E',
            '-a',
            '--max-args',
            '--max-procs',
            '--delimiter',
            '--arg-file',
          ]),
        )
        return command.length === 0
          ? command
          : [...command, { text: '<input>', pattern: '<input>', dynamic: true }]
      }
      default:
        return undefined
    }
  }

  /** Where a command runs: outside the worktree, or somewhere the gate can't tell, asks. */
  runsIn(name: string, cwd: Folders): void {
    for (const from of cwd)
      Option.match(from, {
        onNone: () => this.ask(`${name} runs in a folder the gate can’t tell`),
        onSome: folder => {
          if (!isInside(this.context.worktree, folder))
            this.ask(`${name} runs outside the worktree, in ${folder}`)
        },
      })
  }

  find(args: ReadonlyArray<Word>, cwd: Folders, depth: number): void {
    const { words, rootsGiven } = findOptions(args)
    const start = words.findIndex(
      ({ text, dynamic }) =>
        !dynamic && (text.startsWith('-') || text === '(' || text === '!'),
    )
    const given = [
      ...rootsGiven,
      ...(start === -1 ? words : words.slice(0, start)),
    ]
    const roots: ReadonlyArray<Word> =
      given.length > 0 ? given : [{ text: '.', pattern: '.', dynamic: false }]
    const expression = start === -1 ? [] : words.slice(start)
    if (
      args.some(
        ({ text }) =>
          /^-[HLPEXdsx]*L[HLPEXdsx]*(?:f.*)?$/u.test(text) ||
          text === '-follow',
      ) &&
      expression.some(({ text }) => findActions.has(text))
    )
      this.ask('find follows links as it walks, where the gate can’t tell')
    // `-H` and `-L` go through a root that is a link.
    if (expression.some(({ text }) => text === '-delete'))
      for (const root of roots) this.removed(root, cwd, 'followed')
    for (let index = 0; index < expression.length; index++) {
      const word = expression[index]
      if (word === undefined || word.text === '-delete') continue
      if (findOutputs.has(word.text)) {
        const output = expression[index + 1]
        if (output !== undefined) this.written(output, cwd)
        index++
        continue
      }
      if (!findActions.has(word.text)) continue
      this.several = true
      const end = expression.findIndex(
        // `+` ends the command only straight after `{}`.
        ({ text }, at) =>
          at > index &&
          (text === ';' || (text === '+' && expression[at - 1]?.text === '{}')),
      )
      const inner = expression.slice(index + 1, end === -1 ? undefined : end)
      // `-execdir` and `-okdir` run in each match's folder, which the gate doesn't follow.
      const runIn = word.text.endsWith('dir') ? unknownFolder : cwd
      for (const root of roots)
        this.words(
          inner.map(part => foundWord(part, root)),
          runIn,
          depth,
        )
      if (end !== -1) index = end
    }
  }

  plain(name: string, args: ReadonlyArray<Word>, cwd: Folders): void {
    if ((modeWriters.has(name) || name === 'chflags') && hasOption(args, '-L'))
      this.ask(
        `${name} -L follows links as it walks, where the gate can’t tell`,
      )
    if (removals.has(name)) {
      // `shred` overwrites what a link points at; the others remove the link.
      const last = name === 'shred' ? 'followed' : 'kept'
      for (const target of operands(args)) this.removed(target, cwd, last)
      return
    }
    if (name === 'mv') {
      const all = operands(args, moverValues)
      const targets = optionValues(
        args,
        ['-t', '--target-directory'],
        moverValues,
      )
      const sources = targets.length > 0 ? all : all.slice(0, -1)
      for (const source of sources) this.removed(source, cwd)
      for (const destination of targets.length > 0 ? targets : all.slice(-1))
        this.written(destination, cwd)
      return
    }
    if (copiers.has(name)) {
      const all = operands(args, copierValues)
      if (
        name === 'install' &&
        hasFlag(args, copierValues, '-d', '--directory')
      ) {
        for (const folder of all) this.written(folder, cwd)
        return
      }
      const targets = optionValues(
        args,
        ['-t', '--target-directory'],
        copierValues,
      )
      const lastNames = targets.length === 0 && all.length > 1
      // GNU's `-r` reads a target from the current folder, and makes it relative to the link itself.
      if (
        name === 'ln' &&
        hasFlag(args, copierValues, '-s', '--symbolic') &&
        hasFlag(args, copierValues, '-r', '--relative')
      )
        for (const made of lastNames ? all.slice(0, -1) : all)
          this.linked(made, cwd)
      else if (
        name === 'ln' &&
        hasFlag(args, copierValues, '-s', '--symbolic')
      ) {
        for (const folder of targets)
          for (const made of all)
            this.linked(fromLink(made, syntheticWord(folder, '/_')), cwd)
        const last = all.at(-1)
        if (targets.length === 0 && !lastNames)
          for (const made of all) this.linked(made, cwd)
        else if (lastNames && last !== undefined)
          this.linkedTo(
            all.slice(0, -1),
            last,
            // BSD's `-F` removes the folder first, so the link takes its place.
            hasFlag(args, copierValues, '-T', '-F', '--no-target-directory')
              ? 'never a folder'
              : hasFlag(args, copierValues, '-n', '-h', '--no-dereference')
                ? 'kept'
                : 'followed',
            cwd,
          )
      }
      for (const destination of lastNames ? all.slice(-1) : targets)
        this.written(destination, cwd)
      return
    }
    const values = writers.get(name)
    if (values !== undefined) {
      for (const target of operands(args, values)) this.written(target, cwd)
      return
    }
    if (modeWriters.has(name)) {
      const all = operands(args, new Set(['--reference']))
      const changed = args.some(({ text }) => namesLong(text, '--reference'))
        ? all
        : all.slice(1)
      for (const target of changed) this.written(target, cwd)
      return
    }
    if (name === 'dd') {
      for (const word of args)
        if (word.text.startsWith('of='))
          this.written(
            {
              text: word.text.slice(3),
              pattern: word.pattern.slice(3),
              dynamic: word.dynamic,
            },
            cwd,
          )
      return
    }
    if (name === 'sed') {
      const { inPlace, scripted, words } = sedArguments(args)
      if (!inPlace) return
      const all = operands(words, sedScripts)
      for (const file of scripted ? all : all.slice(1)) this.written(file, cwd)
      return
    }
    if (name === 'sort') {
      for (const output of optionValues(args, ['-o', '--output'], sortValues))
        this.written(output, cwd)
      return
    }
    if (network.has(name)) {
      this.ask(`${name} reaches the network`)
      return
    }
    const why =
      risky.get(name) ??
      (name.startsWith('mkfs') ? 'formats a disk' : undefined)
    if (why !== undefined) {
      this.ask(`${name} ${why}`)
      return
    }
    const subcommand = operands(args)[0]?.text
    if (
      (nodePackageManagers.has(name) &&
        (hasOption(args, '-g', '--global') || subcommand === 'global')) ||
      (subcommand !== undefined &&
        globalInstalls.get(name)?.has(subcommand) === true) ||
      (name === 'uv' && subcommand === 'tool') ||
      (name === 'pip' && hasOption(args, '--user')) ||
      (name === 'pip3' && hasOption(args, '--user'))
    ) {
      this.ask(`${name} installs packages outside the worktree`)
      return
    }
    if (
      subcommand !== undefined &&
      publishing.get(name)?.has(subcommand) === true
    )
      this.ask(`${name} ${subcommand} publishes a package`)
  }

  git(args: ReadonlyArray<Word>, cwd: Folders): void {
    let folder = cwd
    let index = 0
    for (; index < args.length; index++) {
      const word = args[index]
      if (word === undefined) break
      if (word.dynamic) break
      const text = word.text
      if (!text.startsWith('-')) break
      if (text === '-C') {
        const target = args[index + 1]
        folder =
          target === undefined ? unknownFolder : this.folder(target, folder)
        index++
      } else if (text === '-c') {
        const setting = args[index + 1]
        index++
        if (
          setting !== undefined &&
          (setting.dynamic || gitRunsSetting.test(setting.text))
        )
          this.ask(`git -c ${setting.text} changes what git runs`)
      } else if (text === '--config-env' || text.startsWith('--config-env=')) {
        const setting = text.includes('=')
          ? attachedValue(word, text.indexOf('=') + 1)
          : args[++index]
        if (
          setting !== undefined &&
          (setting.dynamic || gitRunsSetting.test(setting.text))
        )
          this.ask(`git --config-env ${setting.text} changes what git runs`)
      } else if (
        text === '--git-dir' ||
        text === '--work-tree' ||
        text.startsWith('--git-dir=') ||
        text.startsWith('--work-tree=')
      ) {
        this.ask(`git ${text} points git at another repository or worktree`)
        if (!text.includes('=')) index++
      } else if (text === '--namespace' || text === '--super-prefix') index++
    }
    const rest = args.slice(index)
    const sub = rest[0]
    const subArgs = rest.slice(1)
    this.runsIn('git', folder)
    if (sub === undefined) return
    if (sub.dynamic) {
      this.ask(`git ${sub.text} is known only when it runs`)
      return
    }
    const command = `git ${sub.text}`
    const branchWrite = () =>
      this.findings.push(Finding.BranchWrite({ command }))
    const positional = operands(subArgs)
    const second = positional[0]?.text
    switch (sub.text) {
      case 'push':
      case 'send-pack':
      case 'http-push':
        this.findings.push(Finding.Push({ command }))
        return
      case 'subtree':
      case 'lfs':
        if (second === 'push')
          this.findings.push(Finding.Push({ command: `${command} push` }))
        else if (
          sub.text === 'lfs' &&
          (second === 'fetch' || second === 'pull')
        )
          this.ask(`${command} ${second} reaches the network`)
        return
      case 'svn':
        if (second === 'dcommit')
          this.findings.push(Finding.Push({ command: `${command} dcommit` }))
        else this.ask(`${command} reaches the network`)
        return
      case 'filter-branch':
      case 'filter-repo':
        this.refuse(`${command} rewrites the history of every branch`)
        return
      case 'branch': {
        const flag = [
          '-d',
          '-D',
          '--delete',
          '-m',
          '-M',
          '--move',
          '-f',
          '--force',
          '-C',
        ].find(option => hasOption(subArgs, option))
        if (flag !== undefined) {
          this.refuse(`git branch ${flag} rewrites another branch`)
          branchWrite()
        }
        return
      }
      case 'checkout':
        if (hasOption(subArgs, '-B'))
          this.refuse('git checkout -B resets another branch')
        if (!subArgs.some(({ text }) => text === '--')) branchWrite()
        return
      case 'switch':
        if (hasOption(subArgs, '-C', '--force-create'))
          this.refuse(`git switch -C resets another branch`)
        branchWrite()
        return
      case 'update-ref':
        this.refuse('git update-ref writes a branch directly')
        branchWrite()
        return
      case 'rebase': {
        if (hasOption(subArgs, '--update-refs'))
          this.refuse('git rebase --update-refs moves other branches')
        const named = operands(
          subArgs,
          new Set([
            '--onto',
            '-s',
            '--strategy',
            '-X',
            '--strategy-option',
            '-x',
            '--exec',
            '-C',
          ]),
        )
        if (named.length >= 2)
          this.refuse(
            `git rebase rebases another branch, ${named[1]?.text ?? ''}`,
          )
        branchWrite()
        return
      }
      case 'commit':
      case 'merge':
      case 'reset':
      case 'cherry-pick':
      case 'revert':
      case 'am':
        branchWrite()
        return
      case 'pull':
      case 'fetch': {
        this.ask(`${command} reaches the network`)
        for (const spec of positional.slice(1)) {
          const destination = /:(.+)$/u.exec(spec.text)?.[1]
          if (
            destination !== undefined &&
            !/^refs\/(?:remotes|tags)\//u.test(destination)
          )
            this.refuse(`${command} ${spec.text} writes another branch`)
        }
        if (sub.text === 'pull') branchWrite()
        return
      }
      case 'clone':
      case 'ls-remote':
        this.ask(`${command} reaches the network`)
        return
      case 'archive':
        if (hasOption(subArgs, '--remote'))
          this.ask(`${command} --remote reaches the network`)
        return
      case 'remote':
        if (second === 'update' || second === 'prune' || second === 'show')
          this.ask(`${command} ${second} reaches the network`)
        return
      case 'submodule':
        if (second === 'update' || second === 'add' || second === 'sync')
          this.ask(`${command} ${second} reaches the network`)
        return
      case 'config': {
        // A write without --worktree lands in the config every worktree shares (or the user's,
        // or the system's), where core.fsmonitor or core.hooksPath runs in the engine's own git.
        if (configReads(subArgs)) return
        const files = optionValues(subArgs, ['-f', '--file'], configValues)
        for (const file of files) this.written(file, folder)
        if (files.length === 0 && !hasOption(subArgs, '--worktree'))
          this.ask(
            'git config writes git’s settings outside the worktree, which other worktrees share',
          )
        return
      }
      case 'worktree':
        if (second === 'add') {
          if (hasOption(subArgs, '-B'))
            this.refuse('git worktree add -B resets another branch')
          const path = operands(subArgs, new Set(['-b', '-B', '--reason']))[1]
          if (path !== undefined) this.written(path, folder)
        } else if (second !== undefined && second !== 'list')
          this.ask(`${command} ${second} changes other worktrees`)
        return
      case 'init':
        // A template's hooks land in the config and hooks every worktree shares, and git runs them.
        if (optionValues(subArgs, ['--template'], gitInitValues).length > 0)
          this.ask(
            `${command} --template copies hooks git runs in every worktree`,
          )
        for (const path of [
          ...operands(subArgs, gitInitValues),
          ...optionValues(subArgs, ['--separate-git-dir'], gitInitValues),
        ])
          this.written(path, folder)
        return
      case 'reflog':
        if (second === 'expire' || second === 'delete')
          this.ask(`${command} ${second} drops history`)
        return
      case 'gc':
      case 'prune':
        this.ask(`${command} prunes objects every worktree shares`)
        return
      case 'stash':
        if (second === 'clear' || second === 'drop')
          this.ask(
            `${command} ${second} drops stashes, which every worktree shares`,
          )
        return
      case 'tag':
        if (hasOption(subArgs, '-d', '-f', '--delete', '--force'))
          this.ask(`${command} deletes or moves a tag`)
        return
      case 'replace':
      case 'symbolic-ref':
        this.ask(`${command} points refs elsewhere`)
        return
      default:
        if (!knownGit.has(sub.text))
          this.ask(`${command} isn’t a git command the gate knows (an alias?)`)
    }
  }
}

/** Git's commands that change nothing beyond the worktree's own files, index and new branches. */
const knownGit = new Set([
  'add',
  'apply',
  'bisect',
  'blame',
  'bundle',
  'cat-file',
  'check-attr',
  'check-ignore',
  'check-mailmap',
  'check-ref-format',
  'cherry',
  'clean',
  'column',
  'commit-graph',
  'count-objects',
  'describe',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'difftool',
  'for-each-ref',
  'format-patch',
  'fsck',
  'grep',
  'hash-object',
  'help',
  'interpret-trailers',
  'log',
  'ls-files',
  'ls-tree',
  'maintenance',
  'merge-base',
  'merge-file',
  'merge-tree',
  'mailinfo',
  'mailsplit',
  'mktag',
  'mktree',
  'mv',
  'name-rev',
  'notes',
  'range-diff',
  'read-tree',
  'rerere',
  'restore',
  'rev-list',
  'rev-parse',
  'rm',
  'shortlog',
  'show',
  'show-branch',
  'show-ref',
  'sparse-checkout',
  'status',
  'stripspace',
  'update-index',
  'var',
  'verify-commit',
  'verify-pack',
  'verify-tag',
  'version',
  'whatchanged',
  'write-tree',
  '--version',
  '--help',
])

/** What `source`, a bash command line run in the worktree, does that the gate weighs. */
export const commandFindings = (
  source: string,
  context: CommandContext,
): ReadonlyArray<Finding> => {
  const worktree = realFolder(context.worktree)
  // What a nested script sets (`eval`, `bash -c`) is read only once the gate reaches it, after the
  // commands before it: the line is read again from the start, knowing it, until nothing new is set.
  let moved: Moved = {
    cdPath: context.cdPath,
    cdableVariables: context.cdableVariables,
    home: false,
  }
  for (;;) {
    const policy = new Policy({ ...context, worktree }, moved)
    policy.script(source, [Option.some(worktree)], 0)
    if (sameMoved(policy.moved, moved)) return policy.findings
    moved = policy.moved
  }
}
