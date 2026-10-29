import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import handoffThemesCss from '../../../../design/console/themes.css?raw'
import fontsCss from './fonts.css?raw'
import { Theme, applyTheme, defaultTheme, themeAttribute } from './theme'
import themesCss from './themes.css?raw'
import tokensCss from './tokens.css?raw'

const fontFiles = import.meta.glob('./fonts/*.woff2', {
  query: '?url',
  eager: true,
})

describe('the themes', () => {
  it("are the handoff's themes.css, unchanged", () => {
    expect(themesCss).toBe(handoffThemesCss)
  })

  it('are the three themes.css draws, Lichen Bright by default', () => {
    const drawn = Array.from(
      themesCss.matchAll(/\[data-theme="([^"]+)"\]/g),
      ([, name]) => name,
    )
    expect(drawn.toSorted()).toEqual([...Theme.literals].toSorted())
    expect(defaultTheme).toBe('lichen-bright')
    expect(Schema.is(Theme)('light')).toBe(false)
  })

  it('apply by data-theme on the root, one at a time', () => {
    const root = document.createElement('html')
    applyTheme(root, defaultTheme)
    applyTheme(root, 'neon-grid')
    expect(root.getAttribute(themeAttribute)).toBe('neon-grid')
    expect(themeAttribute).toBe('data-theme')
  })
})

describe("Tailwind's theme", () => {
  const mapped = new Set(
    Array.from(tokensCss.matchAll(/var\(--([\w-]+)\)/g), ([, name]) => name),
  )

  it("maps onto every variable of themes.css's themes", () => {
    const variables = new Set(
      Array.from(themesCss.matchAll(/--([\w-]+):/g), ([, name]) => name),
    )
    expect([...variables].filter(name => !mapped.has(name ?? ''))).toEqual([])
  })

  it("clears Tailwind's own colours, radii and shadows", () => {
    for (const namespace of ['color', 'radius', 'shadow']) {
      expect(tokensCss).toContain(`--${namespace}-*: initial;`)
    }
  })

  it("keeps spacing to the handoff's steps, named by their pixels", () => {
    const steps = Array.from(
      tokensCss.matchAll(/--spacing-(\d+): (\d+)px;/g),
      ([, name, pixels]) => {
        expect(name).toBe(pixels)
        return Number(pixels)
      },
    )
    expect(steps).toEqual([0, 4, 6, 8, 10, 12, 16, 18, 20, 24])
    expect(tokensCss).toContain('--spacing: initial;')
  })

  it('focuses with a 2px --c1 outline at a 2px offset, and brightens hovered buttons', () => {
    expect(tokensCss).toMatch(
      /:focus-visible \{\s*outline: 2px solid var\(--c1\);\s*outline-offset: 2px;/,
    )
    expect(tokensCss).toMatch(
      /button:not\(:disabled\):hover \{\s*filter: brightness\(1\.08\);/,
    )
  })
})

describe('the fonts', () => {
  it('bundle a face for each family themes.css names, from files that are there', () => {
    const faces = Array.from(
      fontsCss.matchAll(
        /font-family: '([^']+)';[^}]*src: url\('\.\/(fonts\/[^']+\.woff2)'\) format\('woff2'\);/g,
      ),
      ([, family, file]) => ({ family, file }),
    )
    expect(new Set(faces.map(({ family }) => family))).toEqual(
      new Set(['Archivo', 'Inter', 'JetBrains Mono']),
    )
    for (const family of ['Archivo', 'Inter', 'JetBrains Mono']) {
      expect(themesCss).toContain(family)
    }
    for (const { file } of faces) {
      expect(Object.keys(fontFiles)).toContain(`./${file}`)
    }
    expect(faces).toHaveLength(Object.keys(fontFiles).length)
  })
})
