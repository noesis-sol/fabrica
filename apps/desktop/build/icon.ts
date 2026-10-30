import { Option } from 'effect'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

import { hexOfColour, parseColour, themeVariables } from '@fabrica/ui/contrast'
import { defaultTheme } from '@fabrica/ui/theme'

// The app's icon (spec §22.2), which electron-builder.yml names for each platform: electron-builder makes
// macOS's icns and Windows's ico from these 1024 px PNGs, and Linux's desktop icon is the PNG itself. The
// handoff has no mark (§18.2, A.4: type, colour blocks and Unicode glyphs), so the icon is drawn from its
// title bar's CORES meter in the default theme: a 3 × 3 grid of square blocks, Lichen Bright's radius being
// 0, the busy ones in --c1 making an F, the idle ones in --line, on --bg. macOS's sits on Apple's icon
// grid, a tile inset from the canvas with rounded corners; the other platforms' fills the canvas.
//
// The PNGs are committed, drawn by `node apps/desktop/build/icon.ts`, and checked against this drawing
// by test/app-icon.test.ts.

/** The icon's side, in pixels: what electron-builder asks for to make every size from. */
export const iconSize = 1024

/** Where an icon's tile sits on the canvas, in pixels. */
export interface IconLayout {
  readonly file: string
  readonly inset: number
  readonly radius: number
}

/** macOS's icon: Apple's grid, an 824 px tile with rounded corners, 100 px in from the edges. */
export const macIcon: IconLayout = {
  file: 'icon-mac.png',
  inset: 100,
  radius: 185,
}

/** Linux's and Windows's icon: the tile the whole canvas, square as the theme draws its blocks. */
export const plainIcon: IconLayout = { file: 'icon.png', inset: 0, radius: 0 }

/** The blocks' side, and the gap between them, as fractions of the tile's side. */
const blockSide = 0.16
const blockGap = 0.04

/** The tile's colour and the blocks', row by row, as the theme's variables: an F of busy cores. */
const tileVariable = 'bg'
const blockVariables = [
  ['c1', 'c1', 'c1'],
  ['c1', 'c1', 'line'],
  ['c1', 'line', 'line'],
] as const

/** An sRGB colour, each channel 0 to 255. */
type Rgb = readonly [number, number, number]

/** The themes' stylesheet, the only source of colours. */
export const themesCss = fileURLToPath(
  new URL('../../../packages/ui/src/theme/themes.css', import.meta.url),
)

/** The default theme's `variable` in `css`, as sRGB; a variable the theme doesn't write as one fails. */
const colourOf = (css: string, variable: string): Rgb => {
  const hex = Option.getOrThrowWith(
    Option.fromUndefinedOr(
      themeVariables(css).get(defaultTheme)?.get(variable),
    ).pipe(Option.flatMap(parseColour), Option.map(hexOfColour)),
    () => new Error(`${defaultTheme} has no opaque --${variable}`),
  )
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** How much of the span `[from, from + 1)` lies within `[start, end)`. */
const overlap = (from: number, start: number, end: number): number =>
  Math.max(0, Math.min(from + 1, end) - Math.max(from, start))

/** The samples per side a pixel is cut into where a rounded corner crosses it. */
const cornerSamples = 8

/** How much of the pixel at `x`, `y` the tile of `layout` covers, 0 to 1. */
const tileCoverage = ({ inset, radius }: IconLayout, x: number, y: number) => {
  const end = iconSize - inset
  const square = overlap(x, inset, end) * overlap(y, inset, end)
  if (radius === 0 || square === 0) {
    return square
  }
  // The centre of the corner's arc nearest the pixel, where the pixel is in a corner's box.
  const centreX =
    x + 1 <= inset + radius
      ? inset + radius
      : x >= end - radius
        ? end - radius
        : undefined
  const centreY =
    y + 1 <= inset + radius
      ? inset + radius
      : y >= end - radius
        ? end - radius
        : undefined
  if (centreX === undefined || centreY === undefined) {
    return square
  }
  let inside = 0
  for (let row = 0; row < cornerSamples; row++) {
    for (let column = 0; column < cornerSamples; column++) {
      const dx = x + (column + 0.5) / cornerSamples - centreX
      const dy = y + (row + 0.5) / cornerSamples - centreY
      if (dx * dx + dy * dy <= radius * radius) {
        inside++
      }
    }
  }
  return inside / cornerSamples ** 2
}

/** The icon of `layout` in the theme's colours of `css`: `iconSize` rows of RGBA pixels, unpremultiplied. */
export const drawIcon = (layout: IconLayout, css: string): Uint8Array => {
  const tile = colourOf(css, tileVariable)
  const side = iconSize - 2 * layout.inset
  const block = blockSide * side
  const grid = blockVariables.length
  const start =
    layout.inset + (side - grid * block - (grid - 1) * blockGap * side) / 2
  const blocks = blockVariables.flatMap((row, rowIndex) =>
    row.map((variable, columnIndex) => ({
      colour: colourOf(css, variable),
      x: start + columnIndex * (block + blockGap * side),
      y: start + rowIndex * (block + blockGap * side),
    })),
  )
  const pixels = new Uint8Array(iconSize * iconSize * 4)
  for (let y = 0; y < iconSize; y++) {
    for (let x = 0; x < iconSize; x++) {
      const coverage = tileCoverage(layout, x, y)
      if (coverage === 0) {
        continue
      }
      // The blocks lie inside the tile, apart: a pixel is the tile's colour mixed with one block's.
      const colour = blocks.reduce<Rgb>(
        (under, { colour, x: left, y: top }) => {
          const share =
            overlap(x, left, left + block) * overlap(y, top, top + block)
          return share === 0
            ? under
            : [
                under[0] + (colour[0] - under[0]) * share,
                under[1] + (colour[1] - under[1]) * share,
                under[2] + (colour[2] - under[2]) * share,
              ]
        },
        tile,
      )
      const offset = (y * iconSize + x) * 4
      pixels[offset] = Math.round(colour[0])
      pixels[offset + 1] = Math.round(colour[1])
      pixels[offset + 2] = Math.round(colour[2])
      pixels[offset + 3] = Math.round(coverage * 255)
    }
  }
  return pixels
}

/** The PNG's image data before compression: each row of `pixels` after its filter type, 0 (none). */
export const scanlines = (pixels: Uint8Array): Uint8Array => {
  const row = iconSize * 4
  const lines = new Uint8Array(iconSize * (row + 1))
  for (let y = 0; y < iconSize; y++) {
    lines.set(pixels.subarray(y * row, (y + 1) * row), y * (row + 1) + 1)
  }
  return lines
}

/** The PNG's header: `iconSize` square, 8-bit RGBA, not interlaced. */
export const pngHeader = (): Uint8Array => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(iconSize, 0)
  header.writeUInt32BE(iconSize, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return header
}

const chunk = (type: string, data: Uint8Array): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** The PNG signature every PNG opens with. */
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** `pixels` as a PNG file. */
export const encodePng = (pixels: Uint8Array): Buffer =>
  Buffer.concat([
    pngSignature,
    chunk('IHDR', pngHeader()),
    chunk('IDAT', deflateSync(scanlines(pixels), { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ])

/** Draws both icons into this folder. */
const main = (): number => {
  const css = readFileSync(themesCss, 'utf8')
  for (const layout of [macIcon, plainIcon]) {
    writeFileSync(
      fileURLToPath(new URL(layout.file, import.meta.url)),
      encodePng(drawIcon(layout, css)),
    )
  }
  return 0
}

if (import.meta.main) process.exitCode = main()
