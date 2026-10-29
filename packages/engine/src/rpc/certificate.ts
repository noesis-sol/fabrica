import { Clock, Data, Effect, Option, Redacted } from 'effect'
import {
  X509Certificate,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from 'node:crypto'
import * as NodePath from 'node:path'

import { readFileText, writeFileWhole } from '../files'

// The TLS listener's certificate (spec §9.3, §20.2): one the user provides (a certificate and its key,
// PEM files), or one the engine makes once and keeps in its data folder, so its fingerprint, which a
// client pins at its first pairing, stays the same across restarts. The engine's own is self-signed,
// an ECDSA P-256 key, written in DER by hand: Node makes keys and signs, but writes no certificate.

/** A certificate and its private key, PEM, and the certificate's SHA-256 fingerprint. */
export interface TlsCertificate {
  readonly certificate: string
  readonly key: Redacted.Redacted<string>
  /** As Node writes it: upper-case hex pairs joined by colons. */
  readonly fingerprint: string
}

/** Where a certificate and its key are, PEM files. */
export interface CertificateFiles {
  readonly certificate: string
  readonly key: string
}

/** The certificate couldn't be read, made or used. */
export class CertificateFailed extends Data.TaggedError('CertificateFailed')<{
  readonly reason: string
}> {
  override get message() {
    return `the TLS listener's certificate couldn't be used: ${this.reason}`
  }
}

const reasonOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// --- DER -------------------------------------------------------------------------------------

/** A DER element: its tag, its length and its content. */
const element = (tag: number, content: Uint8Array): Uint8Array => {
  const length = content.length
  const head =
    length < 0x80
      ? [length]
      : length < 0x1_00
        ? [0x81, length]
        : [0x82, length >> 8, length & 0xff]
  return Buffer.concat([Buffer.from([tag, ...head]), content])
}

const sequence = (...parts: ReadonlyArray<Uint8Array>) =>
  element(0x30, Buffer.concat(parts))

/** ecdsa-with-SHA256, 1.2.840.10045.4.3.2, as an AlgorithmIdentifier. */
const ecdsaWithSha256 = sequence(
  Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]),
)

/** A Name of one common name. */
const commonName = (name: string) =>
  sequence(
    element(
      0x31,
      sequence(
        Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]),
        element(0x0c, Buffer.from(name, 'utf8')),
      ),
    ),
  )

/** A UTCTime, for a moment before 2050. */
const utcTime = (millis: number) => {
  const iso = new Date(millis).toISOString()
  const digits = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  return element(0x17, Buffer.from(digits, 'ascii'))
}

/** RFC 5280's GeneralizedTime for a certificate with no expiry: clients pin it, they don't date it. */
const noExpiry = element(0x18, Buffer.from('99991231235959Z', 'ascii'))

/** A positive serial number of 16 random bytes. */
const serialNumber = () => {
  const bytes = randomBytes(16)
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01
  return element(0x02, bytes)
}

const pem = (label: string, der: Uint8Array): string => {
  const lines =
    Buffer.from(der)
      .toString('base64')
      .match(/.{1,64}/gu) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`
}

/** A new self-signed certificate for `name`, valid from `now`, and its key, PEM. */
export const makeSelfSigned = (options: {
  readonly name: string
  readonly now: number
}): { readonly certificate: string; readonly key: string } => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  })
  const subject = commonName(options.name)
  const toBeSigned = sequence(
    // [0] EXPLICIT version: v3.
    Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]),
    serialNumber(),
    ecdsaWithSha256,
    subject,
    sequence(utcTime(options.now), noExpiry),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  const signature = sign('sha256', toBeSigned, privateKey)
  const certificate = sequence(
    toBeSigned,
    ecdsaWithSha256,
    element(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  )
  return {
    certificate: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

// --- Reading and keeping ---------------------------------------------------------------------

/** A certificate and its key, checked to go together, with the certificate's fingerprint. */
export const tlsCertificate = (pair: {
  readonly certificate: string
  readonly key: string
}): Effect.Effect<TlsCertificate, CertificateFailed> =>
  Effect.try({
    try: (): TlsCertificate => {
      const parsed = new X509Certificate(pair.certificate)
      if (!parsed.checkPrivateKey(createPrivateKey(pair.key)))
        throw new Error("the key isn't the certificate's")
      return {
        certificate: pair.certificate,
        key: Redacted.make(pair.key),
        fingerprint: parsed.fingerprint256,
      }
    },
    catch: cause => new CertificateFailed({ reason: reasonOf(cause) }),
  })

/** The location of a file at the absolute path `path`, for the engine's one reader and writer. */
const locationOf = (path: string) => ({
  root: NodePath.dirname(path),
  path: NodePath.basename(path),
})

const readPem = (path: string) =>
  readFileText(locationOf(path), { maxBytes: 1_000_000 })

/** The certificate and key the user gave, PEM files. */
export const readCertificate = Effect.fn('Certificate.read')(function* (
  files: CertificateFiles,
) {
  const [certificate, key] = yield* Effect.all(
    [readPem(files.certificate), readPem(files.key)],
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.mapError(
      error => new CertificateFailed({ reason: reasonOf(error) }),
    ),
  )
  return yield* tlsCertificate({ certificate, key })
})

/** A PEM file the engine keeps, where it is there. */
const readKept = (path: string) =>
  readPem(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag('FileMissing', () => Effect.succeedNone),
    Effect.mapError(
      error => new CertificateFailed({ reason: reasonOf(error) }),
    ),
  )

/**
 * The engine's own certificate at `files`: the one it made before, or, where neither file is there,
 * one it makes and keeps now. Where only one is there, it fails: the other is the user's to look at.
 */
export const engineCertificate = Effect.fn('Certificate.engine')(function* (
  files: CertificateFiles,
) {
  const [certificate, key] = yield* Effect.all(
    [readKept(files.certificate), readKept(files.key)],
    { concurrency: 'unbounded' },
  )
  if (Option.isSome(certificate) && Option.isSome(key))
    return yield* tlsCertificate({
      certificate: certificate.value,
      key: key.value,
    })
  if (Option.isSome(certificate) || Option.isSome(key))
    return yield* new CertificateFailed({
      reason: `only one of ${files.certificate} and ${files.key} is there`,
    })
  const made = makeSelfSigned({
    name: 'fabrica engine',
    now: yield* Clock.currentTimeMillis,
  })
  const write = (path: string, content: string) =>
    writeFileWhole(locationOf(path), content, { mode: 0o600 }).pipe(
      Effect.mapError(
        error => new CertificateFailed({ reason: reasonOf(error) }),
      ),
    )
  yield* write(files.key, made.key)
  yield* write(files.certificate, made.certificate)
  return yield* tlsCertificate(made)
})
