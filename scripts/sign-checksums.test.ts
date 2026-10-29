import { Effect, Result } from 'effect'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from '@effect/vitest'

import { tempFolder } from '../packages/testkit/src/index.ts'
import {
  INSTALL_SCRIPT,
  releaseKey,
  releaseKeysOf,
  signFile,
  signRelease,
} from './sign-checksums'

// The release's signature over checksums.txt (spec §20.4, orchestra's checksums.txt.sig scheme): the raw
// 64-byte ed25519 signature, made only with a key whose public half the install script holds.

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

const key = pair()
const data = new TextEncoder().encode('abc  fabrica-0.1.0-linux-x64.tar.gz\n')

const failure = <A>(result: Result.Result<A, string>): string =>
  Result.match(result, { onFailure: why => why, onSuccess: () => '' })

describe('the release keys', () => {
  it("are the PEM public keys in the install script's release_keys", () => {
    const other = pair()
    const script = `#!/bin/sh\n# a comment naming -----BEGIN PUBLIC KEY-----\nrelease_keys='${key.publicPem.trim()}\n${other.publicPem.trim()}'\nx=1\n`
    expect(releaseKeysOf(script)).toEqual([
      key.publicPem.trim(),
      other.publicPem.trim(),
    ])
    expect(releaseKeysOf("release_keys=''\n")).toEqual([])
    expect(releaseKeysOf('#!/bin/sh\n')).toEqual([])
  })

  it('in scripts/install.sh are each an ed25519 public key', () => {
    const script = readFileSync(
      join(import.meta.dirname, '..', INSTALL_SCRIPT),
      'utf8',
    )
    expect(script).toMatch(/^release_keys='[^']*'$/m)
    for (const pem of releaseKeysOf(script))
      expect(createPublicKey(pem).asymmetricKeyType).toBe('ed25519')
  })
})

describe('the private key', () => {
  it('is refused where it is missing, not PEM, or not ed25519', () => {
    expect(failure(releaseKey(undefined))).toContain(
      '$FABRICA_RELEASE_KEY is empty',
    )
    expect(failure(releaseKey(' \n'))).toContain('is empty')
    expect(failure(releaseKey(key.publicPem))).toContain(
      'is not a PKCS#8 PEM private key',
    )
    expect(
      failure(
        releaseKey(
          '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
        ),
      ),
    ).toContain("doesn't parse")
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString()
    expect(failure(releaseKey(rsa))).toBe(
      '$FABRICA_RELEASE_KEY is a rsa key, not an ed25519 key',
    )
  })
})

describe('signing', () => {
  const privateKey = Result.getOrThrow(releaseKey(key.privatePem))

  it('makes the raw 64-byte signature, with a release key', () => {
    const signature = Result.getOrThrow(
      signRelease({
        data,
        key: privateKey,
        releaseKeys: [pair().publicPem, key.publicPem],
      }),
    )
    expect(signature.length).toBe(64)
    expect(verify(null, data, createPublicKey(key.publicPem), signature)).toBe(
      true,
    )
  })

  it('refuses a key the install script would refuse the release for', () => {
    expect(
      failure(signRelease({ data, key: privateKey, releaseKeys: [] })),
    ).toBe(
      'scripts/install.sh holds no release key yet: add the public half of $FABRICA_RELEASE_KEY to its release_keys first',
    )
    expect(
      failure(
        signRelease({ data, key: privateKey, releaseKeys: [pair().publicPem] }),
      ),
    ).toContain("$FABRICA_RELEASE_KEY's public half is not among")
  })

  it.effect('writes checksums.txt.sig beside checksums.txt', () =>
    Effect.gen(function* () {
      const folder = yield* tempFolder('sign')
      const file = join(folder, 'checksums.txt')
      yield* Effect.promise(() => writeFile(file, data))
      expect(
        signFile({ file, pem: key.privatePem, releaseKeys: [key.publicPem] }),
      ).toEqual(Result.succeed(`${file}.sig`))
      const signature = yield* Effect.promise(() => readFile(`${file}.sig`))
      expect(
        verify(null, data, createPublicKey(key.publicPem), signature),
      ).toBe(true)
      expect(
        Result.isFailure(
          signFile({ file, pem: undefined, releaseKeys: [key.publicPem] }),
        ),
      ).toBe(true)
    }),
  )
})
