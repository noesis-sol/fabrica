import { Array, Data, Effect, Option, Result } from 'effect'

import { decodeProjectSettings } from '@fabrica/contracts'

import { readFileText, writeFileWhole } from '../files'
import { settingsFileMaxBytes } from './read'
import {
  SettingSource,
  SettingsProblems,
  issuesOf,
  projectSettingsPath,
} from './sources'
import { isJsonObject, parseJson, placedAt } from './values'

// Writing one key of `.fabrica/settings.json` keeps the file's own formatting (spec §16, init run
// again; tutti-lx3f): only the key's value is replaced, or the key added beside its neighbours with
// their indentation, or removed with its comma. Every other byte stays as the maintainer wrote it.

/** The settings file isn't a JSON object, so a key can't be written into it. */
export class SettingsFileNotJson extends Data.TaggedError(
  'SettingsFileNotJson',
)<{ readonly reason: string }> {
  override get message() {
    return `The project's settings can't be edited: ${this.reason}`
  }
}

/** A value's place in the text: where it starts and ends, and an object's properties. */
interface JsonNode {
  readonly start: number
  readonly end: number
  /** An object's properties, in the text's order; none for any other value. */
  readonly properties: Option.Option<ReadonlyArray<JsonProperty>>
}

interface JsonProperty {
  readonly key: string
  readonly keyStart: number
  readonly keyEnd: number
  readonly value: JsonNode
}

const blank = new Set([' ', '\t', '\n', '\r'])

/** The places of the values in `text`, which JSON.parse has already accepted. */
const scanJson = (text: string): JsonNode => {
  let at = 0
  const skipBlank = () => {
    while (blank.has(text.charAt(at))) at++
  }
  const skipString = () => {
    at++
    while (text.charAt(at) !== '"') at += text.charAt(at) === '\\' ? 2 : 1
    at++
  }
  const scanValue = (): JsonNode => {
    skipBlank()
    const start = at
    const opening = text.charAt(at)
    if (opening === '{') {
      at++
      const properties: Array<JsonProperty> = []
      skipBlank()
      while (text.charAt(at) !== '}') {
        skipBlank()
        const keyStart = at
        skipString()
        const keyEnd = at
        skipBlank()
        at++
        const value = scanValue()
        properties.push({
          key: String(JSON.parse(text.slice(keyStart, keyEnd))),
          keyStart,
          keyEnd,
          value,
        })
        skipBlank()
        if (text.charAt(at) === ',') at++
      }
      at++
      return { start, end: at, properties: Option.some(properties) }
    }
    if (opening === '[') {
      at++
      skipBlank()
      while (text.charAt(at) !== ']') {
        scanValue()
        skipBlank()
        if (text.charAt(at) === ',') at++
        skipBlank()
      }
      at++
    } else if (opening === '"') skipString()
    else while (at < text.length && !/[\s,\]}]/.test(text.charAt(at))) at++
    return { start, end: at, properties: Option.none() }
  }
  return scanValue()
}

/** How the file is written: its line ending, its indentation step, and what follows a key. */
interface Style {
  readonly eol: string
  readonly step: string
  readonly colon: string
}

const styleOf = (text: string, root: JsonNode): Style => {
  const first = Option.flatMap(root.properties, Array.head)
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    step: /\n([ \t]+)"/.exec(text)?.[1] ?? '  ',
    colon: Option.match(first, {
      onNone: () => ': ',
      onSome: property => text.slice(property.keyEnd, property.value.start),
    }),
  }
}

/** The blanks that start the line `offset` is on. */
const indentAt = (text: string, offset: number): string => {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

const spans = (text: string, node: JsonNode) =>
  text.slice(node.start, node.end).includes('\n')

const splice = (text: string, start: number, end: number, insert: string) =>
  `${text.slice(0, start)}${insert}${text.slice(end)}`

/**
 * `text` with the setting at `path` set to `value` (as it is written in the file), or removed where
 * `value` is none; the rest of the text as it was.
 */
export const editSettingsText = (options: {
  readonly text: string
  readonly path: string
  readonly value: Option.Option<unknown>
}): Effect.Effect<string, SettingsFileNotJson> => {
  const { text, value } = options
  const segments = options.path.split('.')
  if (text.trim() === '')
    return Effect.succeed(
      Option.match(value, {
        onNone: () => text,
        onSome: value =>
          `${JSON.stringify(placedAt(segments, value), null, 2)}\n`,
      }),
    )
  if (!Option.exists(parseJson(text), isJsonObject))
    return Effect.fail(
      new SettingsFileNotJson({ reason: "it isn't a JSON object" }),
    )

  const root = scanJson(text)
  const style = styleOf(text, root)
  const multiline = spans(text, root)

  /** A value written at a property whose line starts with `indent`. */
  const written = (inner: unknown, indent: string, inline: boolean) =>
    inline
      ? JSON.stringify(inner)
      : JSON.stringify(inner, null, style.step).replaceAll(
          '\n',
          `${style.eol}${indent}`,
        )

  /** A property written as `beside` is (its colon's spacing), else as the file's first. */
  const property = (
    key: string,
    inner: unknown,
    indent: string,
    inline: boolean,
    beside?: JsonProperty,
  ) =>
    `${JSON.stringify(key)}${beside === undefined ? style.colon : text.slice(beside.keyEnd, beside.value.start)}${written(inner, indent, inline)}`

  const edit = (node: JsonNode, depth: number): string => {
    const properties = Option.getOrElse(node.properties, () => [])
    const segment = segments[depth] ?? ''
    const rest = segments.slice(depth + 1)
    const found = Array.findLast(properties, entry => entry.key === segment)
    if (Option.isSome(found)) {
      const entry = found.value
      if (rest.length > 0 && Option.isSome(entry.value.properties))
        return edit(entry.value, depth + 1)
      return Option.match(value, {
        onNone: () =>
          rest.length > 0 ? text : remove(properties, entry, node),
        onSome: inner =>
          splice(
            text,
            entry.value.start,
            entry.value.end,
            written(
              placedAt(rest, inner),
              indentAt(text, entry.keyStart),
              !spans(text, node),
            ),
          ),
      })
    }
    return Option.match(value, {
      onNone: () => text,
      onSome: inner => insert(node, properties, segment, placedAt(rest, inner)),
    })
  }

  const insert = (
    node: JsonNode,
    properties: ReadonlyArray<JsonProperty>,
    key: string,
    inner: unknown,
  ): string => {
    const last = Array.last(properties)
    if (Option.isNone(last)) {
      if (!multiline && node !== root)
        return splice(
          text,
          node.start,
          node.end,
          `{${property(key, inner, '', true)}}`,
        )
      const outer = indentAt(text, node.start)
      const indent = `${outer}${style.step}`
      return splice(
        text,
        node.start,
        node.end,
        `{${style.eol}${indent}${property(key, inner, indent, false)}${style.eol}${outer}}`,
      )
    }
    const entry = last.value
    if (!spans(text, node)) {
      const [first, second] = properties
      const separator =
        first !== undefined && second !== undefined
          ? text.slice(first.value.end, second.keyStart)
          : text.charAt(node.start + 1) === ' '
            ? ', '
            : ','
      return splice(
        text,
        entry.value.end,
        entry.value.end,
        `${separator}${property(key, inner, '', true, entry)}`,
      )
    }
    const indent = indentAt(text, entry.keyStart)
    return splice(
      text,
      entry.value.end,
      entry.value.end,
      `,${style.eol}${indent}${property(key, inner, indent, false, entry)}`,
    )
  }

  const remove = (
    properties: ReadonlyArray<JsonProperty>,
    entry: JsonProperty,
    node: JsonNode,
  ): string => {
    const index = properties.indexOf(entry)
    const before = properties[index - 1]
    const after = properties[index + 1]
    if (after !== undefined)
      return splice(text, entry.keyStart, after.keyStart, '')
    if (before !== undefined)
      return splice(text, before.value.end, entry.value.end, '')
    return splice(text, node.start, node.end, '{}')
  }

  return Effect.succeed(edit(root, 0))
}

/**
 * Writes the setting at `path` of the checkout's settings file, as it is written in the file (`"30m"`,
 * `{ "tokens": 2000000 }`), or removes it where `value` is none, keeping the rest of the file as it
 * is. A value that doesn't decode, a person's or a machine's setting among them, is refused.
 */
export const writeProjectSetting = Effect.fn('Settings.writeProjectSetting')(
  function* (options: {
    readonly checkout: string
    readonly path: string
    readonly value: Option.Option<unknown>
  }) {
    const { checkout, path, value } = options
    if (Option.isSome(value)) {
      const decoded = yield* Effect.result(
        decodeProjectSettings(placedAt(path.split('.'), value.value)),
      )
      if (Result.isFailure(decoded)) {
        const source = SettingSource.ProjectFile({ file: projectSettingsPath })
        return yield* new SettingsProblems({
          problems: Array.match(issuesOf(decoded.failure), {
            onEmpty: () =>
              Array.of({ source, path, message: decoded.failure.message }),
            onNonEmpty: issues =>
              Array.map(issues, issue => ({
                source,
                path: issue.segments.join('.'),
                message: issue.message,
              })),
          }),
        })
      }
    }
    const location = { root: checkout, path: projectSettingsPath }
    const text = yield* readFileText(location, {
      maxBytes: settingsFileMaxBytes,
    }).pipe(Effect.catchTag('FileMissing', () => Effect.succeed('')))
    const edited = yield* editSettingsText({ text, path, value })
    if (edited !== text) yield* writeFileWhole(location, edited)
  },
)
