// The scripted Pi the live `PiAgent`'s tests run (spec §24, H78): the process at the boundary, which writes
// what it saw to `STUB_LOG` for the test to read.

/**
 * A stub of `pi --mode rpc`: answers commands by `id`, writes a prompt's records (an unknown kind and
 * a record missing a field among them, a U+2028 inside a string), and behaves as `STUB_MODE` says:
 * `long` (a turn that runs until aborted), `wedged` (answers no abort, ignores SIGTERM), `slow-exit`
 * (exits a while after SIGTERM), `slow-abort` (answers an abort a while later), `silent` (answers
 * nothing), `handled` (an extension handles every prompt, so no turn runs), `exit-at-start`,
 * `with-child` (starts a child in a group of its own, as Pi's bash tool does), `dialog` (an extension asks the UI before the turn settles),
 * `model-refused` (its model call fails, and the turn settles), `model-retried` (its call fails, and Pi's retry goes through).
 */
export const PI_STUB = `import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const mode = process.env.STUB_MODE ?? 'normal'
const note = entry => appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const args = process.argv.slice(2)
const sessions = args[args.indexOf('--session-dir') + 1]
const config = process.env.PI_CODING_AGENT_DIR
note({
  event: 'start',
  args,
  cwd: process.cwd(),
  env: Object.keys(process.env).sort(),
  config,
  models: JSON.parse(readFileSync(join(config, 'models.json'), 'utf8')),
  control: {
    role: process.env.FABRICA_AGENT_ROLE,
    talkTools: process.env.FABRICA_TALK_TOOLS,
    socket: process.env.FABRICA_CONTROL_SOCKET,
    token: process.env.FABRICA_CONTROL_TOKEN,
  },
})
if (mode === 'exit-at-start') {
  process.stderr.write('no model configured\\n')
  process.exit(3)
}
if (mode === 'with-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  note({ event: 'child', child: child.pid })
}
process.on('SIGTERM', () => {
  note({ event: 'sigterm' })
  if (mode === 'wedged') return
  const exit = () => {
    note({ event: 'exit' })
    process.exit(0)
  }
  if (mode === 'slow-exit') setTimeout(exit, 300)
  else exit()
})
let sessionId = 's-' + process.pid
let sessionFile = join(sessions, sessionId + '.jsonl')
let turn = false
const out = record => process.stdout.write(JSON.stringify(record) + '\\n')
const respond = (id, command, data) =>
  out({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } }
const settle = aborted => {
  turn = false
  out({ type: 'agent_end', messages: [], willRetry: false })
  out({ type: 'agent_settled', aborted })
}
const handle = command => {
  note({ event: 'command', type: command.type, command })
  if (mode === 'silent') return
  switch (command.type) {
    case 'get_state':
      return respond(command.id, 'get_state', { sessionId, sessionFile, isStreaming: turn, messageCount: 0 })
    case 'prompt':
      if (mode === 'handled') return respond(command.id, 'prompt', { disposition: 'handled' })
      respond(command.id, 'prompt', { disposition: 'started' })
      turn = true
      out({ type: 'agent_start' })
      if (mode === 'long') return
      if (mode === 'model-refused' || mode === 'model-retried') {
        out({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'no credential is kept under anthropic' } })
        if (mode === 'model-retried') out({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
        return settle(false)
      }
      out({ type: 'mystery_kind', detail: 1 })
      out({ type: 'mystery_kind', detail: 2 })
      out({ type: 'tool_execution_start', toolCallId: 't1' })
      out({ type: 'message_start', message: { role: 'assistant' } })
      out({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', delta: 'one\\u2028two' } })
      out({ type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-x', usage, content: 'one\\u2028two' } })
      if (mode === 'dialog') {
        out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Sure?', message: 'Go on?' })
        out({ type: 'extension_ui_request', id: 'ui-2', method: 'notify', message: 'fyi' })
        return
      }
      return settle(false)
    case 'steer':
      return respond(command.id, 'steer', { disposition: 'queued' })
    case 'abort': {
      if (mode === 'wedged') return
      const answer = () => {
        respond(command.id, 'abort')
        if (turn) settle(true)
      }
      if (mode === 'slow-abort') setTimeout(answer, 500)
      else answer()
      return
    }
    case 'set_model':
      return respond(command.id, 'set_model', { provider: command.provider, id: command.modelId })
    case 'switch_session':
      sessionFile = command.sessionPath
      return respond(command.id, 'switch_session', { cancelled: false })
    case 'fork':
      return respond(command.id, 'fork', { text: 'forked at ' + command.entryId, cancelled: false })
    case 'get_session_stats':
      return respond(command.id, 'get_session_stats', {
        sessionId, sessionFile, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.01,
      })
    case 'extension_ui_response':
      note({ event: 'ui-response', id: command.id, cancelled: command.cancelled === true })
      if (command.id === 'ui-1') settle(false)
      return
    default:
      return out({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command' })
  }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let index = buffer.indexOf('\\n'); index !== -1; index = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  note({ event: 'stdin-end' })
  if (mode !== 'wedged') process.exit(0)
})
`
