import { Effect, Option } from 'effect'
import { writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { describe, expect, it } from '@effect/vitest'
import { tempFolder } from '@fabrica/testkit'
import { themes } from '@fabrica/ui/theme'

import { keepTheme, keptTheme, themeFileName } from '../src/main/keptTheme'

// The window opens in the theme the page last showed (spec §18.2): main keeps the last theme it was
// told in the app's data folder, and makes the next start's window in it.

describe('the kept theme', () => {
  it.effect('is none until one is kept', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('theme')
        expect(yield* keptTheme(folder)).toEqual(Option.none())
      }),
    ),
  )

  it.effect('is the last theme kept, across starts', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('theme')
        for (const theme of themes) {
          yield* keepTheme({ folder, theme })
          expect(yield* keptTheme(folder)).toEqual(Option.some(theme))
        }
        yield* keepTheme({ folder, theme: 'classic' })
        expect(yield* keptTheme(folder)).toEqual(Option.some('classic'))
      }),
    ),
  )

  it.effect('is none where the file holds no theme', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempFolder('theme')
        const file = NodePath.join(folder, themeFileName)
        for (const text of [
          'not json',
          '{"theme":"solarized"}',
          '"classic"',
          '{}',
        ]) {
          yield* Effect.promise(() => writeFile(file, text))
          expect(yield* keptTheme(folder)).toEqual(Option.none())
        }
      }),
    ),
  )
})
