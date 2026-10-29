// Footprints (spec §13.4, H70): where a ticket works, and whether two tickets' footprints hold them
// apart. Pure rules over the files git tracks at Base; what they read of files' contents goes
// through a `ReadSource`.
export { checkFiles } from './checks'
export { codeIn } from './code'
export {
  type Declared,
  declaredBy,
  declaredIn,
  isSource,
  readDeclared,
} from './declared'
export {
  type Footprint,
  type FootprintTicket,
  FootprintSource,
  areaPrefix,
  branchFootprint,
  footprintParts,
  namesFunctions,
  ticketFootprint,
  withChanges,
} from './footprint'
export {
  type Glob,
  collapseAny,
  compileGlob,
  compileSettingsGlob,
  globMeetsFolder,
  globsMeet,
  isGlob,
} from './glob'
export {
  type Mentions,
  Overlap,
  Shared,
  askedFiles,
  describeShared,
  mentionsIn,
  noMentions,
  overlap,
  readMentions,
} from './overlap'
export {
  type ApartFiles,
  Place,
  type Repository,
  makeApartFiles,
  makeRepository,
  placeName,
} from './repository'
export { type ReadSource, maxSourceBytes, readAll, readerIn } from './sources'
