import type { Session, WebContents } from 'electron'

import {
  type AppPage,
  NavigationDecision,
  decideNavigation,
  decideWindowOpen,
} from './navigation'

// The renderer's confinement in main (spec §20.1): every web contents the app makes stays on the
// app's page, opens no window and attaches no <webview>, and the session grants no permission a web
// page asks for. Web links go to the system browser.

/** The one permission granted: writing plain text to the clipboard (a copy button). */
const grantedPermissions = new Set(['clipboard-sanitized-write'])

/** Applies the navigation guard to `contents`, links opened with `openExternal`. */
export const guardWebContents = (
  contents: WebContents,
  page: AppPage,
  openExternal: (url: string) => void,
): void => {
  const guard = (event: { readonly preventDefault: () => void }, url: string) =>
    NavigationDecision.$match(decideNavigation(page, url), {
      Stay: () => undefined,
      OpenExternal: ({ url: external }) => {
        event.preventDefault()
        openExternal(external)
      },
      Refuse: () => event.preventDefault(),
    })
  contents.on('will-navigate', (event, url) => guard(event, url))
  contents.on('will-redirect', (event, url) => guard(event, url))
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    NavigationDecision.$match(decideWindowOpen(page, url), {
      Stay: () => undefined,
      OpenExternal: ({ url: external }) => openExternal(external),
      Refuse: () => undefined,
    })
    return { action: 'deny' }
  })
}

/** Refuses every permission a page of `session` asks for, but the clipboard's plain-text write. */
export const guardPermissions = (session: Session): void => {
  session.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(grantedPermissions.has(permission)),
  )
  session.setPermissionCheckHandler((_contents, permission) =>
    grantedPermissions.has(permission),
  )
}
