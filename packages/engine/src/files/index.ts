// The one way the engine reads and writes its files (spec §20.2, §13.12, H62, H84).
export * from './errors'
export { type FileLocation, resolveLocation } from './open'
export { type FileContent, writeFileWhole } from './whole'
export { type FileWriter, openFileTruncating } from './truncate'
export { readFileBytes, readFileText } from './read'
export {
  type ByteSink,
  type LineStream,
  makeLineStream,
  openLineStream,
} from './lines'
