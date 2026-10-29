// A run's settings: read, resolved once from flags, FABRICA_ variables, the project's and the
// engine's, with each value's source, and a key written keeping the file's formatting (spec §13.13).
export {
  type SettingKey,
  type SettingScope,
  findSettingKey,
  settingKeys,
} from './keys'
export {
  type SettingsProblem,
  SettingSource,
  SettingsProblems,
  describeProblem,
  describeSource,
  projectSettingsPath,
} from './sources'
export {
  ProjectSettingsFile,
  readProjectSettingsFile,
  settingsFileMaxBytes,
} from './read'
export {
  type ResolvedSettings,
  type SettingWithSource,
  type SettingsInputs,
  loadSettings,
  resolveSettings,
  sourceOf,
} from './resolve'
export {
  SettingsFileNotJson,
  editSettingsText,
  writeProjectSetting,
} from './edit'
