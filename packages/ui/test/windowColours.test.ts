import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { hexOfColour, parseColour } from '../src/theme/contrast'
import { Theme } from '../src/theme/theme'
import { windowColours, windowColoursOf } from '../src/theme/windowColours'

// The native window's colours from themes.css (spec §18.3, H46): Electron takes hex, and themes.css
// writes Lichen Bright in oklch().

const hexOf = (text: string): string =>
  Option.getOrThrowWith(
    Option.map(parseColour(text), hexOfColour),
    () => new Error(text),
  )

describe('a colour as hex', () => {
  it('gives a hex colour back as it was', () => {
    expect(hexOf('#05060b')).toBe('#05060b')
    expect(hexOf('#E8ECF8')).toBe('#e8ecf8')
  })

  it('gives oklch() as the sRGB colour it names', () => {
    expect(hexOf('oklch(1 0 0)')).toBe('#ffffff')
    expect(hexOf('oklch(0 0 0)')).toBe('#000000')
    expect(hexOf('oklch(0.6279 0.2577 29.23)')).toBe('#ff0000')
  })
})

describe('the window colours', () => {
  it('are each theme’s --bg, --side and --fg, as hex', () => {
    for (const theme of Theme.literals) {
      const colours = Option.getOrThrow(windowColours(theme))
      for (const hex of Object.values(colours)) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
    expect(windowColours('neon-grid')).toEqual(
      Option.some({
        background: '#05060b',
        titleBar: '#030409',
        symbols: '#e8ecf8',
      }),
    )
  })

  it('are none when a theme leaves one out or writes it as no opaque colour', () => {
    expect(
      windowColoursOf(
        '[data-theme="classic"] { --bg: #000000; --fg: #FFFFFF; }',
        'classic',
      ),
    ).toEqual(Option.none())
    expect(
      windowColoursOf(
        '[data-theme="classic"] { --bg: #000000; --side: rgba(0,0,0,0.5); --fg: #FFFFFF; }',
        'classic',
      ),
    ).toEqual(Option.none())
    expect(windowColoursOf('', 'classic')).toEqual(Option.none())
  })
})
