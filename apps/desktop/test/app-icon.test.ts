import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  type IconLayout,
  drawIcon,
  iconSize,
  macIcon,
  plainIcon,
  pngHeader,
  pngSignature,
  scanlines,
  themesCss,
} from '../build/icon'

// The app's icon (spec §22.2): the committed PNGs are what build/icon.ts draws from the theme's
// colours, and electron-builder.yml names each platform's.

const buildFile = (name: string): string =>
  fileURLToPath(new URL(`../build/${name}`, import.meta.url))

/** The PNG `file`'s chunks, by type, each type's data joined. */
const chunksOf = (file: Buffer): ReadonlyMap<string, Buffer> => {
  const chunks = new Map<string, Buffer>()
  let offset = pngSignature.length
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('latin1', offset + 4, offset + 8)
    const data = file.subarray(offset + 8, offset + 8 + length)
    chunks.set(type, Buffer.concat([chunks.get(type) ?? Buffer.alloc(0), data]))
    offset += 12 + length
  }
  return chunks
}

/** The text of electron-builder.yml's top-level `key`, up to the next. */
const configSection = (config: string, key: string): string =>
  new RegExp(`^${key}:.*\\n(?:(?:[ \\t].*)?\\n)*`, 'm').exec(config)?.[0] ?? ''

const config = readFileSync(buildFile('../electron-builder.yml'), 'utf8')

describe('the app’s icon', () => {
  const css = readFileSync(themesCss, 'utf8')

  it.each([macIcon, plainIcon])(
    'is committed as build/icon.ts draws it: $file',
    (layout: IconLayout) => {
      const file = readFileSync(buildFile(layout.file))
      expect(file.subarray(0, pngSignature.length)).toEqual(pngSignature)
      const chunks = chunksOf(file)
      expect(chunks.get('IHDR')).toEqual(Buffer.from(pngHeader()))
      expect(
        inflateSync(chunks.get('IDAT') ?? Buffer.alloc(0)).equals(
          Buffer.from(scanlines(drawIcon(layout, css))),
        ),
      ).toBe(true)
    },
  )

  it('fills the canvas on Linux and Windows, and leaves macOS’s corners clear', () => {
    const alphaAt = (pixels: Uint8Array, x: number, y: number) =>
      pixels[(y * iconSize + x) * 4 + 3]
    const plain = drawIcon(plainIcon, css)
    const mac = drawIcon(macIcon, css)
    expect(alphaAt(plain, 0, 0)).toBe(255)
    expect(alphaAt(plain, iconSize - 1, iconSize - 1)).toBe(255)
    expect(alphaAt(mac, 0, 0)).toBe(0)
    expect(alphaAt(mac, macIcon.inset, macIcon.inset)).toBe(0)
    expect(alphaAt(mac, macIcon.inset, iconSize / 2)).toBe(255)
    expect(alphaAt(mac, iconSize / 2, iconSize / 2)).toBe(255)
  })

  it('is named for every platform in electron-builder.yml', () => {
    expect(config).toMatch(/^icon: icon\.png$/m)
    expect(configSection(config, 'mac')).toMatch(/^ {2}icon: icon-mac\.png$/m)
    // Linux would otherwise take macOS's.
    expect(configSection(config, 'linux')).toMatch(/^ {2}icon: icon\.png$/m)
    expect(configSection(config, 'win')).not.toMatch(/^ {2}icon:/m)
  })
})
