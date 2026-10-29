import { Data } from 'effect'

// Where the window may go (spec §20.1): the renderer is treated as an untrusted web page, so it stays
// on the app's own page. A link to a web page opens in the system browser; anything else (another
// file, a data: or javascript: URL, a custom scheme) goes nowhere. No page opens a second window.

/** Where the app's page is loaded from: its bundled file, or the dev server in development. */
export type AppPage = Data.TaggedEnum<{
  File: { readonly url: string }
  DevServer: { readonly url: string }
}>
export const AppPage = Data.taggedEnum<AppPage>()

/** What to do with a navigation, or a window the page opens. */
export type NavigationDecision = Data.TaggedEnum<{
  /** The app's own page: load it. */
  Stay: {}
  /** A web page: load nothing, and open it in the system browser. */
  OpenExternal: { readonly url: string }
  /** Load nothing. */
  Refuse: {}
}>
export const NavigationDecision = Data.taggedEnum<NavigationDecision>()

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** Whether `url` is the app's own page: its file (any fragment or query), or the dev server's origin. */
export const isAppUrl = (page: AppPage, url: string): boolean => {
  const target = parse(url)
  const own = parse(page.url)
  if (target === undefined || own === undefined) {
    return false
  }
  return AppPage.$match(page, {
    File: () =>
      target.protocol === 'file:' &&
      target.host === own.host &&
      target.pathname === own.pathname,
    DevServer: () => target.origin === own.origin,
  })
}

const webProtocols = new Set(['http:', 'https:'])

/** What to do as the page goes to `url`. */
export const decideNavigation = (
  page: AppPage,
  url: string,
): NavigationDecision => {
  if (isAppUrl(page, url)) {
    return NavigationDecision.Stay()
  }
  const target = parse(url)
  return target !== undefined &&
    webProtocols.has(target.protocol) &&
    target.hostname !== '' &&
    target.username === '' &&
    target.password === ''
    ? NavigationDecision.OpenExternal({ url: target.href })
    : NavigationDecision.Refuse()
}

/** What to do as the page opens a window at `url`: never a window of the app's, at most the browser. */
export const decideWindowOpen = (
  page: AppPage,
  url: string,
): NavigationDecision =>
  NavigationDecision.$match(decideNavigation(page, url), {
    Stay: () => NavigationDecision.Refuse(),
    OpenExternal: external => external,
    Refuse: refused => refused,
  })
