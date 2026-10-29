// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, type Page, _electron } from 'playwright-core'
import { PNG } from 'pngjs'
import { type Rollup, build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type Theme, themes } from '../src/theme/theme'

// The console's look (spec §18.2, §24): the console scene (test/fixtures/console-scene.ts) drawn in an
// Electron window, as the app's, through Playwright's Electron support, at the handoff's 1280 × 800
// reference window in each theme, and compared with the handoff's rendered references: design/console/reference.png for Lichen Bright,
// kits.png for Neon Grid and Classic. The handoff draws its window with a frame, so the scene is drawn
// at the size the frame leaves the app and compared with what is inside it, in two ways:
//
// - its geometry: where the console's parts are and how big, measured on the page, against the
//   handoff's (Appendix A.1, A.2, measured on the references), within a pixel;
// - its look: each part, cut where the page draws it, against the same part of the reference, pixel by
//   pixel. A pixel differs when no pixel within two of it in the other image is near its colour, so
//   that glyphs rasterised a fraction of a pixel apart don't count, and missing or other content does.
//
// What the spec changes on purpose is masked: the native window controls and "Fabrica" where the
// design drew three squares and "Hivemind", the title bar's usage windows, the sidebar's "All
// projects" row (left out: the project rows are compared one for one) and its chips' colours, the
// stats row's items and run controls, Fabrica's lower-case ticket IDs, the phase bar and the step
// line, and the attention cards' bodies. Each run writes the captures, the references cut to the window, their differences, each
// part side by side and a report to look-captures/ (left out of git) for review.
//
// A difference beyond the tolerance fails the test, unless it is known: filed as a ticket and held at
// what was measured when it was filed. A known difference that changes fails the test too, so that its
// entry is struck once its ticket brings the part to the handoff's, as the contrast test holds its own.

const uiRoot = fileURLToPath(new URL('..', import.meta.url))
const designRoot = fileURLToPath(
  new URL('../../../design/console/', import.meta.url),
)
const capturesRoot = fileURLToPath(
  new URL('../look-captures/', import.meta.url),
)

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Size {
  readonly width: number
  readonly height: number
}

/**
 * Where each theme's window is drawn in the handoff's PNGs, at their size: a frame of 1280 × 800 whose
 * border (2px in reference.png, 1px in kits.png) leaves the app the rest.
 */
const references: Record<
  Theme,
  {
    readonly file: string
    readonly content: Rect
    /**
     * Where the reference draws the run talk's messages: from the top of their pane (reference.png's
     * HTML, padded 10px under the header's 38px), or from its bottom, as kits.png and Appendix A.2
     * have them, and as the page does.
     */
    readonly talkMessages: 'top' | 'bottom'
  }
> = {
  'lichen-bright': {
    file: 'reference.png',
    content: { x: 66, y: 388, width: 1276, height: 796 },
    talkMessages: 'top',
  },
  'neon-grid': {
    file: 'kits.png',
    content: { x: 65, y: 361, width: 1278, height: 798 },
    talkMessages: 'bottom',
  },
  classic: {
    file: 'kits.png',
    content: { x: 65, y: 1364, width: 1278, height: 798 },
    talkMessages: 'bottom',
  },
}

/** Where reference.png's run talk draws its first message, under the panel's top. */
const talkMessagesTop = 49

/** The handoff's console in a window of `size`, as the references draw it. */
const handoffOf = ({ width, height }: Size) => {
  const main = { left: 260 + 24, right: width - 24, top: 38 + 20 }
  const stats = { top: main.top, height: 44 }
  const talk = { top: stats.top + stats.height + 16, height: 156 }
  const columns = { top: talk.top + talk.height + 16 }
  const column = (main.right - main.left - 16) / 2
  return {
    width,
    height,
    main,
    stats,
    talk,
    history: { width: 320, row: 28 },
    columns,
    column,
    sidebar: { width: 260, rowsTop: 84, row: 62.4 },
    cards: { top: columns.top + 40, height: 86, pitch: 94 },
    search: { width: 260, right: width - 14 },
  }
}

type Handoff = ReturnType<typeof handoffOf>

// The page's parts, by their selectors.
const titleBar = 'header[aria-label="Title bar"]'
const projectRows =
  'nav[aria-label="Projects"] [data-project]:not([data-project="all"])'
const statsRow = '[data-layout="stats-row"]'
const talkRow = '[data-layout="talk-row"]'
const talkPanel = 'section[aria-label="Run talk"]'
const talkLines = `${talkPanel} [data-line]`
const historyPanel = 'section[aria-label="History"]'
const historyRows = `${historyPanel} [role="listitem"]`
const ticketColumns = '[data-layout="ticket-columns"]'
const inProgress = 'section[aria-label="In progress"]'
const inProgressCards = `${inProgress} [data-ticket]`
const attention = 'section[aria-label="Needs your attention"]'
const attentionCards = `${attention} li`

/** The boxes of the elements each selector matches, in the page's order. */
type Boxes = ReadonlyMap<string, ReadonlyArray<Rect>>

const selectors = [
  titleBar,
  projectRows,
  statsRow,
  talkRow,
  talkPanel,
  talkLines,
  historyPanel,
  historyRows,
  ticketColumns,
  inProgress,
  inProgressCards,
  attention,
  attentionCards,
]

const boxOf = (boxes: Boxes, selector: string, index = 0): Rect => {
  const box = boxes.get(selector)?.[index]
  if (box === undefined) {
    throw new Error(`the scene draws no ${selector} at ${index}`)
  }
  return box
}

/** One measure of the console's geometry: what the page has, and what the handoff has. */
interface Measure {
  readonly name: string
  readonly page: number
  readonly handoff: number
}

const measuresOf = (boxes: Boxes, handoff: Handoff): ReadonlyArray<Measure> => {
  const measure = (name: string, page: number, wanted: number): Measure => ({
    name,
    page: Math.round(page * 10) / 10,
    handoff: wanted,
  })
  return [
    measure('title bar height', boxOf(boxes, titleBar).height, 38),
    measure(
      'project row height',
      boxOf(boxes, projectRows).height,
      handoff.sidebar.row,
    ),
    measure('stats row top', boxOf(boxes, statsRow).y, handoff.stats.top),
    measure(
      'stats row height',
      boxOf(boxes, statsRow).height,
      handoff.stats.height,
    ),
    measure('talk row top', boxOf(boxes, talkRow).y, handoff.talk.top),
    measure(
      'talk row height',
      boxOf(boxes, talkRow).height,
      handoff.talk.height,
    ),
    measure(
      'history width',
      boxOf(boxes, historyPanel).width,
      handoff.history.width,
    ),
    measure(
      'history row height',
      boxOf(boxes, historyRows).height,
      handoff.history.row,
    ),
    measure(
      'ticket columns top',
      boxOf(boxes, ticketColumns).y,
      handoff.columns.top,
    ),
    measure(
      'ticket column width',
      boxOf(boxes, inProgress).width,
      handoff.column,
    ),
    measure(
      'card height',
      boxOf(boxes, inProgressCards).height,
      handoff.cards.height,
    ),
    measure(
      'card pitch',
      boxOf(boxes, inProgressCards, 1).y - boxOf(boxes, inProgressCards).y,
      handoff.cards.pitch,
    ),
  ]
}

/** How far a measure may be from the handoff's, in pixels. */
const nearEnough = 1

/** A piece of a part: where the page draws it, where the reference does, and what of it is masked. */
interface Piece {
  readonly page: Rect
  readonly reference: Rect
  /** In the piece's own coordinates. */
  readonly masks: ReadonlyArray<Rect>
}

/** `rect` moved to `at`, keeping its size. */
const placed = (rect: Rect, at: { x: number; y: number }): Rect => ({
  ...rect,
  x: Math.round(at.x),
  y: Math.round(at.y),
})

/** The talk panel's header and composer, and its messages where each reference draws them. */
const runTalkPieces = (
  boxes: Boxes,
  talkRect: Rect,
  talkMessages: 'top' | 'bottom',
): ReadonlyArray<Piece> => {
  const panel = boxOf(boxes, talkPanel)
  const first = boxOf(boxes, talkLines)
  const last = boxOf(boxes, talkLines, 1)
  const header = { ...talkRect, height: 38 }
  const composer = {
    ...talkRect,
    y: talkRect.y + talkRect.height - 41,
    height: 41,
  }
  const messages = {
    ...talkRect,
    y: talkRect.y + Math.round(first.y - panel.y),
    height: Math.round(last.y + last.height - first.y),
  }
  return [
    {
      page: placed(header, panel),
      reference: header,
      // "Fabrica" where the handoff has "Hivemind", and the note after it.
      masks: [{ x: 26, y: 0, width: 160, height: 38 }],
    },
    {
      page: placed(messages, { x: panel.x, y: first.y }),
      reference:
        talkMessages === 'top'
          ? { ...messages, y: talkRect.y + talkMessagesTop }
          : messages,
      // The agent's name, "Fabrica" where the handoff has "Hivemind".
      masks: [
        {
          x: 0,
          y: Math.round(last.y - first.y) - 2,
          width: 12 + 64,
          height: Math.round(last.height) + 4,
        },
      ],
    },
    {
      page: placed(composer, {
        x: panel.x,
        y: panel.y + talkRect.height - 41,
      }),
      reference: composer,
      masks: [],
    },
  ]
}

/** The console's parts, each a piece or a few, as the page and the reference draw them. */
const partsOf = (
  boxes: Boxes,
  handoff: Handoff,
  talkMessages: 'top' | 'bottom',
): Record<string, ReadonlyArray<Piece>> => {
  const { width, height, main, column, cards, sidebar } = handoff
  const talkRect = {
    x: main.left,
    y: handoff.talk.top,
    width: main.right - handoff.history.width - 16 - main.left,
    height: handoff.talk.height,
  }
  const historyRect = {
    x: main.right - handoff.history.width,
    y: handoff.talk.top,
    width: handoff.history.width,
    height: handoff.talk.height,
  }
  const headerRect = (x: number) => ({
    x,
    y: handoff.columns.top,
    width: column,
    height: cards.top - handoff.columns.top,
  })
  const cardRect = (index: number) => ({
    x: main.left,
    y: cards.top + cards.pitch * index,
    width: column,
    height: cards.height,
  })
  const rowRect = (index: number) => ({
    x: 0,
    y: Math.round(sidebar.rowsTop + sidebar.row * index),
    width: sidebar.width - 1,
    height: Math.floor(sidebar.row),
  })
  const titleRect = { x: 0, y: 0, width, height: 37 }
  return {
    'title bar': [
      {
        page: titleRect,
        reference: titleRect,
        // The window controls and the app's name, the system stats and the usage windows beside them:
        // the search field is compared.
        masks: [
          {
            x: 0,
            y: 0,
            width: handoff.search.right - handoff.search.width - 8,
            height: 37,
          },
        ],
      },
    ],
    'sidebar header': [
      {
        page: { x: 0, y: 38, width: 259, height: 45 },
        reference: { x: 0, y: 38, width: 259, height: 45 },
        // "Projects" where the handoff has "Coding sessions": the count is compared.
        masks: [{ x: 0, y: 0, width: 200, height: 45 }],
      },
    ],
    'project rows': Array.from({ length: 7 }, (_, index) => ({
      page: placed(rowRect(index), boxOf(boxes, projectRows, index)),
      reference: rowRect(index),
      // The chip, in the project's colour by its index (§18.3), and the run's state.
      masks: [
        { x: 14, y: 0, width: 28, height: Math.floor(sidebar.row) },
        { x: 180, y: 0, width: 79, height: Math.floor(sidebar.row) },
      ],
    })),
    'sidebar footer': [
      {
        page: { x: 0, y: height - 57, width: 259, height: 57 },
        reference: { x: 0, y: height - 57, width: 259, height: 57 },
        // "+ Add project" where the handoff has "+ New session".
        masks: [{ x: 14, y: 9, width: 150, height: 40 }],
      },
    ],
    'run talk': runTalkPieces(boxes, talkRect, talkMessages),
    history: [
      {
        page: placed(historyRect, boxOf(boxes, historyPanel)),
        reference: historyRect,
        masks: [],
      },
    ],
    'in progress': [
      {
        page: placed(headerRect(main.left), boxOf(boxes, inProgress)),
        reference: headerRect(main.left),
        masks: [],
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        page: placed(cardRect(index), boxOf(boxes, inProgressCards, index)),
        reference: cardRect(index),
        // The ticket's ID, lower-case in Fabrica, the phase bar (H45, where the handoff has a
        // progress bar) and the step line.
        masks: [
          { x: 14, y: 12, width: 54, height: 22 },
          { x: 1, y: 36, width: column - 2, height: cards.height - 38 },
        ],
      })),
    ],
    attention: [
      {
        page: placed(
          headerRect(main.left + column + 16),
          boxOf(boxes, attention),
        ),
        reference: headerRect(main.left + column + 16),
        masks: [],
      },
      {
        // The first card's tag line: the cards' bodies are Fabrica's (§15.1, §18.3).
        page: placed(
          { ...cardRect(0), x: main.left + column + 16, height: 40 },
          boxOf(boxes, attentionCards),
        ),
        reference: { ...cardRect(0), x: main.left + column + 16, height: 40 },
        // The ticket's ID, lower-case in Fabrica.
        masks: [{ x: 80, y: 8, width: 60, height: 26 }],
      },
    ],
  }
}

/** The share of a part's pixels that may differ from the handoff's. */
const tolerance = 0.05

/**
 * Differences beyond the tolerance, filed as tickets, by theme and measure or part: a measure held at
 * what the page had, a part at the share measured (with room for another platform's rendering).
 */
const known: ReadonlyMap<string, { ticket: string; held: number }> = new Map(
  themes.flatMap(theme => {
    const entry = (name: string, ticket: string, held: number) =>
      [`${theme} ${name}`, { ticket, held }] as const
    return [
      entry('history row height', 'fab-mgi.70', 26),
      entry('history', 'fab-mgi.70', 0.2),
    ]
  }),
)

/** The page's address, served from the build in memory. */
const origin = 'http://look.test'
const pagePath = 'test/fixtures/console-scene.html'

const readPng = (path: string): PNG => PNG.sync.read(readFileSync(path))

/** `rect` of `image`, as an image of its own. */
const cut = (image: PNG, rect: Rect): PNG => {
  const part = new PNG({ width: rect.width, height: rect.height })
  PNG.bitblt(image, part, rect.x, rect.y, rect.width, rect.height, 0, 0)
  return part
}

const inRect = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x &&
  x < rect.x + rect.width &&
  y >= rect.y &&
  y < rect.y + rect.height

/** The squared distance under which two colours are the same. */
const sameColour = 32 ** 2

const distance = (a: PNG, i: number, b: PNG, j: number): number =>
  ((a.data[i] ?? 0) - (b.data[j] ?? 0)) ** 2 +
  ((a.data[i + 1] ?? 0) - (b.data[j + 1] ?? 0)) ** 2 +
  ((a.data[i + 2] ?? 0) - (b.data[j + 2] ?? 0)) ** 2

/** How far apart two pixels may be and still match. */
const reach = 2

/** Whether some pixel of `other` within `reach` of (x, y) is near the colour of `image`'s pixel there. */
const matched = (image: PNG, other: PNG, x: number, y: number): boolean => {
  const at = (y * image.width + x) * 4
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const ox = x + dx
      const oy = y + dy
      if (
        ox >= 0 &&
        oy >= 0 &&
        ox < other.width &&
        oy < other.height &&
        distance(image, at, other, (oy * other.width + ox) * 4) <= sameColour
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * How many unmasked pixels of a piece differ, of how many, and the piece as the page and the reference
 * draw it with the differences in a third image, side by side.
 */
const compare = (
  actual: PNG,
  expected: PNG,
  piece: Piece,
): {
  readonly differing: number
  readonly compared: number
  readonly sheet: PNG
} => {
  const width = Math.min(piece.page.width, piece.reference.width)
  const height = Math.min(piece.page.height, piece.reference.height)
  const a = cut(actual, { ...piece.page, width, height })
  const b = cut(expected, { ...piece.reference, width, height })
  const diff = new PNG({ width, height })
  let differing = 0
  let compared = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const grey = Math.round(
        ((b.data[at] ?? 0) + (b.data[at + 1] ?? 0) + (b.data[at + 2] ?? 0)) /
          12,
      )
      if (piece.masks.some(mask => inRect(mask, x, y))) {
        diff.data.set([0, 0, 96, 255], at)
      } else if (matched(a, b, x, y) && matched(b, a, x, y)) {
        compared++
        diff.data.set([grey, grey, grey, 255], at)
      } else {
        compared++
        differing++
        diff.data.set([255, 0, 0, 255], at)
      }
    }
  }
  return { differing, compared, sheet: besideEachOther([a, b, diff]) }
}

/** `images` side by side, 8px apart. */
const besideEachOther = (images: ReadonlyArray<PNG>): PNG => {
  const gap = 8
  const sheet = new PNG({
    width: images.reduce((sum, image) => sum + image.width + gap, -gap),
    height: Math.max(...images.map(image => image.height)),
  })
  images.reduce((x, image) => {
    PNG.bitblt(image, sheet, 0, 0, image.width, image.height, x, 0)
    return x + image.width + gap
  }, 0)
  return sheet
}

/** The pieces' sheets one under another, 8px apart. */
const underEachOther = (images: ReadonlyArray<PNG>): PNG => {
  const gap = 8
  const sheet = new PNG({
    width: Math.max(...images.map(image => image.width)),
    height: images.reduce((sum, image) => sum + image.height + gap, -gap),
  })
  images.reduce((y, image) => {
    PNG.bitblt(image, sheet, 0, 0, image.width, image.height, 0, y)
    return y + image.height + gap
  }, 0)
  return sheet
}

/** Where Electron's binary is: what its package gives Node. */
const electronBinary = (): string => {
  const path: unknown = createRequire(import.meta.url)('electron')
  if (typeof path !== 'string') {
    throw new Error("electron's package gave no binary's path")
  }
  return path
}

let electron: ElectronApplication
let page: Page

beforeAll(async () => {
  const built = await build({
    root: uiRoot,
    configFile: `${uiRoot}vite.config.ts`,
    logLevel: 'warn',
    build: {
      write: false,
      rollupOptions: { input: `${uiRoot}${pagePath}` },
    },
  })
  const outputs = (Array.isArray(built) ? built : [built]).filter(
    (output): output is Rollup.RollupOutput => 'output' in output,
  )
  const files = new Map(
    outputs.flatMap(output =>
      output.output.map(file => [
        `/${file.fileName}`,
        file.type === 'asset' ? file.source : file.code,
      ]),
    ),
  )
  electron = await _electron.launch({
    executablePath: electronBinary(),
    // One pixel to a CSS pixel and sRGB whatever the screen, as the handoff's references are drawn.
    // Unsandboxed: Ubuntu's AppArmor refuses Chromium's sandbox to a process without privileges, and
    // the window loads nothing but the scene, from memory.
    args: [
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--no-sandbox',
      `${uiRoot}test/fixtures/look-window.cjs`,
    ],
  })
  page = await electron.firstWindow()
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname
    const body = files.get(path)
    await (body === undefined
      ? route.fulfill({ status: 404 })
      : route.fulfill({
          body: typeof body === 'string' ? body : Buffer.from(body),
          contentType: contentTypeOf(path),
        }))
  })
  mkdirSync(capturesRoot, { recursive: true })
}, 120_000)

afterAll(async () => {
  await electron?.close()
})

const contentTypeOf = (path: string): string =>
  path.endsWith('.html')
    ? 'text/html'
    : path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : path.endsWith('.woff2')
          ? 'font/woff2'
          : 'application/octet-stream'

/** The scene drawn in `theme` at `size`, once its fonts are in and History has drawn its rows. */
const capture = async (
  theme: Theme,
  size: Size,
): Promise<{ readonly image: PNG; readonly boxes: Boxes }> => {
  await electron.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(width, height)
  }, size)
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    size,
  )
  await page.goto(`${origin}/${pagePath}?theme=${theme}`)
  await page.waitForSelector('[data-history-line]')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const boxes = await page.evaluate(
    wanted =>
      wanted.map(
        selector =>
          [
            selector,
            [...document.querySelectorAll(selector)].map(element => {
              const { x, y, width, height } = element.getBoundingClientRect()
              return { x, y, width, height }
            }),
          ] as const,
      ),
    selectors,
  )
  const image = PNG.sync.read(await page.screenshot({ type: 'png' }))
  return { image, boxes: new Map(boxes) }
}

/** What a theme's run found: each measure and part, and the ticket of a known difference. */
interface Finding {
  readonly name: string
  readonly found: number
  readonly beyond: boolean
  readonly ticket?: string
  readonly held?: number
}

/** Whether `finding` is as the test expects: within the tolerance, or a known difference as held. */
const expected = (
  finding: Finding,
  closeTo: (a: number, b: number) => boolean,
) =>
  finding.ticket === undefined
    ? !finding.beyond
    : finding.beyond && closeTo(finding.found, finding.held ?? 0)

describe('the console look', () => {
  for (const theme of themes) {
    it(`${theme} against the handoff`, async () => {
      const reference = references[theme]
      const size = {
        width: reference.content.width,
        height: reference.content.height,
      }
      const handoff = handoffOf(size)
      const drawn = cut(
        readPng(`${designRoot}${reference.file}`),
        reference.content,
      )
      const { image, boxes } = await capture(theme, size)
      writeFileSync(
        `${capturesRoot}${theme}.capture.png`,
        PNG.sync.write(image),
      )
      writeFileSync(
        `${capturesRoot}${theme}.reference.png`,
        PNG.sync.write(drawn),
      )

      const knownOf = (name: string) => known.get(`${theme} ${name}`) ?? {}
      const measures: ReadonlyArray<Finding> = measuresOf(boxes, handoff).map(
        ({ name, page: found, handoff: wanted }) => ({
          name,
          found,
          beyond: Math.abs(found - wanted) > nearEnough,
          ...knownOf(name),
        }),
      )
      const parts: ReadonlyArray<Finding> = Object.entries(
        partsOf(boxes, handoff, reference.talkMessages),
      ).map(([name, pieces]) => {
        const compared = pieces.map(piece => compare(image, drawn, piece))
        writeFileSync(
          `${capturesRoot}${theme}.${name.replaceAll(' ', '-')}.png`,
          PNG.sync.write(underEachOther(compared.map(({ sheet }) => sheet))),
        )
        const differing = compared.reduce(
          (sum, piece) => sum + piece.differing,
          0,
        )
        const all = compared.reduce((sum, piece) => sum + piece.compared, 0)
        const share = Math.round((differing / all) * 1000) / 1000
        return {
          name,
          found: share,
          beyond: share > tolerance,
          ...knownOf(name),
        }
      })
      writeFileSync(
        `${capturesRoot}${theme}.report.json`,
        `${JSON.stringify({ theme, nearEnough, tolerance, measures, parts }, undefined, 2)}\n`,
      )

      expect(
        measures.filter(
          finding =>
            !expected(finding, (a, b) => Math.abs(a - b) <= nearEnough),
        ),
        'measures off the handoff, or known ones changed',
      ).toEqual([])
      expect(
        parts.filter(finding => !expected(finding, (a, b) => a <= b)),
        'parts beyond the tolerance, or known ones changed',
      ).toEqual([])
    }, 60_000)
  }
})
