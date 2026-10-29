// scripts/sign-checksums.ts: signs a release's checksums.txt with the ed25519 release key (spec §20.4,
// orchestra's scheme), for the install script and `fabrica engine update` to verify: it writes the raw
// 64-byte signature to checksums.txt.sig beside it, as `openssl pkeyutl -sign -rawin` would. The key is a
// PKCS#8 PEM private key in $FABRICA_RELEASE_KEY, the repository secret of that name in the release
// workflow (.github/workflows/release.yml). Without it, with a key that isn't ed25519, or with one whose
// public half isn't among scripts/install.sh's release keys, which would refuse the release, it signs
// nothing and exits 1, saying why.
//
//   FABRICA_RELEASE_KEY="$(cat release-key.pem)" node scripts/sign-checksums.ts out/checksums.txt
//
// The key is made once, by the maintainer, and its public half added to `release_keys` in
// scripts/install.sh before it signs a release:
//
//   openssl genpkey -algorithm ed25519 -out release-key.pem
//   openssl pkey -in release-key.pem -pubout          # the public half
//   gh secret set FABRICA_RELEASE_KEY < release-key.pem
//
// To replace it, the new key's public half is added a release before the old one's leaves, so that the
// engines of both releases verify the next.
//
// Node runs this file itself, stripping its types.
import { Result } from 'effect'
import {
  type KeyObject,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import * as NodePath from 'node:path'

/** The environment variable holding the private key. */
export const KEY_ENV = 'FABRICA_RELEASE_KEY'

/** The install script, whose `release_keys` are the public keys a release may be signed with. */
export const INSTALL_SCRIPT = 'scripts/install.sh'

const PUBLIC_KEY = /-----BEGIN PUBLIC KEY-----\n[^-]+-----END PUBLIC KEY-----/g

/** The PEM public keys in the install script's `release_keys`, oldest first. */
export const releaseKeysOf = (script: string): ReadonlyArray<string> => {
  const assignment = /^release_keys='([^']*)'$/m.exec(script)
  return assignment?.[1]?.match(PUBLIC_KEY) ?? []
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The PEM text as an ed25519 private key, or why it isn't one. */
export const releaseKey = (
  pem: string | undefined,
): Result.Result<KeyObject, string> => {
  if (pem === undefined || pem.trim() === '')
    return Result.fail(
      `$${KEY_ENV} is empty: it holds the release key, a PKCS#8 PEM ed25519 private key (in the release workflow, the repository secret ${KEY_ENV})`,
    )
  if (!pem.includes('-----BEGIN PRIVATE KEY-----'))
    return Result.fail(
      `$${KEY_ENV} is not a PKCS#8 PEM private key (-----BEGIN PRIVATE KEY-----)`,
    )
  let key: KeyObject
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch (error) {
    return Result.fail(`$${KEY_ENV} doesn't parse: ${message(error)}`)
  }
  return key.asymmetricKeyType === 'ed25519'
    ? Result.succeed(key)
    : Result.fail(
        `$${KEY_ENV} is a ${key.asymmetricKeyType ?? 'symmetric'} key, not an ed25519 key`,
      )
}

const verifiesWith = (
  data: Uint8Array,
  signature: Uint8Array,
  pem: string,
): boolean => {
  try {
    return verify(null, data, createPublicKey(pem), signature)
  } catch {
    return false
  }
}

/**
 * `data`'s raw 64-byte ed25519 signature with `key`, once it verifies with one of the release keys, as
 * the install script verifies it; or why it doesn't.
 */
export const signRelease = ({
  data,
  key,
  releaseKeys,
}: {
  readonly data: Uint8Array
  readonly key: KeyObject
  readonly releaseKeys: ReadonlyArray<string>
}): Result.Result<Uint8Array, string> => {
  const signature = sign(null, data, key)
  if (!verify(null, data, createPublicKey(key), signature))
    return Result.fail(
      "the signature doesn't verify with the key's own public half",
    )
  if (releaseKeys.length === 0)
    return Result.fail(
      `${INSTALL_SCRIPT} holds no release key yet: add the public half of $${KEY_ENV} to its release_keys first`,
    )
  return releaseKeys.some(pem => verifiesWith(data, signature, pem))
    ? Result.succeed(signature)
    : Result.fail(
        `$${KEY_ENV}'s public half is not among ${INSTALL_SCRIPT}'s release_keys, so the install script would refuse the release: add it there first`,
      )
}

/** Signs `file` with the PEM key into `file`.sig; or says why not. */
export const signFile = ({
  file,
  pem,
  releaseKeys,
}: {
  readonly file: string
  readonly pem: string | undefined
  readonly releaseKeys: ReadonlyArray<string>
}): Result.Result<string, string> =>
  Result.flatMap(releaseKey(pem), key =>
    Result.map(
      signRelease({ data: readFileSync(file), key, releaseKeys }),
      signature => {
        writeFileSync(`${file}.sig`, signature)
        return `${file}.sig`
      },
    ),
  )

const main = (args: ReadonlyArray<string>): number => {
  const [file, ...rest] = args
  if (file === undefined || rest.length > 0) {
    process.stderr.write(
      `usage: ${KEY_ENV}=<PEM key> node scripts/sign-checksums.ts <checksums.txt>\n`,
    )
    return 2
  }
  const script = readFileSync(
    NodePath.join(import.meta.dirname, '..', INSTALL_SCRIPT),
    'utf8',
  )
  return Result.match(
    signFile({
      file,
      pem: process.env[KEY_ENV],
      releaseKeys: releaseKeysOf(script),
    }),
    {
      onFailure: why => {
        process.stderr.write(`sign-checksums: ${why}\n`)
        return 1
      },
      onSuccess: signature => {
        process.stdout.write(
          `sign-checksums: signed ${file} into ${signature}\n`,
        )
        return 0
      },
    },
  )
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
