import { Option } from 'effect'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { appDataFolder, appId, productName } from '../src/main/dataFolder'

// The app's own data folder (spec §7.2): a packaged app's is named after the product, and after its ID on
// macOS, apart from the engine's; a development build keeps Electron's.

describe('the app’s data folder', () => {
  it('is named after the app’s ID on macOS, apart from the engine’s fabrica', () => {
    expect(
      appDataFolder({
        platform: 'darwin',
        packaged: true,
        appData: '/Users/ada/Library/Application Support',
      }),
    ).toEqual(
      Option.some(
        '/Users/ada/Library/Application Support/solutions.noesis.fabrica',
      ),
    )
  })

  it('is named after the product on Linux and Windows', () => {
    expect(
      appDataFolder({
        platform: 'linux',
        packaged: true,
        appData: '/home/ada/.config',
      }),
    ).toEqual(Option.some('/home/ada/.config/Fabrica'))
    expect(
      appDataFolder({
        platform: 'win32',
        packaged: true,
        appData: 'C:\\Users\\ada\\AppData\\Roaming',
      }),
    ).toEqual(Option.some('C:\\Users\\ada\\AppData\\Roaming\\Fabrica'))
  })

  it('is Electron’s own in a development build', () => {
    expect(
      appDataFolder({
        platform: 'darwin',
        packaged: false,
        appData: '/Users/ada/Library/Application Support',
      }),
    ).toEqual(Option.none())
  })

  it('takes the ID and the name electron-builder.yml gives the packages', () => {
    const config = readFileSync(
      new URL('../electron-builder.yml', import.meta.url),
      'utf8',
    )
    expect(config).toMatch(new RegExp(`^appId: ${appId}$`, 'm'))
    expect(config).toMatch(new RegExp(`^productName: ${productName}$`, 'm'))
  })
})
