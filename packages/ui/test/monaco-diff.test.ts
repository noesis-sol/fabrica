// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type ConsoleMessage,
  type ElectronApplication,
  type Page,
  type Worker,
  _electron,
} from 'playwright-core'
import { type Plugin, build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The Review screen's diff view as the packaged app loads it (spec §18.1): the Monaco Mount
// (src/mounts/monaco.ts) built by Vite with the app's base, from a file, under the app's
// Content-Security-Policy, in an Electron window confined as the app's. Story tests can't run a Mount,
// so this is where what only the running app shows is checked:
//
// - Monaco's editor worker starts from the page's file and computes the diff, rather than Monaco
//   falling back to the main thread with a warning;
// - the view's icons draw in codicon's font, which editor.api doesn't bring by itself.

const uiRoot = fileURLToPath(new URL('..', import.meta.url))
const pagePath = 'test/fixtures/monaco-diff.html'
/** The build's folder: the package's own cache, left out of git with node_modules. */
const outDir = `${uiRoot}node_modules/.cache/monaco-diff-test`

/** The app's page's Content-Security-Policy meta tag, as apps/desktop's renderer has it. */
const appPolicy = (): string => {
  const html = readFileSync(
    fileURLToPath(
      new URL('../../../apps/desktop/src/renderer/index.html', import.meta.url),
    ),
    'utf8',
  )
  const tag = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/u.exec(html)
  if (tag === null) {
    throw new Error("the app's page has no Content-Security-Policy")
  }
  return tag[0]
}

/** Puts the app's policy at the top of the page's head. */
const withAppPolicy = (policy: string): Plugin => ({
  name: 'fabrica-app-policy',
  transformIndexHtml: html => html.replace('<head>', () => `<head>${policy}`),
})

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
let worker: Promise<Worker>
const messages: Array<ConsoleMessage> = []

beforeAll(async () => {
  await build({
    root: uiRoot,
    configFile: `${uiRoot}vite.config.ts`,
    // The renderer's base in the app (electron-vite's): assets addressed from the page's file.
    base: './',
    logLevel: 'warn',
    plugins: [withAppPolicy(appPolicy())],
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: `${uiRoot}${pagePath}` },
    },
  })
  electron = await _electron.launch({
    executablePath: electronBinary(),
    // Unsandboxed: Ubuntu's AppArmor refuses Chromium's sandbox to a process without privileges; the
    // page's own sandbox is the window's.
    args: ['--no-sandbox', `${uiRoot}test/fixtures/monaco-window.cjs`],
  })
  page = await electron.firstWindow()
  page.on('console', message => messages.push(message))
  worker = page.waitForEvent('worker')
  await page.goto(pathToFileURL(`${outDir}/${pagePath}`).href)
}, 120_000)

afterAll(async () => {
  await electron?.close()
})

describe('the diff view, loaded from a file', () => {
  it('computes the diff in Monaco’s editor worker', async () => {
    await page.waitForSelector('.monaco-diff-editor .line-insert')
    const started = await worker
    expect(started.url()).toMatch(/^file:.*\/editor\.worker-[\w-]+\.js$/u)
    expect(await started.evaluate(() => 1 + 1)).toBe(2)
    expect(
      messages
        .map(message => message.text())
        .filter(text => /web worker/iu.test(text)),
    ).toEqual([])
  })

  it('draws its icons in codicon’s font', async () => {
    await page.waitForSelector('.monaco-diff-editor .codicon')
    // The face's status once it has loaded or failed to: none while no stylesheet declares it.
    const codicon = await page.waitForFunction(() => {
      const faces = [...document.fonts].filter(
        face => face.family.replaceAll('"', '') === 'codicon',
      )
      const settled = faces.every(
        face => face.status === 'loaded' || face.status === 'error',
      )
      return settled && faces.map(face => face.status)
    })
    expect(await codicon.jsonValue()).toEqual(['loaded'])
  })
})
