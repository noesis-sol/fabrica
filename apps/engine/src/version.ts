import packageJson from '../package.json' with { type: 'json' }

export const version: string = packageJson.version

export const versionLine = `fabrica ${version}`
