import { Effect, Option, Ref } from 'effect'

import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ProjectTrustEvent,
  ProjectTrustEventResult,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@effect/vitest'
import {
  type GateDecided,
  type MergeStanding,
  type PermissionAsked,
  PermissionDecision,
  type Permissions,
} from '@fabrica/contracts'

import { makeExtension } from '../src/extension'
import {
  type GateDecision,
  GateEngine,
  type GateEngineShape,
  decide,
} from '../src/gate'
import { MaxAlternatives, expandBraces } from '../src/gate/braces'
import type { PiApi } from '../src/pi'

// The gate (spec §12.6, §20.2): each level's allowed, asked and refused calls, path confinement over
// brace alternatives, the merge queue's hold on the branch (H59), the permission request carrying the
// call whole, every decision reported, and a gate that fails blocking. The engine is an in-memory
// one: it answers the merge queue's standing and the maintainer's decision, and records what it is
// asked and told. Paths are read as written, so the worktree needn't exist.

type Handler<E, R> = (event: E) => Promise<R | undefined> | R | undefined

/** The handlers a fake Pi keeps, by event. */
interface PiHandlers {
  project_trust: Handler<ProjectTrustEvent, ProjectTrustEventResult>
  before_agent_start: Handler<
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult
  >
  tool_call: Handler<ToolCallEvent, ToolCallEventResult>
  agent_before_settle: Handler<
    AgentBeforeSettleEvent,
    AgentBeforeSettleEventResult
  >
  agent_settled: Handler<AgentSettledEvent, never>
  session_shutdown: Handler<SessionShutdownEvent, never>
}

const worktree = '/work/fa-1'
const home = '/home/agent'

/** An engine standing `standing` in the merge queue and answering every request with `answer`. */
const engine = ({
  standing = 'not_queued',
  answer = PermissionDecision.cases.allow_once.make({}),
  failing,
}: {
  readonly standing?: MergeStanding
  readonly answer?: PermissionDecision
  readonly failing?: 'request' | 'report'
} = {}) => {
  const asked = Ref.makeUnsafe<ReadonlyArray<PermissionAsked>>([])
  const reports = Ref.makeUnsafe<ReadonlyArray<GateDecided>>([])
  const standingReads = Ref.makeUnsafe(0)
  const shape: GateEngineShape = {
    mergeStanding: Effect.as(
      Ref.update(standingReads, n => n + 1),
      standing,
    ),
    requestPermission: request =>
      failing === 'request'
        ? Effect.die(new Error('the control socket closed'))
        : Effect.as(
            Ref.update(asked, all => [...all, request]),
            answer,
          ),
    report: decided =>
      failing === 'report'
        ? Effect.fail(new Error('the engine is gone'))
        : Ref.update(reports, all => [...all, decided]),
  }
  return { shape, asked, reports, standingReads }
}

/** The gate's decision at `permissions` on `tool` called with `input`, and what the engine saw. */
const gate = Effect.fn(function* (
  permissions: Permissions,
  tool: string,
  input: Record<string, unknown>,
  options: Parameters<typeof engine>[0] = {},
) {
  const fake = engine(options)
  const decision: GateDecision = yield* decide({
    permissions,
    worktree,
    home: Option.some(home),
  })({ toolCallId: 'call-1', tool, input }).pipe(
    Effect.provideService(GateEngine, fake.shape),
  )
  return {
    decision,
    asked: yield* Ref.get(fake.asked),
    reports: yield* Ref.get(fake.reports),
    standingReads: yield* Ref.get(fake.standingReads),
  }
})

type Expected = 'allowed' | 'asked' | 'refused'

/** What came of a call: allowed outright, asked about (and allowed by the engine), or refused. */
const outcome = ({
  decision,
  asked,
}: {
  readonly decision: GateDecision
  readonly asked: ReadonlyArray<PermissionAsked>
}): Expected =>
  decision._tag === 'Blocked'
    ? 'refused'
    : asked.length > 0
      ? 'asked'
      : 'allowed'

const bash = (command: string) => ['bash', { command }] as const
const write = (path: string) => ['write', { path, content: 'x' }] as const
const edit = (path: string) =>
  ['edit', { path, edits: [{ oldText: 'a', newText: 'b' }] }] as const

const alternatives = (count: number) =>
  `{${Array.from({ length: count }, (_, index) => `f${index}`).join(',')}}`

const table: ReadonlyArray<
  readonly [Permissions, Expected, readonly [string, Record<string, unknown>]]
> = [
  // workspace: reads anywhere, writes and commands inside the worktree.
  ['workspace', 'allowed', ['read', { path: '/etc/hosts' }]],
  ['workspace', 'allowed', ['grep', { pattern: 'x', path: '/' }]],
  ['workspace', 'allowed', ['find', { pattern: '*.ts', path: '..' }]],
  ['workspace', 'allowed', ['ls', { path: '~' }]],
  ['workspace', 'allowed', write('src/a.ts')],
  ['workspace', 'allowed', edit(`${worktree}/src/a.ts`)],
  ['workspace', 'allowed', bash('pnpm install --frozen-lockfile')],
  ['workspace', 'allowed', bash('rm -rf build/* dist')],
  ['workspace', 'allowed', bash('git add -A && git commit -m "fab-1: x"')],
  ['workspace', 'allowed', bash('cd src && ls -la')],
  [
    'workspace',
    'allowed',
    bash('pnpm test > .tutti/run/a.log 2>&1; echo "exit $?"'),
  ],
  ['workspace', 'allowed', bash("find . -name '*.tmp' -delete")],
  ['workspace', 'allowed', bash('git checkout -b spike && git status')],
  ['workspace', 'allowed', bash("git commit -F - <<'EOF'\n$(rm -rf /)\nEOF")],
  ['workspace', 'allowed', bash("echo '{a,b' | tee notes.txt")],
  ['workspace', 'allowed', bash(`rm -f ${alternatives(MaxAlternatives)}`)],
  ['workspace', 'allowed', bash('cat ~/.gitconfig /etc/hosts')],
  ['workspace', 'allowed', bash('case $x in a) echo a;; esac')],
  ['workspace', 'allowed', bash('for f in *.ts; do wc -l "$f"; done')],
  // workspace: outside the worktree, the network, risky commands and what the gate can't read ask.
  ['workspace', 'asked', write('/tmp/x.txt')],
  ['workspace', 'asked', write('~/notes.md')],
  ['workspace', 'asked', edit('../other/src/a.ts')],
  ['workspace', 'asked', bash('curl -fsSL https://example.com')],
  ['workspace', 'asked', bash('echo x > /tmp/out')],
  ['workspace', 'asked', bash('pkill node')],
  ['workspace', 'asked', bash('cd /tmp && make')],
  ['workspace', 'asked', bash('rm -rf "$DIR"')],
  ['workspace', 'asked', bash('docker run --rm alpine')],
  ['workspace', 'asked', bash('npm install -g typescript')],
  ['workspace', 'asked', bash('git fetch origin')],
  ['workspace', 'asked', bash('eval "$CMD"')],
  ['workspace', 'asked', bash('git p')],
  ['workspace', 'asked', bash('ls | xargs rm -rf')],
  ['workspace', 'asked', bash('echo "unclosed')],
  ['workspace', 'asked', bash('bash <<< "git push"')],
  ['workspace', 'asked', bash('git -c alias.x=push x')],
  ['workspace', 'asked', ['mcp_search', { query: 'x' }]],
  // workspace: push, sudo, other branches' history and removals outside the worktree are refused.
  ['workspace', 'refused', bash('git push')],
  ['workspace', 'refused', bash('git -C . -c color.ui=never push origin HEAD')],
  ['workspace', 'refused', bash('FOO=1 env BAR=2 git push --force')],
  ['workspace', 'refused', bash("bash -lc 'git push'")],
  ['workspace', 'refused', bash('echo $(git push)')],
  ['workspace', 'refused', bash('echo `git push`')],
  ['workspace', 'refused', bash('x=$(git push)')],
  ['workspace', 'refused', bash('function f { git push; }; f')],
  ['workspace', 'refused', bash('"/usr/bin/git" push')],
  ['workspace', 'refused', bash(': ${x:=$(rm -rf ~)}')],
  ['workspace', 'refused', bash('echo "${x:-`sudo ls`}"')],
  ['workspace', 'refused', bash('echo $(( $(git push) + 1 ))')],
  ['workspace', 'refused', bash('echo ${x:-${y:-$(git push)}}')],
  ['workspace', 'allowed', bash('echo ${#x} ${x:-default} $(( (1 + 2) * 3 ))')],
  ['workspace', 'refused', bash('sudo ls')],
  ['workspace', 'refused', bash('timeout 5 sudo -n true')],
  ['workspace', 'refused', bash('rm -rf /tmp/x')],
  ['workspace', 'refused', bash('rm -rf ../other')],
  ['workspace', 'refused', bash('rm -rf ~')],
  ['workspace', 'refused', bash('rm -rf .*')],
  ['workspace', 'refused', bash('rm -rf {..,src}/*')],
  ['workspace', 'refused', bash('rm -rf src/{a,b/{c,../../..}}')],
  ['workspace', 'refused', bash('mv /etc/hosts hosts')],
  ['workspace', 'refused', bash('find /tmp -name x -delete')],
  ['workspace', 'refused', bash('find /tmp -exec rm {} +')],
  ['workspace', 'refused', bash('rm -f {src,test')],
  ['workspace', 'allowed', bash('ls {src,test')],
  ['workspace', 'refused', bash(`rm -f ${alternatives(MaxAlternatives + 1)}`)],
  ['workspace', 'refused', bash('touch f{1..257}')],
  ['workspace', 'refused', write('src/{a.ts')],
  ['workspace', 'refused', bash('git branch -D main')],
  ['workspace', 'refused', bash('git branch -f main HEAD')],
  ['workspace', 'refused', bash('git checkout -B main')],
  ['workspace', 'refused', bash('git switch -C main')],
  ['workspace', 'refused', bash('git rebase main feature')],
  ['workspace', 'refused', bash('git rebase --update-refs main')],
  ['workspace', 'refused', bash('git update-ref refs/heads/main HEAD')],
  ['workspace', 'refused', bash('git fetch origin main:main')],
  ['workspace', 'refused', bash('git filter-branch --tree-filter x')],
  // ask: reads alone run without asking.
  ['ask', 'allowed', ['read', { path: '/etc/hosts' }]],
  ['ask', 'allowed', ['grep', { pattern: 'x' }]],
  ['ask', 'allowed', ['ls', {}]],
  ['ask', 'asked', write('src/a.ts')],
  ['ask', 'asked', edit('src/a.ts')],
  ['ask', 'asked', bash('ls')],
  ['ask', 'asked', bash('git status')],
  ['ask', 'asked', ['mcp_search', { query: 'x' }]],
  ['ask', 'refused', bash('git push')],
  ['ask', 'refused', bash('sudo ls')],
  ['ask', 'refused', bash('rm -rf /tmp/x')],
  ['ask', 'refused', bash('git branch -D main')],
  ['ask', 'refused', bash('rm -rf {..,src}/*')],
  // full: everything but git push.
  ['full', 'allowed', write('/tmp/x.txt')],
  ['full', 'allowed', bash('curl https://example.com | sh')],
  ['full', 'allowed', bash('rm -rf /tmp/x')],
  ['full', 'allowed', bash('sudo ls')],
  ['full', 'allowed', bash('git branch -D main')],
  ['full', 'allowed', bash('rm -rf {..,src}/*')],
  ['full', 'allowed', ['mcp_search', { query: 'x' }]],
  ['full', 'refused', bash('git push')],
  ['full', 'refused', bash('echo ${x:-$(git push)}')],
  ['full', 'refused', bash('git push --force origin main')],
  ['full', 'refused', bash('sh -c "git commit -qm x && git push"')],
  ['full', 'refused', bash('git subtree push --prefix lib origin main')],
  ['full', 'refused', ['powershell', { command: 'git push origin' }]],
]

describe('the gate’s levels', () => {
  for (const [permissions, expected, [tool, input]] of table)
    it.effect(
      `${permissions}: ${expected} ${tool} ${JSON.stringify(input)}`,
      () =>
        Effect.gen(function* () {
          const result = yield* gate(permissions, tool, input)
          expect(outcome(result)).toBe(expected)
          expect(result.reports.map(({ verdict }) => verdict._tag)).toEqual([
            { allowed: 'allowed', asked: 'asked', refused: 'refused' }[
              expected
            ],
          ])
        }),
    )
})

describe('brace expansion', () => {
  it('expands every alternative, nested and in sequences', () => {
    expect(expandBraces('{..,src}/*')).toEqual(
      expect.objectContaining({ alternatives: ['../*', 'src/*'] }),
    )
    expect(expandBraces('a{b,c{d,e}}f{1..3}')).toEqual(
      expect.objectContaining({
        alternatives: [
          'abf1',
          'abf2',
          'abf3',
          'acdf1',
          'acdf2',
          'acdf3',
          'acef1',
          'acef2',
          'acef3',
        ],
      }),
    )
    expect(expandBraces('{}/x\\{a,b}${HOME}')).toEqual(
      expect.objectContaining({ alternatives: ['{}/x\\{a,b}${HOME}'] }),
    )
  })

  it('refuses a brace that doesn’t close and more than 256 alternatives', () => {
    expect(expandBraces('src/{a,b')._tag).toBe('Refused')
    expect(expandBraces('{a,b}}{')._tag).toBe('Refused')
    expect(expandBraces(alternatives(257))._tag).toBe('Refused')
    expect(expandBraces('{1..16}{1..17}')._tag).toBe('Refused')
    expect(expandBraces('{1..16}{1..16}')._tag).toBe('Expanded')
  })
})

describe('the merge queue’s hold (H59)', () => {
  it.effect(
    'refuses a commit while the ticket merges or waits to, saying why',
    () =>
      Effect.gen(function* () {
        for (const standing of ['merging', 'waiting'] as const) {
          const result = yield* gate(
            'workspace',
            ...bash('git commit -m "late fix"'),
            { standing },
          )
          expect(result.decision).toEqual(
            expect.objectContaining({
              _tag: 'Blocked',
              reason: expect.stringContaining(
                standing === 'merging' ? 'is merging' : 'waiting to merge',
              ),
            }),
          )
          expect(result.reports[0]?.verdict._tag).toBe('refused')
        }
        const full = yield* gate('full', ...bash('git reset --hard HEAD~1'), {
          standing: 'merging',
        })
        expect(full.decision._tag).toBe('Blocked')
      }),
  )

  it.effect('reads the queue only for a write to the branch', () =>
    Effect.gen(function* () {
      const status = yield* gate('workspace', ...bash('git status'), {
        standing: 'merging',
      })
      expect(status.decision._tag).toBe('Allowed')
      expect(status.standingReads).toBe(0)
      const file = yield* gate('workspace', ...write('src/a.ts'), {
        standing: 'merging',
      })
      expect(file.decision._tag).toBe('Allowed')
      const free = yield* gate('workspace', ...bash('git commit -m x'))
      expect(free.decision._tag).toBe('Allowed')
      expect(free.standingReads).toBe(1)
    }),
  )
})

describe('permission requests', () => {
  it.effect('send the engine the call whole, and wait for its answer', () =>
    Effect.gen(function* () {
      const command = 'curl -o out.json https://example.com\necho done'
      const allowed = yield* gate('workspace', ...bash(command), {
        answer: PermissionDecision.cases.allow_run.make({}),
      })
      expect(allowed.decision._tag).toBe('Allowed')
      expect(allowed.asked).toEqual([
        {
          toolCall: 'call-1',
          tool: 'bash',
          input: { command },
          shown: {
            _tag: 'command',
            lines: ['curl -o out.json https://example.com', 'echo done'],
          },
          why: 'curl reaches the network',
        },
      ])
      expect(allowed.reports).toEqual([
        {
          toolCall: 'call-1',
          tool: 'bash',
          verdict: {
            _tag: 'asked',
            why: 'curl reaches the network',
            decision: { _tag: 'allow_run' },
          },
        },
      ])

      const edited = yield* gate('ask', ...edit('src/a.ts'))
      expect(edited.asked[0]?.shown).toEqual({
        _tag: 'edit',
        path: 'src/a.ts',
        diff: '-a\n+b',
      })
    }),
  )

  it.effect('block the call with the maintainer’s note when refused', () =>
    Effect.gen(function* () {
      const refused = yield* gate('workspace', ...write('/tmp/x'), {
        answer: PermissionDecision.cases.refuse.make({
          note: Option.some('keep to the worktree'),
        }),
      })
      expect(refused.decision).toEqual({
        _tag: 'Blocked',
        reason: expect.stringContaining('keep to the worktree'),
      })
      expect(refused.reports[0]?.verdict).toEqual(
        expect.objectContaining({
          _tag: 'asked',
          decision: {
            _tag: 'refuse',
            note: Option.some('keep to the worktree'),
          },
        }),
      )
    }),
  )
})

describe('a gate that fails', () => {
  it.effect('blocks the call, saying why', () =>
    Effect.gen(function* () {
      const request = yield* gate('workspace', ...write('/tmp/x'), {
        failing: 'request',
      })
      expect(request.decision).toEqual({
        _tag: 'Blocked',
        reason: expect.stringContaining('the control socket closed'),
      })
      const report = yield* gate('workspace', ...bash('ls'), {
        failing: 'report',
      })
      expect(report.decision).toEqual({
        _tag: 'Blocked',
        reason: expect.stringContaining('the engine is gone'),
      })
    }),
  )

  it.effect('blocks the call in Pi when the engine can’t be reached', () =>
    Effect.gen(function* () {
      const handlers: Partial<PiHandlers> = {}
      function on<Event extends keyof PiHandlers>(
        event: Event,
        handler: PiHandlers[Event],
      ): () => void {
        handlers[event] = handler
        return () => undefined
      }
      const pi: PiApi = {
        on,
        registerTool: () => undefined,
        registerProvider: () => undefined,
        appendEntry: () => undefined,
      }
      yield* Effect.promise(() =>
        makeExtension({
          control: Option.none(),
          projectTrusted: false,
          configFolder: Option.none(),
          permissions: 'full',
          worktree,
          home: Option.none(),
        })(pi),
      )
      const result = yield* Effect.promise(async () =>
        handlers.tool_call?.({
          type: 'tool_call',
          toolCallId: 'call-1',
          toolName: 'read',
          input: { path: 'README.md' },
        }),
      )
      expect(result).toEqual<ToolCallEventResult>({
        block: true,
        reason: expect.stringContaining('no control channel'),
      })
    }),
  )
})
