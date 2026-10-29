import { Option } from 'effect'

// Settings files as parsed JSON: the values at a path, and an object holding a value at one.

/** A JSON object, as parsed. */
export type JsonObject = Readonly<Record<string, unknown>>

/** Whether a parsed value is an object (not an array, not null). */
export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The value at `segments` inside `value`, where there is one. */
export const valueAt = (
  value: unknown,
  segments: ReadonlyArray<string>,
): Option.Option<unknown> => {
  const [first, ...rest] = segments
  if (first === undefined) return Option.some(value)
  if (!isJsonObject(value) || !Object.hasOwn(value, first)) return Option.none()
  return valueAt(value[first], rest)
}

/** An object holding `value` at `segments`: `{ verifier: { rounds: 4 } }`. */
export const placedAt = (
  segments: ReadonlyArray<string>,
  value: unknown,
): unknown =>
  segments.reduceRight<unknown>(
    (inner, segment) => ({ [segment]: inner }),
    value,
  )

/**
 * `value` with `inner` at `segments`, the objects on the way kept or made; none where something
 * other than an object stands on the way, which is then the problem to report.
 */
export const withValueAt = (
  value: unknown,
  segments: ReadonlyArray<string>,
  inner: unknown,
): Option.Option<unknown> => {
  const [first, ...rest] = segments
  if (first === undefined) return Option.some(inner)
  if (!isJsonObject(value)) return Option.none()
  const below = Object.hasOwn(value, first)
    ? withValueAt(value[first], rest, inner)
    : Option.some(placedAt(rest, inner))
  return Option.map(below, next => ({ ...value, [first]: next }))
}

/** The value JSON text holds; none where it isn't JSON. */
export const parseJson = (text: string): Option.Option<unknown> => {
  try {
    const parsed: unknown = JSON.parse(text)
    return Option.some(parsed)
  } catch {
    return Option.none()
  }
}
