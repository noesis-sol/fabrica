import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type LinearRgb,
  aaNormalText,
  contrastRatio,
  parseColour,
  themePairs,
  themeVariables,
} from '../src/theme/contrast'
import themesCss from '../src/theme/themes.css?raw'

const colour = (text: string): LinearRgb =>
  Option.getOrThrowWith(parseColour(text), () => new Error(text))

describe('the contrast ratio', () => {
  it('is 21 for white on black, 1 for a colour on itself, either way round', () => {
    expect(contrastRatio(colour('#FFFFFF'), colour('#000000'))).toBeCloseTo(21)
    expect(contrastRatio(colour('#000000'), colour('#FFFFFF'))).toBeCloseTo(21)
    expect(contrastRatio(colour('#5B9BD5'), colour('#5B9BD5'))).toBe(1)
  })

  it("gives WCAG's figures for greys near AA's bound", () => {
    expect(contrastRatio(colour('#767676'), colour('#FFFFFF'))).toBeCloseTo(
      4.54,
      2,
    )
    expect(contrastRatio(colour('#777777'), colour('#FFFFFF'))).toBeCloseTo(
      4.48,
      2,
    )
  })

  it('reads oklch() as the sRGB colour it names', () => {
    const near = (text: string, hex: string) =>
      expect(contrastRatio(colour(text), colour(hex))).toBeLessThan(1.01)
    near('oklch(1 0 0)', '#FFFFFF')
    near('oklch(0 0 0)', '#000000')
    near('oklch(0.6279 0.2577 29.23)', '#FF0000')
    near('oklch(0.452 0.313 264.05)', '#0000FF')
  })

  it('reads no translucent colour, no keyword and no variable', () => {
    for (const text of ['rgba(255,255,255,0.1)', 'none', 'var(--c1)', '#FFF']) {
      expect(Option.isNone(parseColour(text))).toBe(true)
    }
  })
})

const themes = themeVariables(themesCss)

// Every theme passes AA on every pair: Classic's ink, c2 and c3 were amended to (fab-mgi.35, spec
// §27.2). A pair falling short is held here only as a known failure, filed as a ticket: a new failure
// fails the test, and so does one of these passing, so the list is struck when it's fixed.
const knownFailures: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['lichen-bright', []],
  ['neon-grid', []],
  ['classic', []],
])

describe("each theme's contrast", () => {
  it('reads the three themes', () => {
    expect([...themes.keys()].toSorted()).toEqual([
      'classic',
      'lichen-bright',
      'neon-grid',
    ])
  })

  it.each([...knownFailures])(
    '%s: text and status colours pass AA on their backgrounds, ink on its fills',
    (theme, known) => {
      const { pairs, unreadable } = themePairs(themes.get(theme) ?? new Map())
      expect(unreadable).toEqual([])
      // 7 texts on 3 surfaces, and ink on 5 fills.
      expect(pairs).toHaveLength(26)
      const failing = pairs
        .filter(({ ratio }) => ratio < aaNormalText)
        .map(({ text, background }) => `${text} on ${background}`)
      expect(failing).toEqual(known)
    },
  )
})
