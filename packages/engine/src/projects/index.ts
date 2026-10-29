// Projects (spec §10.1, §10.2): registering a checkout or cloning a URL, the host's folders browsed
// for it, the project's files, its settings, its work graph and the status stream of every project.
export { ProjectCheck, checkProject } from './check'
export { listFolders } from './folders'
export * from './layout'
export { nameOf, projectIdFor, ticketPrefixFor } from './names'
export type { ProjectRecord } from './records'
export { readSettings, settingsExist, writeSettings } from './settings'
export {
  Projects,
  type ProjectsShape,
  WorkGraphUnopened,
  layer,
  make,
} from './service'
export { type StatusFeed, makeStatusFeed } from './status'
