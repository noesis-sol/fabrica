import { DateTime, Option, Result, Schema } from 'effect'
import { RpcSchema } from 'effect/rpc'

import { describe, expect, it } from '@effect/vitest'

import { ProjectId, RunId, TicketId } from '../ids'
import { AttentionRequest, applyAttentionPatch } from './attention'
import { InsightsQuery, InsightsTable } from './insights'
import { FabricaRpcs, protocolGroups, protocolJsonSchema } from './protocol'
import {
  MergeQueue,
  RunView,
  RunViewPatch,
  TicketRow,
  applyRunViewPatch,
} from './run-view'
import {
  Resume,
  ResumePlan,
  StreamEpoch,
  applyKeyedPatch,
  planResume,
} from './stream'
import {
  VersionMismatch,
  negotiate,
  protocolVersion,
  supportedVersions,
} from './version'

// ---- Messages as they cross, one or more for each request's payload, answer and error ----------

const at = 1_793_268_900_000
const project = 'p-1'
const ticket = 'fa-a1b2'
const other = 'fa-c3d4'
const run = 'r-1'
const commit = 'eda8c7a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'
const model = 'anthropic/claude-opus-5-5'

const status = {
  id: 'e-1',
  release: '0.1.0',
  startedAt: at,
  host: { platform: 'linux', arch: 'x64', hostname: 'server-1', cores: 16 },
  listening: {
    address: '0.0.0.0:8443',
    fingerprint: Array.from({ length: 32 }, () => 'A0').join(':'),
  },
  projects: 2,
  runs: 1,
  liveWorkers: 3,
  machineWorkers: 8,
  clients: 2,
  stopping: false,
}

const load = {
  sampledAt: at,
  memory: { used: 8_000_000_000, total: 32_000_000_000, pressure: 'warn' },
  swapping: false,
  load1: 3.5,
  cores: 16,
  busyCores: 4,
  workers: [{ project, ticket, bytes: 900_000_000 }],
  mergeCheck: null,
}

const projectInfo = {
  id: project,
  name: 'app',
  path: '/home/m/app',
  origin: 'registered',
  url: null,
  base: 'main',
  setUp: true,
  trusted: false,
}

const projectStatus = {
  project,
  name: 'app',
  base: 'main',
  setUp: true,
  trusted: true,
  run: { _tag: 'waiting', run, overnight: true, needsYou: 2 },
  ready: 4,
}

const aTicket = {
  id: ticket,
  type: 'task',
  title: 'Add the login screen',
  description: 'The form and its errors.',
  design: null,
  acceptance: null,
  status: 'open',
  resolution: null,
  priority: 2,
  deferUntil: null,
  assignee: null,
  model: null,
  metadata: { files: ['src/login.ts'] },
  result: null,
  question: null,
  mergedCommit: null,
  closeReason: null,
  createdAt: at,
  updatedAt: at,
}

const edge = { from: other, to: ticket, kind: 'blocks' }

const question = {
  _tag: 'question',
  project,
  ticket: 'fa-q1',
  title: 'Which session store?',
  description: null,
  choices: {
    options: [
      { label: 'SQLite', tradeOff: 'One file, no server.' },
      { label: 'Redis', tradeOff: 'Shared across hosts, one more service.' },
    ],
    recommended: 0,
  },
  consequential: false,
  maintainerOnly: false,
  blocks: [ticket],
  askedFrom: ticket,
  openedAt: at,
}

const permission = {
  _tag: 'permission',
  project,
  id: 'perm-1',
  ticket,
  session: 's-1',
  tool: 'bash',
  input: { command: 'rm -rf build\nmake' },
  shown: { _tag: 'command', lines: ['rm -rf build', 'make'] },
  why: 'outside the workspace',
  openedAt: at,
}

const attention = [
  question,
  permission,
  {
    _tag: 'task',
    project,
    ticket: 'fa-t1',
    title: 'Make the key',
    openedAt: at,
  },
  {
    _tag: 'review',
    project,
    ticket: other,
    title: 'Refresh tokens',
    reason: 'CHECKS_FAILED',
    openedAt: at,
  },
]

const header = {
  run,
  project,
  engine: 'e-1',
  mode: { _tag: 'tickets' },
  state: 'running',
  startedAt: at,
  offline: false,
  autoAnswer: false,
}

const row = {
  ticket,
  title: 'Add the login screen',
  type: 'task',
  priority: 2,
  phase: { _tag: 'merging', step: 'check' },
  since: at,
  startedAt: at,
  solo: false,
  handBacks: { resolve: 0, fix: 1 },
}

const worker = {
  ticket,
  session: 's-1',
  model,
  startedAt: at,
  action: { tool: 'bash', argument: 'scripts/check-own.sh', at },
  context: { used: 14_000, window: 200_000 },
  steered: false,
}

const view = {
  header,
  totals: {
    live: 1,
    slots: 4,
    counts: {
      in_queue: 3,
      working: 1,
      waiting_to_merge: 0,
      needs_you: 2,
      set_aside: 1,
      carried_over: 0,
      done: 5,
    },
    tokens: { input: 10, output: 20, cache_write: 30, cache_read: 40 },
    costUsd: 1.25,
  },
  tickets: [
    row,
    {
      ...row,
      ticket: other,
      phase: {
        _tag: 'held_back',
        reason: 'overlap',
        detail: 'touches src/a.ts, like running fa-a1b2',
      },
      startedAt: null,
      handBacks: { resolve: 0, fix: 0 },
    },
  ],
  workers: [worker],
  queue: { merging: ticket, train: null, waiting: [] },
  holds: [
    {
      kind: 'USAGE_LIMIT',
      reason: 'anthropic’s session limit',
      since: at,
      lifts: at + 3_600_000,
      provider: 'anthropic',
    },
  ],
  banners: [
    {
      tone: 'hold',
      text: 'HOLD: USAGE_LIMIT until 15:00',
      lifts: at + 3_600_000,
    },
  ],
  attention,
  load,
  steps: [{ step: 'merge_check', ticket, startedAt: at }],
}

const event = {
  v: 1,
  time: '2026-10-29T10:15:00.000+02:00',
  run,
  kind: 'info',
  text: 'Dispatching fa-a1b2',
}

const transcript = [
  { _tag: 'message', id: 'm-1', role: 'assistant', text: '', at },
  { _tag: 'text', message: 'm-1', delta: 'Running the checks.' },
  { _tag: 'thinking', message: 'm-1', delta: 'The tests first.' },
  {
    _tag: 'tool_call',
    id: 'call-1',
    tool: 'bash',
    input: { command: 'make' },
    at,
  },
  { _tag: 'tool_output', id: 'call-1', chunk: 'ok\n' },
  { _tag: 'tool_end', id: 'call-1', ok: true, at },
  {
    _tag: 'turn_end',
    at,
    tokens: { input: 1, output: 2, cache_write: 3, cache_read: 4 },
  },
]

const snapshot = (value: unknown) => ({
  _tag: 'snapshot',
  epoch: 'ep-1',
  seq: 0,
  value,
})
const patch = (value: unknown) => ({ _tag: 'patch', seq: 1, value })

const notFound = { _tag: 'ProjectNotFound', project }
const noTicket = { _tag: 'TicketNotFound', project, ticket }
const refused = { _tag: 'Refused', reason: 'fa-a1b2 has open children' }
const noRun = { _tag: 'NoRun', project }
const noWorker = { _tag: 'WorkerNotFound', project, ticket }
const noTalk = { _tag: 'TalkNotFound', talk: 't-1' }

interface Samples {
  readonly payload?: ReadonlyArray<unknown>
  readonly success?: ReadonlyArray<unknown>
  readonly error?: ReadonlyArray<unknown>
}

const samples: Record<string, Samples> = {
  'engine.connect': {
    payload: [
      { name: 'Fabrica app', kind: 'app', release: '0.1.0', protocol: 1 },
    ],
    success: [{ protocol: 1, engine: 'e-1', release: '0.1.0' }],
    error: [
      { _tag: 'VersionMismatch', client: 1, engine: 3, update: 'client' },
    ],
  },
  'engine.version': {
    success: [{ release: '0.1.0-rc.1', protocol: 2, supported: [2, 1] }],
  },
  'engine.status': { success: [status] },
  'engine.settings': {
    success: [
      {
        keep_awake: true,
        worker_nice: 10,
        auto_answer: '10m',
        credentials_wait: '6h',
        view_interval: '50ms',
        stream_flush: '50ms',
        telemetry: { retention: { raw: '90d', daily: 'forever' } },
      },
    ],
  },
  'engine.stop': {},
  'engine.update': {
    payload: [{}, { to: '0.2.0' }],
    success: [{ from: '0.1.0', to: '0.2.0' }],
    error: [{ _tag: 'UpdateFailed', reason: 'the signature did not verify' }],
  },
  'engine.watchStatus': {
    payload: [{}, { resume: { epoch: 'ep-1', after: 41 } }],
    success: [snapshot(status), patch(status)],
  },
  'engine.watchLoad': { payload: [{}], success: [snapshot(load), patch(load)] },
  'tokens.create': {
    payload: [{ name: 'laptop' }],
    success: [{ name: 'laptop', token: 'fab_8f2c1e' }],
    error: [{ _tag: 'TokenExists', name: 'laptop' }],
  },
  'tokens.list': {
    success: [[{ name: 'laptop', createdAt: at, lastUsedAt: null }]],
  },
  'tokens.revoke': {
    payload: [{ name: 'laptop' }],
    error: [{ _tag: 'TokenNotFound', name: 'laptop' }],
  },
  'credentials.set': {
    payload: [
      { name: 'anthropic', value: { _tag: 'key', key: 'sk-ant-1' } },
      {
        name: 'openai',
        value: { _tag: 'command', command: 'op read op://dev/openai/key' },
        provider: 'openai',
      },
    ],
  },
  'credentials.list': {
    success: [[{ name: 'anthropic', kind: 'oauth', provider: 'anthropic' }]],
  },
  'credentials.remove': {
    payload: [{ name: 'anthropic' }],
    error: [{ _tag: 'CredentialNotFound', name: 'anthropic' }],
  },
  'credentials.login': {
    payload: [{ provider: 'anthropic' }],
    success: [
      { _tag: 'open_url', url: 'https://claude.ai/oauth', instructions: null },
      {
        _tag: 'device_code',
        url: 'https://github.com/login/device',
        code: 'ABCD-1234',
      },
      { _tag: 'waiting', text: 'Waiting for the browser' },
      { _tag: 'signed_in', account: 'm@example.com' },
    ],
    error: [
      {
        _tag: 'LoginFailed',
        provider: 'anthropic',
        reason: 'the code expired',
      },
    ],
  },
  'projects.add': {
    payload: [
      { source: { _tag: 'path', path: '/home/m/app' } },
      {
        source: { _tag: 'url', url: 'https://github.com/x/app.git' },
        name: 'app',
      },
    ],
    success: [
      projectInfo,
      { ...projectInfo, origin: 'cloned', url: 'https://github.com/x/app.git' },
    ],
    error: [{ _tag: 'AddFailed', reason: '/home/m/app is not a git checkout' }],
  },
  'projects.folders': {
    payload: [{}, { path: '/home/m/src' }],
    success: [
      {
        path: '/home/m/src',
        parent: '/home/m',
        checkout: false,
        folders: [
          { name: 'app', path: '/home/m/src/app', checkout: true },
          { name: 'notes', path: '/home/m/src/notes', checkout: false },
        ],
      },
      { path: '/', parent: null, checkout: false, folders: [] },
    ],
    error: [
      {
        _tag: 'FolderUnreadable',
        path: '/home/m/gone',
        reason: 'there is no folder at /home/m/gone',
      },
    ],
  },
  'projects.list': { success: [[projectInfo]] },
  'projects.remove': { payload: [{ project }], error: [notFound] },
  'projects.trust': {
    payload: [
      { project, trusted: true },
      { project, trusted: false },
    ],
    error: [notFound],
  },
  'projects.settings.get': {
    payload: [{ project }],
    success: [{ concurrent: 3, check_fast: 'scripts/check-fast.sh' }],
    error: [notFound],
  },
  'projects.settings.set': {
    payload: [{ project, settings: { concurrent: 3, permissions: 'ask' } }],
    error: [
      notFound,
      {
        _tag: 'InvalidSettings',
        problems: ['concurrent: expected at least 1'],
      },
    ],
  },
  'projects.init': {
    payload: [{ project }],
    success: [{ written: ['.fabrica/settings.json', '.fabrica/rules.md'] }],
    error: [notFound, { _tag: 'InitFailed', reason: 'disk full', written: [] }],
  },
  'projects.watchStatus': {
    payload: [{}],
    success: [
      snapshot([projectStatus]),
      patch({ upsert: [projectStatus], remove: ['p-2'] }),
    ],
  },
  'tickets.list': {
    payload: [
      { project, filter: {} },
      {
        project,
        filter: {
          status: ['open', 'in_progress'],
          type: ['bug'],
          labels: ['solo'],
          parent: other,
        },
      },
    ],
    success: [[aTicket]],
    error: [notFound],
  },
  'tickets.show': {
    payload: [{ project, ticket }],
    success: [
      {
        ticket: aTicket,
        labels: ['solo'],
        edges: [edge],
        notes: [
          {
            id: 'n-1',
            ticketId: ticket,
            author: { _tag: 'maintainer' },
            body: 'Keep it small.',
            at,
          },
        ],
      },
    ],
    error: [notFound, noTicket],
  },
  'tickets.create': {
    payload: [
      { project, ticket: { type: 'task', title: 'Add the login screen' } },
      {
        project,
        ticket: {
          type: 'bug',
          title: 'Session expires early',
          description: 'After 5 minutes.',
          priority: 1,
          labels: ['auth'],
          parent: other,
          metadata: { files: ['src/session.ts'] },
          model: model,
        },
      },
    ],
    success: [{ id: ticket }],
    error: [notFound, noTicket, refused],
  },
  'tickets.update': {
    payload: [
      {
        project,
        ticket,
        changes: { title: 'Add the sign-in screen', description: null },
      },
      {
        project,
        ticket,
        changes: { status: 'deferred', deferUntil: at, priority: 0 },
      },
    ],
    error: [refused],
  },
  'tickets.close': {
    payload: [
      { project, ticket, resolution: 'cancelled', reason: 'Not needed' },
    ],
    error: [noTicket],
  },
  'tickets.dep.add': { payload: [{ project, edge }], error: [refused] },
  'tickets.dep.remove': { payload: [{ project, edge }], error: [refused] },
  'tickets.label': {
    payload: [{ project, ticket, add: ['solo'], remove: ['auth'] }],
    error: [noTicket],
  },
  'tickets.note': {
    payload: [{ project, ticket, body: 'Tried the other store first.' }],
    success: [{ id: 'n-2' }],
    error: [noTicket],
  },
  'tickets.ready': {
    payload: [{ project }],
    success: [[aTicket]],
    error: [notFound],
  },
  'tickets.why': {
    payload: [{ project, ticket }],
    success: [
      { _tag: 'ready' },
      {
        _tag: 'not_ready',
        reasons: [
          {
            reason: { _tag: 'blocked', by: other, status: 'in_progress' },
            words: 'waits for fa-c3d4 to merge: it is in progress',
          },
          {
            reason: { _tag: 'closed_unmerged', by: other },
            words: 'waits for fa-c3d4 to merge: it is closed but not merged',
          },
          {
            reason: { _tag: 'filed_from_unmerged', ticket: other },
            words: 'waits for fa-c3d4, the ticket it was filed from, to merge',
          },
          {
            reason: { _tag: 'deferred', until: at },
            words: 'it is deferred',
          },
          {
            reason: { _tag: 'not_dispatched', type: 'epic' },
            words: 'it is an epic',
          },
          {
            reason: { _tag: 'set_aside', reason: 'MERGE_CONFLICT' },
            words: 'it was set aside in this run',
          },
          {
            reason: {
              _tag: 'held_back',
              reason: 'solo',
              detail: 'waits for the solo ticket fa-c3d4',
            },
            words: 'waits for the solo ticket fa-c3d4',
          },
          { reason: { _tag: 'closed' }, words: 'it is closed' },
          { reason: { _tag: 'in_progress' }, words: 'it is in progress' },
        ],
      },
    ],
    error: [noTicket],
  },
  'tickets.edges': {
    payload: [{ project }],
    success: [[], [edge, { from: ticket, to: other, kind: 'parent' }]],
    error: [notFound],
  },
  'tickets.import': {
    payload: [{ project, beads: '{"id":"bd-1","title":"x"}\n' }],
    success: [
      {
        created: 3,
        merged: 1,
        changed: [{ ticket: 'fa-a1b2', fields: ['title', 'labels'] }],
        dropped: [
          "fa-a1b2's waits-for link to fa-c3d4: the work graph has no such link",
        ],
      },
    ],
    error: [{ _tag: 'ImportFailed', problems: ['line 2: not JSON'] }],
  },
  'tickets.watch': {
    payload: [{ project }],
    success: [
      snapshot([aTicket]),
      patch({ upsert: [aTicket], remove: [other] }),
    ],
    error: [notFound],
  },
  'run.start': {
    payload: [
      {
        project,
        mode: { _tag: 'tickets' },
        flags: { offline: false, settings: {} },
      },
      {
        project,
        mode: { _tag: 'ticket', ticket },
        flags: { limit: 5, offline: true, settings: {} },
      },
      {
        project,
        mode: {
          _tag: 'spec',
          source: 'https://example.com/spec.md',
          refine: true,
        },
        flags: {
          offline: false,
          settings: { concurrent: '3', auto_answer: '10m' },
        },
      },
      {
        project,
        mode: { _tag: 'feature', text: 'Dark mode' },
        flags: { offline: false, settings: {} },
      },
      {
        project,
        mode: { _tag: 'overnight' },
        flags: { offline: false, settings: {} },
      },
      {
        project,
        mode: { _tag: 'overnight' },
        flags: {
          offline: false,
          settings: {},
          preflight: { fix: ['concurrent_low'], override: ['free_disk'] },
        },
      },
    ],
    success: [{ run }],
    error: [
      { _tag: 'RunGoing', project, run },
      {
        _tag: 'RunRefused',
        end: 'SETUP',
        problems: ['git 2.34 is older than 2.38'],
      },
    ],
  },
  'run.stop': { payload: [{ project }], error: [noRun] },
  'run.drain': { payload: [{ project }], error: [noRun] },
  'run.undrain': { payload: [{ project }], error: [noRun] },
  'run.status': {
    payload: [{ project }],
    success: [
      { _tag: 'idle', last: null },
      { _tag: 'idle', last: { run, end: 'READY_EMPTY', endedAt: at } },
      { _tag: 'going', header },
    ],
    error: [notFound],
  },
  'run.preflight': {
    payload: [
      {
        project,
        mode: { _tag: 'overnight' },
        flags: { offline: false, settings: {} },
      },
    ],
    success: [
      {
        refusals: [
          {
            check: 'concurrent_low',
            text: 'concurrent is 1',
            fix: 'set concurrent to 2',
          },
        ],
        warnings: [
          { check: 'no_ticket_limit', text: 'no ticket_limit', fix: null },
        ],
        questions: ['fa-q1'],
        ready: 4,
        waitingOnQuestions: 1,
      },
    ],
    error: [notFound],
  },
  'run.watchView': {
    payload: [{ project }],
    success: [
      snapshot(view),
      patch({}),
      patch({
        totals: view.totals,
        tickets: { upsert: [row], remove: [other] },
        workers: { upsert: [], remove: [ticket] },
        attention: {
          upsert: [question],
          remove: [
            {
              ref: { _tag: 'permission', project, id: 'perm-1' },
              by: 'cli',
              at,
            },
          ],
        },
        load: null,
      }),
    ],
    error: [noRun],
  },
  'run.watchEvents': {
    payload: [
      { project },
      { project, run, resume: { epoch: 'ep-1', after: 0 } },
    ],
    success: [snapshot([event]), patch([event, event])],
    error: [{ _tag: 'RunNotFound', project, run }],
  },
  'worker.message': {
    payload: [{ project, ticket, text: 'Use the existing session store.' }],
    error: [noWorker],
  },
  'worker.interrupt': { payload: [{ project, ticket }], error: [noWorker] },
  'worker.release': { payload: [{ project, ticket }], error: [noWorker] },
  'worker.watchTranscript': {
    payload: [{ project, ticket }],
    success: [snapshot(transcript), patch(transcript.slice(1, 3))],
    error: [noWorker],
  },
  'attention.list': {
    payload: [{}, { project }],
    success: [attention],
    error: [notFound],
  },
  'attention.answer': {
    payload: [
      {
        answer: {
          _tag: 'question',
          project,
          ticket: 'fa-q1',
          answer: { _tag: 'option', index: 0 },
        },
      },
      {
        answer: {
          _tag: 'question',
          project,
          ticket: 'fa-q1',
          answer: { _tag: 'text', text: 'Neither: files.' },
        },
      },
      {
        answer: {
          _tag: 'permission',
          project,
          id: 'perm-1',
          decision: { _tag: 'allow_once' },
        },
      },
      {
        answer: {
          _tag: 'permission',
          project,
          id: 'perm-1',
          decision: { _tag: 'allow_run' },
        },
      },
      {
        answer: {
          _tag: 'permission',
          project,
          id: 'perm-1',
          decision: { _tag: 'refuse', note: 'Not in build/' },
        },
      },
    ],
    success: [{ by: 'Fabrica app', at }],
    error: [
      { _tag: 'AlreadyAnswered', by: 'fabrica answer', at },
      {
        _tag: 'AttentionNotFound',
        ref: { _tag: 'question', project, ticket: 'fa-q1' },
      },
      { _tag: 'InvalidAnswer', reason: 'the question has 2 options' },
    ],
  },
  'attention.watch': {
    payload: [{}],
    success: [
      snapshot(attention),
      patch({
        upsert: [],
        remove: [
          { ref: { _tag: 'task', project, ticket: 'fa-t1' }, by: null, at },
        ],
      }),
    ],
    error: [notFound],
  },
  'talk.open': {
    payload: [
      { project, context: { _tag: 'run' } },
      { project, context: { _tag: 'answer', questions: [] } },
      {
        project,
        context: { _tag: 'refine', spec: 'docs/spec.md' },
        model: model,
      },
      {
        project,
        context: { _tag: 'feature', text: null },
        model: { model, thinking: 'high' },
      },
    ],
    success: [{ talk: 't-1', session: 's-2', model }],
    error: [
      notFound,
      {
        _tag: 'TalkNotOpened',
        reason: "the project's settings name no model: give the talk one",
      },
    ],
  },
  'talk.send': {
    payload: [{ talk: 't-1', text: 'Next question.' }],
    error: [noTalk],
  },
  'talk.close': { payload: [{ talk: 't-1' }], error: [noTalk] },
  'talk.watchTranscript': {
    payload: [{ talk: 't-1' }],
    success: [snapshot([]), patch(transcript)],
    error: [noTalk],
  },
  'diff.ticket': {
    payload: [{ project, ticket }],
    success: [
      {
        base: commit,
        head: commit,
        files: [
          {
            path: 'src/login.ts',
            change: 'modified',
            from: null,
            patch: '@@ -1 +1 @@\n-a\n+b\n',
          },
          {
            path: 'src/auth.ts',
            change: 'renamed',
            from: 'src/session.ts',
            patch: '',
          },
        ],
      },
    ],
    error: [{ _tag: 'NoBranch', project, ticket }],
  },
  'diff.run': {
    payload: [{ project, run }],
    success: [{ base: commit, head: commit, files: [] }],
    error: [{ _tag: 'RunNotFound', project, run }],
  },
  'report.get': {
    payload: [{ project }, { project, run }],
    success: [{ run, markdown: '# Run r-1\n', writtenAt: at }],
    error: [{ _tag: 'NoReport', project, run }],
  },
  'log.tail': {
    payload: [{ project, lines: 50 }],
    success: [{ lines: ['10:15:00 Dispatching fa-a1b2'] }],
    error: [notFound],
  },
  'insights.summary': {
    payload: [{}, { project, since: at }],
    success: [
      {
        runs: 3,
        merged: 21,
        setAside: 2,
        handBacks: { resolve: 1, fix: 4 },
        tokens: {
          [model]: { input: 1, output: 2, cache_write: 3, cache_read: 4 },
        },
        costUsd: null,
        readyToMerged: 1_260_000,
      },
    ],
    error: [notFound],
  },
  'insights.query': {
    payload: [
      { query: { _tag: 'ticket_time', project, ticket } },
      { query: { _tag: 'waits', since: at } },
      { query: { _tag: 'check_durations', project, suite: 'merge' } },
      { query: { _tag: 'flaky_tests', project } },
      { query: { _tag: 'cost_per_merged_ticket' } },
      { query: { _tag: 'tokens_by_model', by: 'run' } },
      { query: { _tag: 'hand_back_rates' } },
      { query: { _tag: 'models_compared', since: at } },
    ],
    success: [
      {
        columns: [
          { name: 'model', unit: 'text' },
          { name: 'tokens', unit: 'tokens' },
        ],
        rows: [
          [model, 1200],
          ['openai/gpt-5', null],
        ],
      },
    ],
    error: [notFound],
  },
}

/** Messages whose encoding adds the defaults the sample leaves out. */
const withDefaults = new Set([
  'projects.settings.get',
  'projects.settings.set',
  'engine.settings',
])

/** Every request's payload, answer and error schemas; a stream's item and error. */
/**
 * The protocol's schemas need no services to decode or encode: what crosses is plain data. Rpc keeps
 * them as `Schema.Top`, so this says so for the test's codecs.
 */
const needsNoServices = (
  schema: Schema.Top,
): schema is Schema.Codec<unknown, unknown> => Schema.isSchema(schema)

const message = (schema: Schema.Top): Schema.Codec<unknown, unknown> => {
  if (!needsNoServices(schema)) {
    throw new Error('not a schema')
  }
  return schema
}

const shapes = [...FabricaRpcs.requests.values()].map(rpc => {
  const success = rpc.successSchema
  return RpcSchema.isStreamSchema(success)
    ? {
        tag: rpc._tag,
        payload: message(rpc.payloadSchema),
        success: message(success.success),
        error: message(success.error),
      }
    : {
        tag: rpc._tag,
        payload: message(rpc.payloadSchema),
        success: message(success),
        error: message(rpc.errorSchema),
      }
})

const parts = ['payload', 'success', 'error'] as const

/** Decodes `json` as it would arrive, encodes it again, and decodes that. */
const roundTrip = (schema: Schema.Codec<unknown, unknown>, json: unknown) => {
  const codec = Schema.toCodecJson(schema)
  const decode = (input: unknown) =>
    Result.getOrThrow(Schema.decodeUnknownResult(codec)(input))
  const encode = (value: unknown) =>
    Result.getOrThrow(Schema.encodeUnknownResult(codec)(value))
  const encoded = encode(decode(JSON.parse(JSON.stringify(json))))
  return { encoded, again: encode(decode(encoded)) }
}

const refuses = (
  schema: Schema.Codec<unknown, unknown>,
  json: unknown,
): boolean =>
  Result.isFailure(Schema.decodeUnknownResult(Schema.toCodecJson(schema))(json))

describe('the protocol’s groups', () => {
  it('has every request in exactly one group, under its group’s name', () => {
    const tags = Object.values(protocolGroups).flatMap(group => [
      ...group.requests.keys(),
    ])
    expect(new Set(tags).size).toBe(tags.length)
    expect([...FabricaRpcs.requests.keys()].sort()).toEqual([...tags].sort())
    expect(Object.keys(protocolGroups)).toEqual([
      'engine',
      'tokens',
      'secrets',
      'projects',
      'backlog',
      'runs',
      'workers',
      'attention',
      'talks',
      'review',
      'insights',
    ])
  })

  it('has the requests §8.1 names', () => {
    const tags = new Set(FabricaRpcs.requests.keys())
    for (const tag of [
      'engine.version',
      'engine.status',
      'engine.settings',
      'engine.stop',
      'engine.update',
      'tokens.create',
      'tokens.list',
      'tokens.revoke',
      'credentials.set',
      'credentials.list',
      'credentials.remove',
      'credentials.login',
      'projects.add',
      'projects.folders',
      'projects.list',
      'projects.remove',
      'projects.trust',
      'projects.settings.get',
      'projects.settings.set',
      'projects.init',
      'tickets.list',
      'tickets.show',
      'tickets.create',
      'tickets.update',
      'tickets.close',
      'tickets.dep.add',
      'tickets.dep.remove',
      'tickets.label',
      'tickets.note',
      'tickets.ready',
      'tickets.why',
      'tickets.edges',
      'tickets.import',
      'run.start',
      'run.stop',
      'run.drain',
      'run.undrain',
      'run.status',
      'run.preflight',
      'worker.message',
      'worker.interrupt',
      'worker.release',
      'attention.list',
      'attention.answer',
      'talk.open',
      'talk.send',
      'talk.close',
      'diff.ticket',
      'diff.run',
      'report.get',
      'log.tail',
      'insights.summary',
      'insights.query',
    ]) {
      expect(tags.has(tag), tag).toBe(true)
    }
  })

  it('has a sample of every message each request sends and answers', () => {
    for (const shape of shapes) {
      const sample = samples[shape.tag]
      expect(sample, shape.tag).toBeDefined()
      for (const part of parts) {
        const none = shape[part] === Schema.Void || shape[part] === Schema.Never
        expect(sample?.[part] === undefined, `${shape.tag} ${part}`).toBe(none)
      }
    }
    expect(Object.keys(samples).sort()).toEqual(
      shapes.map(({ tag }) => tag).sort(),
    )
  })

  it.each(shapes)('$tag decodes and encodes its messages', shape => {
    for (const part of parts) {
      for (const json of samples[shape.tag]?.[part] ?? []) {
        const { encoded, again } = roundTrip(shape[part], json)
        expect(again).toEqual(encoded)
        if (!withDefaults.has(shape.tag)) {
          expect(encoded).toEqual(json)
        }
      }
    }
  })

  it('refuses messages that break their schemas', () => {
    const shape = (tag: string) => {
      const found = shapes.find(candidate => candidate.tag === tag)
      expect(found, tag).toBeDefined()
      return found ?? shapes[0]!
    }
    // No SQL from clients: a query is one of the named ones.
    expect(
      refuses(InsightsQuery, { _tag: 'sql', sql: 'select * from tickets' }),
    ).toBe(true)
    expect(
      refuses(shape('insights.query').payload, { query: 'select 1' }),
    ).toBe(true)
    // A row with a cell missing.
    expect(
      refuses(InsightsTable, {
        columns: [{ name: 'a', unit: 'count' }],
        rows: [[1, 2]],
      }),
    ).toBe(true)
    expect(
      refuses(shape('attention.answer').payload, {
        answer: {
          _tag: 'question',
          project,
          ticket: 'fa-q1',
          answer: { _tag: 'option', index: -1 },
        },
      }),
    ).toBe(true)
    expect(
      refuses(shape('run.start').payload, {
        project,
        mode: { _tag: 'ticket' },
        flags: { offline: false, settings: {} },
      }),
    ).toBe(true)
    expect(
      refuses(shape('run.start').payload, {
        project,
        mode: { _tag: 'tickets' },
        flags: { limit: 0, offline: false, settings: {} },
      }),
    ).toBe(true)
    expect(
      refuses(shape('tickets.create').payload, {
        project,
        ticket: { type: 'task', title: 'two\nlines' },
      }),
    ).toBe(true)
    expect(
      refuses(shape('run.watchView').success, patch({ tickets: [row] })),
    ).toBe(true)
    expect(
      refuses(shape('engine.watchLoad').success, {
        _tag: 'snapshot',
        seq: 0,
        value: load,
      }),
    ).toBe(true)
    expect(
      refuses(AttentionRequest, {
        ...question,
        choices: { ...question.choices, recommended: 2 },
      }),
    ).toBe(true)
  })

  it('crosses a key as text but keeps it out of logs', () => {
    const decoded = Schema.decodeUnknownSync(
      Schema.toCodecJson(
        shapes.find(({ tag }) => tag === 'credentials.set')!.payload,
      ),
    )({
      name: 'anthropic',
      value: { _tag: 'key', key: 'sk-ant-1' },
    })
    expect(JSON.stringify(decoded)).not.toContain('sk-ant-1')
    expect(String(decoded)).not.toContain('sk-ant-1')
  })
})

describe('the version handshake', () => {
  it('speaks the engine’s version and the one before', () => {
    expect(supportedVersions(1)).toEqual([1])
    expect(supportedVersions(3)).toEqual([3, 2])
    expect(negotiate({ client: 3, engine: 3 })).toEqual(Result.succeed(3))
    expect(negotiate({ client: 2, engine: 3 })).toEqual(Result.succeed(2))
    expect(
      negotiate({ client: protocolVersion, engine: protocolVersion }),
    ).toEqual(Result.succeed(protocolVersion))
  })

  it('refuses a client two versions old, telling it to update', () => {
    expect(negotiate({ client: 1, engine: 3 })).toEqual(
      Result.fail(
        new VersionMismatch({ client: 1, engine: 3, update: 'client' }),
      ),
    )
  })

  it('refuses a client newer than the engine, telling it to update the engine', () => {
    expect(negotiate({ client: 4, engine: 3 })).toEqual(
      Result.fail(
        new VersionMismatch({ client: 4, engine: 3, update: 'engine' }),
      ),
    )
  })
})

describe('resuming a stream', () => {
  const epoch = StreamEpoch.make('ep-1')
  const at = (after: number, theirs = epoch) =>
    planResume({
      resume: Option.some(new Resume({ epoch: theirs, after })),
      epoch,
      oldest: 10,
      latest: 20,
    })

  it('sends the patches after the client’s last one while the engine keeps them', () => {
    expect(at(9)).toEqual(ResumePlan.PatchesAfter({ after: 9 }))
    expect(at(15)).toEqual(ResumePlan.PatchesAfter({ after: 15 }))
    expect(at(20)).toEqual(ResumePlan.PatchesAfter({ after: 20 }))
  })

  it('sends a snapshot to a new subscriber, one too far behind, one ahead, or one of another epoch', () => {
    expect(
      planResume({ resume: Option.none(), epoch, oldest: 10, latest: 20 }),
    ).toEqual(ResumePlan.Snapshot())
    expect(at(8)).toEqual(ResumePlan.Snapshot())
    expect(at(21)).toEqual(ResumePlan.Snapshot())
    expect(at(15, StreamEpoch.make('ep-0'))).toEqual(ResumePlan.Snapshot())
  })
})

describe('patches', () => {
  const keys = {
    of: ({ id }: { readonly id: string }) => id,
    gone: (id: string) => id,
  }
  const a = { id: 'a', n: 1 }
  const b = { id: 'b', n: 1 }
  const c = { id: 'c', n: 1 }

  it('changes rows in place, adds new ones at the end and removes gone ones', () => {
    const items = [a, b, c]
    const next = applyKeyedPatch(
      items,
      {
        upsert: [
          { id: 'd', n: 1 },
          { id: 'b', n: 2 },
        ],
        remove: ['a'],
      },
      keys,
    )
    expect(next).toEqual([{ id: 'b', n: 2 }, c, { id: 'd', n: 1 }])
    expect(next[1]).toBe(c)
    expect(applyKeyedPatch(items, { upsert: [], remove: [] }, keys)).toBe(items)
  })

  it('removes a row the same patch upserts and removes', () => {
    expect(
      applyKeyedPatch(
        [a],
        { upsert: [{ id: 'd', n: 1 }], remove: ['d'] },
        keys,
      ),
    ).toEqual([a])
  })

  it('applies to a run view, every part it leaves out keeping its identity', () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(RunView))
    const decodePatch = Schema.decodeUnknownSync(
      Schema.toCodecJson(RunViewPatch),
    )
    const before = decode(view)
    const moved = decodePatch({
      tickets: {
        upsert: [{ ...row, phase: { _tag: 'merged', commit } }],
        remove: [other],
      },
      queue: { merging: null, train: null, waiting: [] },
      attention: {
        upsert: [],
        remove: [
          {
            ref: { _tag: 'question', project, ticket: 'fa-q1' },
            by: 'Fabrica app',
            at,
          },
        ],
      },
    })
    const after = applyRunViewPatch(before, moved)
    expect(after.header).toBe(before.header)
    expect(after.totals).toBe(before.totals)
    expect(after.workers).toBe(before.workers)
    expect(after.holds).toBe(before.holds)
    expect(after.load).toBe(before.load)
    expect(after.steps).toBe(before.steps)
    expect(
      after.tickets.map(({ ticket: id, phase }) => [id, phase._tag]),
    ).toEqual([[TicketId.make(ticket), 'merged']])
    expect(after.tickets[0]).toBeInstanceOf(TicketRow)
    expect(after.queue).toEqual(
      new MergeQueue({
        merging: Option.none(),
        train: Option.none(),
        waiting: [],
      }),
    )
    expect(after.attention.map(({ _tag }) => _tag)).toEqual([
      'permission',
      'task',
      'review',
    ])
    expect(applyRunViewPatch(before, decodePatch({}))).toEqual(before)
  })

  it('applies to the open requests by their keys', () => {
    const decode = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(AttentionRequest)),
    )
    const requests = decode(attention)
    const next = applyAttentionPatch(requests, {
      upsert: [],
      remove: [
        {
          ref: {
            _tag: 'review',
            project: ProjectId.make(project),
            ticket: TicketId.make(other),
          },
          by: Option.none(),
          at: DateTime.makeUnsafe(at),
        },
      ],
    })
    expect(next.map(({ _tag }) => _tag)).toEqual([
      'question',
      'permission',
      'task',
    ])
    expect(RunId.make(run)).toBe(run)
  })
})

describe('the protocol’s JSON Schema', () => {
  const document = protocolJsonSchema()

  it('matches its snapshot', () => {
    expect(document).toMatchSnapshot()
  })

  it('has every request and stream, in group order, with this protocol’s version', () => {
    expect(document.protocol).toBe(protocolVersion)
    expect(document.dialect).toBe('draft-2020-12')
    expect(document.rpcs.map(({ tag }) => tag)).toEqual(
      Object.values(protocolGroups).flatMap(group => [
        ...group.requests.keys(),
      ]),
    )
    expect(
      document.rpcs.filter(({ stream }) => stream).map(({ tag }) => tag),
    ).toEqual([
      'engine.watchStatus',
      'engine.watchLoad',
      'credentials.login',
      'projects.watchStatus',
      'tickets.watch',
      'run.watchView',
      'run.watchEvents',
      'worker.watchTranscript',
      'attention.watch',
      'talk.watchTranscript',
    ])
  })

  it('names the shared schemas once, in its definitions', () => {
    expect(Object.keys(document.definitions)).toEqual(
      expect.arrayContaining([
        'TicketEncoded',
        'TicketRowEncoded',
        'ProjectNotFoundEncoded',
      ]),
    )
  })
})
