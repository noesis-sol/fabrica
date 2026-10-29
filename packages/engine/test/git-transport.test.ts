import { Duration, Effect, Layer } from 'effect'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from '@effect/vitest'

import {
  CloneOutcome,
  Git,
  type GitConfig,
  layer as gitLayer,
} from '../src/git'
import {
  type RunnerConfig,
  commandEnvironment,
  hostHolders,
  hostPriority,
  layerClock,
  listProcesses,
  layer as runnerLayer,
} from '../src/process'

// Git's network commands get the host's own transport (spec §10.1, §10.3, §11.7): its ssh-agent, its
// own ssh command, curl's proxies and the CA certificates, and nothing that would ask. A clone of an
// SSH URL runs the host's `GIT_SSH_COMMAND` as it is; a clone of an HTTPS URL goes through the host's
// proxy, a local server here that writes down the request it was sent.

const transport = {
  SSH_AUTH_SOCK: '/agent/ssh.sock',
  GIT_SSH_COMMAND: 'own-ssh --own-flag',
  GIT_SSH_VARIANT: 'ssh',
  http_proxy: 'http://proxy.invalid:3128',
  https_proxy: 'http://proxy.invalid:3128',
  HTTPS_PROXY: 'http://proxy.invalid:3128',
  all_proxy: 'socks5://proxy.invalid:1080',
  ALL_PROXY: 'socks5://proxy.invalid:1080',
  no_proxy: 'localhost',
  NO_PROXY: 'localhost',
  GIT_SSL_CAINFO: '/certs/ca.pem',
  GIT_SSL_CAPATH: '/certs',
  SSL_CERT_FILE: '/certs/ca.pem',
  SSL_CERT_DIR: '/certs',
}

/** What would ask, or what git ranks under the engine's batch-mode ssh: never passed. */
const asking = {
  SSH_ASKPASS: '/usr/bin/ssh-askpass',
  SSH_ASKPASS_REQUIRE: 'force',
  GIT_ASKPASS: '/usr/bin/git-askpass',
  DISPLAY: ':0',
  GIT_SSH: '/usr/bin/plink',
  HTTP_PROXY: 'http://proxy.invalid:3128',
}

describe('commandEnvironment', () => {
  const host = { PATH: '/usr/bin', ...transport, ...asking }

  it('gives the host’s transport to a network command alone', () => {
    expect(commandEnvironment({ host, extra: {} })).toEqual({
      PATH: '/usr/bin',
    })
    expect(commandEnvironment({ host, extra: {}, network: true })).toEqual({
      PATH: '/usr/bin',
      ...transport,
    })
  })

  it('gives the host’s kind of ssh only with its own ssh command', () => {
    const { GIT_SSH_COMMAND: _command, ...withoutCommand } = transport
    expect(
      commandEnvironment({
        host: { ...withoutCommand, GIT_SSH: '/usr/bin/plink' },
        extra: {},
        network: true,
      }),
    ).not.toHaveProperty('GIT_SSH_VARIANT')
  })
})

let root = ''
let home = ''
let stubs = ''
let gitFolder = ''

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fabrica-git-transport-')))
  home = join(root, 'home')
  stubs = join(root, 'stubs')
  mkdirSync(home)
  mkdirSync(stubs)
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Fabrica Test\n\temail = test@fabrica.invalid\n',
  )
  // ssh as git runs it, and the host's own: each writes its name, the agent's socket it saw and its
  // arguments, then refuses.
  for (const name of ['ssh', 'own-ssh']) {
    writeFileSync(
      join(stubs, name),
      `#!/bin/sh\necho "by=${name}" > "$HOME/ssh-saw"\necho "agent=\${SSH_AUTH_SOCK-none}" >> "$HOME/ssh-saw"\necho "args=$*" >> "$HOME/ssh-saw"\necho "stub ssh refused" >&2\nexit 255\n`,
    )
    chmodSync(join(stubs, name), 0o755)
  }
  gitFolder = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
})

/** The runner's host facts, with `environment` over its own. */
const runnerConfig = (
  environment: Readonly<Record<string, string>>,
): RunnerConfig => ({
  hostEnvironment: {
    PATH: `${stubs}:${gitFolder}:/usr/bin:/bin`,
    HOME: home,
    LANG: 'C',
    ...environment,
  },
  enginePriority: 0,
  priority: hostPriority,
  listProcesses,
  pipeHolders: hostHolders({ platform: process.platform, self: process.pid }),
  self: process.pid,
  killGrace: Duration.seconds(2),
  outputGrace: Duration.millis(200),
})

const config: GitConfig = {
  timeLimit: Duration.minutes(1),
  readRetries: { times: 0, spacing: Duration.zero },
}

/** Git over a runner whose host has `environment`. */
const git = (environment: Readonly<Record<string, string>>) =>
  Layer.provide(
    gitLayer(config),
    Layer.provide(runnerLayer(runnerConfig(environment)), layerClock),
  )

/** A local server, as a proxy: the requests' first lines, and the port it listens on. */
interface Proxy {
  readonly server: Server
  readonly requests: ReadonlyArray<string>
  readonly port: number
}

/** A proxy on a free local port that writes down the first line of each request, then hangs up. */
const proxy = Effect.acquireRelease(
  Effect.callback<Proxy>(resume => {
    const requests: Array<string> = []
    const server = createServer(socket => {
      socket.once('data', data => {
        requests.push(data.toString('latin1').split('\r\n')[0] ?? '')
        socket.destroy()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        address !== null && typeof address === 'object' ? address.port : 0
      resume(Effect.succeed({ server, requests, port }))
    })
  }),
  ({ server }) =>
    Effect.callback<void>(resume => {
      server.close(() => resume(Effect.void))
    }),
)

describe('Git.clone', () => {
  it.live('runs the host’s own GIT_SSH_COMMAND as it is, with the agent', () =>
    Effect.gen(function* () {
      const outcome = yield* (yield* Git).clone({
        url: 'ssh://git@git.invalid/repo.git',
        into: join(root, 'cloned-ssh'),
      })
      expect(outcome).toEqual(
        CloneOutcome.Refused({
          message: expect.stringContaining('stub ssh refused'),
        }),
      )
      const saw = readFileSync(join(home, 'ssh-saw'), 'utf8')
      expect(saw).toContain(`agent=${transport.SSH_AUTH_SOCK}\n`)
      expect(saw).toMatch(/^args=--own-flag .*git@git\.invalid/m)
      expect(saw).not.toContain('BatchMode')
    }).pipe(
      Effect.provide(
        git({
          SSH_AUTH_SOCK: transport.SSH_AUTH_SOCK,
          GIT_SSH_COMMAND: transport.GIT_SSH_COMMAND,
        }),
      ),
    ),
  )

  it.live(
    'runs the engine’s batch-mode ssh as OpenSSH, whatever kind the host’s GIT_SSH is',
    () =>
      Effect.gen(function* () {
        yield* (yield* Git).clone({
          url: 'ssh://git@git.invalid:2222/repo.git',
          into: join(root, 'cloned-variant'),
        })
        const saw = readFileSync(join(home, 'ssh-saw'), 'utf8')
        expect(saw).toContain('by=ssh\n')
        expect(saw).toMatch(
          /^args=.*-o BatchMode=yes.* -p 2222 .*git@git\.invalid/m,
        )
      }).pipe(
        Effect.provide(git({ GIT_SSH: 'plink', GIT_SSH_VARIANT: 'plink' })),
      ),
  )

  it.live('runs the host’s own GIT_SSH_COMMAND as the kind it names', () =>
    Effect.gen(function* () {
      yield* (yield* Git).clone({
        url: 'ssh://git@git.invalid:2222/repo.git',
        into: join(root, 'cloned-own-variant'),
      })
      const saw = readFileSync(join(home, 'ssh-saw'), 'utf8')
      expect(saw).toContain('by=own-ssh\n')
      expect(saw).toMatch(/^args=--own-flag .*-P 2222 .*git@git\.invalid/m)
    }).pipe(
      Effect.provide(
        git({
          GIT_SSH_COMMAND: transport.GIT_SSH_COMMAND,
          GIT_SSH_VARIANT: 'plink',
        }),
      ),
    ),
  )

  it.live('reaches an HTTPS remote through the host’s proxy', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port, requests } = yield* proxy
        const outcome = yield* Effect.provide(
          Effect.flatMap(Git, service =>
            service.clone({
              url: 'https://git.invalid/repo.git',
              into: join(root, 'cloned-https'),
            }),
          ),
          git({ https_proxy: `http://127.0.0.1:${port}` }),
        )
        expect(outcome._tag).toBe('Refused')
        expect(requests).toEqual(['CONNECT git.invalid:443 HTTP/1.1'])
      }),
    ),
  )
})
