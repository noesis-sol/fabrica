import { Layer, Predicate } from 'effect'
import { HttpBody } from 'effect/http'
import { OtlpSerialization } from 'effect/observability'

// What an export may carry (spec §21, Export): metadata only (counts, durations, model IDs, token
// totals, cost, error tags), never prompts, code, file contents, secrets or absolute paths. Every
// export goes through this module: the Parquet files leave out the columns named as content, and
// everything sent over OTLP (spans, metrics, the recorded rows) is serialised by
// `metadataSerialization`. A number or a boolean is a count, a duration, a flag: metadata whatever it
// is named (a model call's `output` is its tokens out). Text is kept only where its name isn't
// content's and it is short and names no place (an absolute path, a home folder, a URL); a span's
// status message, its events but its exceptions (Effect makes every log inside a span an event named
// by its message), an exception's message and stack, and anything structured in an attribute go.

/**
 * Names of text that carries content, never metadata (§21): an export leaves out any text column or
 * attribute named so, or whose dotted name has a part named so, should a table or a span ever gain one.
 */
export const contentFields: ReadonlySet<string> = new Set([
  'title',
  'description',
  'design',
  'acceptance',
  'text',
  'detail',
  'prompt',
  'message',
  'content',
  'output',
  'command',
  'path',
  'question',
  'notes',
  'stacktrace',
  'stack',
  'cause',
  'query',
  'url',
  'body',
  'args',
  'arguments',
  'input',
  'cwd',
  'file',
  'folder',
  'token',
  'secret',
  'password',
  'api_key',
  'private_key',
  'headers',
  'env',
])

/** Attributes Effect sets that carry content: a log's or a failure's text, a stack. */
const contentAttributes: ReadonlySet<string> = new Set([
  'exception.message',
  'exception.stacktrace',
  'code.stacktrace',
  'log.error',
])

/** The longest text an attribute keeps: longer text is taken for content. */
const longestText = 200

/** Text that names a place on a host or elsewhere: an absolute path, a home folder, a URL. */
const placePattern =
  /(?:^|[\s"'=(,:])(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\)|[A-Za-z][\w+.-]*:\/\//u

/** Whether `text` may leave the host: short, and naming no place. */
export const isMetadataText = (text: string): boolean =>
  text.length <= longestText && !placePattern.test(text)

/** Whether text named `name` may leave the host: none of its dotted parts names content. */
export const isMetadataName = (name: string): boolean =>
  !name
    .toLowerCase()
    .split(/[.:]/u)
    .some(part => contentFields.has(part))

/** Whether an OTLP value is a number or a boolean. */
const isCount = (value: { readonly [x: PropertyKey]: unknown }): boolean =>
  'intValue' in value || 'doubleValue' in value || 'boolValue' in value

/** Whether an OTLP value is text `isMetadataText` keeps. */
const isMetadataString = (value: {
  readonly [x: PropertyKey]: unknown
}): boolean =>
  Predicate.isString(value.stringValue) && isMetadataText(value.stringValue)

/** An OTLP attribute (`{ key, value }`) that is metadata: a number or a boolean, or text named and written as metadata. */
const isMetadataAttribute = (attribute: unknown): boolean => {
  if (!Predicate.isObject(attribute) || !Predicate.isString(attribute.key))
    return false
  const { key, value } = attribute
  if (!Predicate.isObject(value) || contentAttributes.has(key)) return false
  return isCount(value) || (isMetadataName(key) && isMetadataString(value))
}

/** A span event Effect made of a failure, whose attributes say what failed; any other is a log's message. */
const isException = (event: unknown): boolean =>
  Predicate.isObject(event) && event.name === 'exception'

/**
 * An OTLP payload (traces, metrics or logs, as Effect's exporters build them) with only its metadata:
 * every `attributes` list keeps its metadata attributes, a status keeps only its code, a span keeps
 * only its exception events, and a log's body only text `isMetadataText` keeps.
 */
export const metadataOnly = (payload: unknown): unknown => {
  if (Array.isArray(payload)) return payload.map(metadataOnly)
  if (!Predicate.isObject(payload)) return payload
  return Object.fromEntries(
    Object.entries(payload).flatMap(
      ([name, value]): Array<[string, unknown]> => {
        if (name === 'attributes' && Array.isArray(value))
          return [[name, value.filter(isMetadataAttribute)]]
        if (name === 'status' && Predicate.isObject(value))
          return [[name, { code: value.code }]]
        if (name === 'events' && Array.isArray(value))
          return [[name, metadataOnly(value.filter(isException))]]
        if (name === 'body')
          return Predicate.isObject(value) && isMetadataString(value)
            ? [[name, value]]
            : []
        return [[name, metadataOnly(value)]]
      },
    ),
  )
}

/** OTLP's JSON serialisation of Effect's spans, metrics and logs, metadata only. */
export const metadataSerialization = Layer.succeed(
  OtlpSerialization.OtlpSerialization,
  {
    traces: data => HttpBody.jsonUnsafe(metadataOnly(data)),
    metrics: data => HttpBody.jsonUnsafe(metadataOnly(data)),
    logs: data => HttpBody.jsonUnsafe(metadataOnly(data)),
  },
)
