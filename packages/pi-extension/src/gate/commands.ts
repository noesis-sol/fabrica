import { Data, Equivalence, Option } from 'effect'
import { basename } from 'node:path'

import {
  Confinement,
  Locations,
  type PathContext,
  Place,
  confine,
  isInside,
  locations,
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

/** The facts commands are read with: the worktree, and the home folder where known. */
export interface CommandContext {
  readonly worktree: string
  readonly home: Option.Option<string>
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
])

const shells = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])

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

/** A word made by the gate, standing for a path. */
const syntheticWord = (word: Word, suffix: string): Word => ({
  text: `${word.text}${suffix}`,
  pattern: `${word.pattern}${suffix}`,
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
    else if (values.has(word.text)) index++
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

/** The value of option `option` in `words` (`-t dir`, `--target=dir`), when given. */
const optionValue = (
  words: ReadonlyArray<Word>,
  short: string,
  long: string,
): Option.Option<Word> => {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word === undefined) continue
    if (word.text === short || word.text === long)
      return Option.fromUndefinedOr(words[index + 1])
    if (word.text.startsWith(`${long}=`))
      return Option.some({
        text: word.text.slice(long.length + 1),
        pattern: word.pattern.slice(long.length + 1),
        dynamic: word.dynamic,
      })
  }
  return Option.none()
}

/**
 * The folders a command may run in, none where the gate can't tell one. The gate reads a command
 * line as one list, without knowing which of its commands run (one in a subshell, after a failing
 * `cd`, in a branch, in a function never called), so a `cd` adds the folder it lands in to the
 * folders before it and drops none: a path is placed from each.
 */
type Folders = ReadonlyArray<Option.Option<string>>

const sameFolder = Option.makeEquivalence(Equivalence.String)

/** `folders` and `more`, each folder once. */
const joined = (folders: Folders, more: Folders): Folders =>
  more.reduce<Folders>(
    (all, folder) =>
      all.some(known => sameFolder(known, folder)) ? all : [...all, folder],
    folders,
  )

const unknownFolder: Folders = [Option.none()]

/** How many folders the gate follows; past them, it can't tell where commands run. */
const maxFolders = 64

/** A `cd` target bash looks up in `CDPATH`: relative, its first segment neither `.` nor `..`. */
const searched = (target: string): boolean =>
  !target.startsWith('/') &&
  !target.startsWith('~') &&
  !/^\.\.?(?:\/|$)/u.test(target)

/** Reads a command line's findings, the folders each command may run in followed through `cd`. */
class Policy {
  readonly findings: Array<Finding> = []
  /** The command line sets `CDPATH`, so a `cd` may land under one of its folders. */
  cdPath = false
  /** The command line sets `cdable_vars`, so a `cd` may land where a variable names. */
  cdableVariables = false

  constructor(readonly context: CommandContext) {}

  ask(reason: string): void {
    this.findings.push(Finding.Ask({ reason }))
  }

  refuse(reason: string): void {
    this.findings.push(Finding.Refused({ reason }))
  }

  paths(cwd: Option.Option<string>): PathContext {
    return { worktree: this.context.worktree, home: this.context.home, cwd }
  }

  /** Where `word` lands, read from each of `cwd`: outside where it is from any. */
  place(word: Word, cwd: Folders): Confinement {
    if (word.dynamic)
      return Confinement.Unknown({
        reason: `${word.text} is known only when it runs`,
      })
    const found = cwd.map(folder => confine(word.pattern, this.paths(folder)))
    return (
      found.find(Confinement.$is('Refused')) ??
      found.find(Confinement.$is('Outside')) ??
      found.find(Confinement.$is('Unknown')) ??
      Confinement.Inside()
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

  removed(word: Word, cwd: Folders): void {
    Confinement.$match(this.place(word, cwd), {
      Inside: () => undefined,
      Outside: ({ path }) =>
        this.refuse(`removes outside the worktree: ${path}`),
      Unknown: ({ reason }) =>
        this.ask(`removes ${word.text}, which the gate can’t place: ${reason}`),
      Refused: ({ reason }) => this.refuse(reason),
    })
  }

  /** The folders `word` names from each of `cwd`: every brace alternative, a glob read as `..` where it can be. */
  folder(word: Word, cwd: Folders): Folders {
    if (word.dynamic) return unknownFolder
    return joined(
      [],
      cwd.flatMap(from =>
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
    )
  }

  /** The folders `cd` or `pushd` with `args` may land in from `cwd`. */
  changeFolder(name: string, args: ReadonlyArray<Word>, cwd: Folders): Folders {
    const target = operands(args)[0]
    if (target === undefined)
      return name === 'cd' ? [this.context.home] : unknownFolder
    if (
      target.text === '-' ||
      (name === 'pushd' && /^\+\d+$/u.test(target.text))
    )
      return unknownFolder
    const landed = this.folder(target, cwd)
    return this.cdableVariables ||
      (this.cdPath && (target.dynamic || searched(target.text)))
      ? joined(landed, unknownFolder)
      : landed
  }

  /** Every command of `source`, run from `cwd`; the folders it may leave the shell in. */
  script(source: string, cwd: Folders, depth: number): Folders {
    if (depth > maxDepth) {
      this.ask('runs shells nested deeper than the gate follows')
      return joined(cwd, unknownFolder)
    }
    return Script.$match(parseScript(source, this.context.home), {
      Unparsable: ({ reason }) => {
        // What can't be read may still push or run as another user: their words alone refuse it.
        if (unreadPush.test(source))
          this.findings.push(Finding.Push({ command: 'git push' }))
        if (unreadSudo.test(source))
          this.refuse('sudo: commands never run as another user')
        this.ask(`the gate can’t read the command: ${reason}`)
        return joined(cwd, unknownFolder)
      },
      Parsed: ({ commands }) => {
        // Set anywhere, even after a `cd` (in a loop, it runs before the next one), they move it.
        const texts = commands.flatMap(({ words }) =>
          words.map(({ text }) => text),
        )
        if (texts.some(text => text.includes('CDPATH'))) this.cdPath = true
        if (texts.some(text => text.includes('cdable_vars')))
          this.cdableVariables = true
        return commands.reduce(
          (folders, command) => this.command(command, folders, depth),
          cwd,
        )
      },
    })
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
    const name = basename(first.text)
    const args = rest.slice(1)

    if (refusedUsers.has(name)) {
      this.refuse(`${name}: commands never run as another user`)
      return cwd
    }
    if (name === 'cd' || name === 'pushd') {
      const folders = joined(cwd, this.changeFolder(name, args, cwd))
      return folders.length > maxFolders ? unknownFolder : folders
    }
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
      else this.script(source.text, cwd, depth + 1)
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
    const start = args.findIndex(
      ({ text, dynamic }) =>
        !dynamic && (text.startsWith('-') || text === '(' || text === '!'),
    )
    const given = start === -1 ? args : args.slice(0, start)
    const roots: ReadonlyArray<Word> =
      given.length > 0 ? given : [{ text: '.', pattern: '.', dynamic: false }]
    const expression = start === -1 ? [] : args.slice(start)
    if (expression.some(({ text }) => text === '-delete'))
      for (const root of roots) this.removed(root, cwd)
    for (let index = 0; index < expression.length; index++) {
      const word = expression[index]
      if (
        word === undefined ||
        !['-exec', '-execdir', '-ok', '-okdir'].includes(word.text)
      )
        continue
      const end = expression.findIndex(
        ({ text }, at) => at > index && (text === ';' || text === '+'),
      )
      const inner = expression.slice(index + 1, end === -1 ? undefined : end)
      // `-execdir` and `-okdir` run in each match's folder, which the gate doesn't follow.
      const runIn = word.text.endsWith('dir') ? unknownFolder : cwd
      for (const root of roots)
        this.words(
          inner.map(part =>
            part.text === '{}' ? syntheticWord(root, '/_') : part,
          ),
          runIn,
          depth,
        )
      if (end !== -1) index = end
    }
  }

  plain(name: string, args: ReadonlyArray<Word>, cwd: Folders): void {
    if (removals.has(name)) {
      for (const target of operands(args)) this.removed(target, cwd)
      return
    }
    if (name === 'mv') {
      const all = operands(args, new Set(['-t', '-S', '--suffix']))
      const target = optionValue(args, '-t', '--target-directory')
      const sources = Option.isSome(target) ? all : all.slice(0, -1)
      for (const source of sources) this.removed(source, cwd)
      Option.match(
        Option.orElse(target, () => Option.fromUndefinedOr(all.at(-1))),
        {
          onNone: () => undefined,
          onSome: destination => this.written(destination, cwd),
        },
      )
      return
    }
    if (copiers.has(name)) {
      const all = operands(
        args,
        new Set([
          '-t',
          '-S',
          '-m',
          '-o',
          '-g',
          '--suffix',
          '--mode',
          '--owner',
          '--group',
        ]),
      )
      if (name === 'install' && hasOption(args, '-d', '--directory')) {
        for (const folder of all) this.written(folder, cwd)
        return
      }
      const target = optionValue(args, '-t', '--target-directory')
      Option.match(
        Option.orElse(target, () =>
          all.length > 1 ? Option.fromUndefinedOr(all.at(-1)) : Option.none(),
        ),
        {
          onNone: () => undefined,
          onSome: destination => this.written(destination, cwd),
        },
      )
      return
    }
    const values = writers.get(name)
    if (values !== undefined) {
      for (const target of operands(args, values)) this.written(target, cwd)
      return
    }
    if (modeWriters.has(name)) {
      const all = operands(args, new Set(['--reference']))
      const changed = args.some(({ text }) => text.startsWith('--reference'))
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
    if (name === 'sed' && hasOption(args, '-i', '--in-place')) {
      const scripted = hasOption(args, '-e', '-f', '--expression', '--file')
      const all = operands(
        args,
        new Set(['-e', '-f', '--expression', '--file']),
      )
      for (const file of scripted ? all : all.slice(1)) this.written(file, cwd)
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
          (setting.dynamic ||
            /^(?:alias\.|core\.(?:hookspath|sshcommand|fsmonitor)=)/iu.test(
              setting.text,
            ))
        )
          this.ask(`git -c ${setting.text} changes what git runs`)
      } else if (
        text === '--git-dir' ||
        text === '--work-tree' ||
        text.startsWith('--git-dir=') ||
        text.startsWith('--work-tree=')
      ) {
        this.ask(`git ${text} points git at another repository or worktree`)
        if (!text.includes('=')) index++
      } else if (
        text === '--namespace' ||
        text === '--config-env' ||
        text === '--super-prefix'
      )
        index++
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
        const reading = hasOption(
          subArgs,
          '--get',
          '--get-all',
          '--get-regexp',
          '-l',
          '--list',
        )
        if (!reading && hasOption(subArgs, '--global', '--system'))
          this.ask('git config writes git’s settings outside the worktree')
        const file = optionValue(subArgs, '-f', '--file')
        if (!reading && Option.isSome(file)) this.written(file.value, folder)
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
  'init',
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
  const policy = new Policy(context)
  policy.script(source, [Option.some(context.worktree)], 0)
  return policy.findings
}
