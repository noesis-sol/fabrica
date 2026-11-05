import { execFileSync } from 'node:child_process'

import { describe, expect, it } from '@effect/vitest'

import { closingInherited, detachedCommand } from '../src/engine/bridge'

// The engine outlives the app that starts it (spec §7.1), so it must keep nothing the app holds open: on
// Linux, an AppImage's mount and its runtime's keep-alive pipe, which held the app's process, and its
// image mounted, for as long as the engine ran. Real bash and /proc, so Linux's alone.

/** What a command run from a shell holding descriptor 17 open sees open, with `prefix` before it. */
const descriptorsThrough = (prefix: ReadonlyArray<string>): Array<string> =>
  execFileSync(
    'bash',
    [
      '-c',
      'exec 17</dev/null; exec "$@"',
      'bash',
      ...prefix,
      'ls',
      '/proc/self/fd',
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(line => line !== '')

describe.runIf(process.platform === 'linux')('a detached command', () => {
  it('inherits a descriptor when run directly', () => {
    expect(descriptorsThrough([])).toContain('17')
  })

  it('keeps nothing above stderr through bash', () => {
    const seen = descriptorsThrough(['bash', '-c', closingInherited, 'bash'])
    expect(seen).not.toContain('17')
    // `ls`'s own reading of the folder aside.
    expect(seen.filter(fd => Number(fd) > 3)).toEqual([])
  })
})

describe('how a detached command runs', () => {
  it('goes through bash on Linux, with its words unchanged', () => {
    const planned = detachedCommand({
      platform: 'linux',
      command: '/opt/a b/fabrica',
      args: ['serve', '--x'],
    })
    expect(planned._tag).toBe('ClosingInherited')
    expect(planned.file).toBe('bash')
    expect(planned.args.slice(-3)).toEqual(['/opt/a b/fabrica', 'serve', '--x'])
  })

  it('runs directly elsewhere', () => {
    expect(
      detachedCommand({
        platform: 'darwin',
        command: 'fabrica',
        args: ['serve'],
      }),
    ).toMatchObject({ _tag: 'Direct', file: 'fabrica', args: ['serve'] })
  })
})
