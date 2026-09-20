import { findTargetInArgs, handleTarget, launchTarget } from '..'
import { runWineCommandOnGame } from '../../tools'
import { getGame } from '../../utils'
import { sendFrontendMessage } from '../../ipc'
import { isAccessibleWithinFlatpakSandbox } from '../../utils/filesystem'
import { Path } from '../../schemas'

import { mkdirSync, rmSync, writeFileSync } from 'graceful-fs'
import { join } from 'path'
import { tmpdir } from 'os'

jest.mock('../../logger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  LogPrefix: {
    Backend: 'Backend'
  }
}))
jest.mock('../../ipc', () => ({
  sendFrontendMessage: jest.fn()
}))
jest.mock('../../tools', () => ({
  runWineCommandOnGame: jest.fn()
}))
jest.mock('../../utils', () => ({
  getGame: jest.fn()
}))
jest.mock('../../utils/filesystem', () => ({
  isAccessibleWithinFlatpakSandbox: jest.fn()
}))

const mockRunWineCommandOnGame = runWineCommandOnGame as jest.Mock
const mockGetGame = getGame as jest.Mock
const mockIsAccessibleWithinFlatpakSandbox =
  isAccessibleWithinFlatpakSandbox as jest.Mock

let tmpDir: string

beforeAll(() => {
  tmpDir = join(tmpdir(), 'exe_handler_test')
  mkdirSync(tmpDir, { recursive: true })
  for (const file of ['game.exe', 'installer.msi', 'run.bat']) {
    writeFileSync(join(tmpDir, file), '')
  }
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function mockGame(wineType: 'wine' | 'proton' = 'wine', native = false) {
  mockGetGame.mockReturnValue({
    isNative: () => native,
    getGameInfo: () => ({ title: 'Mock Game' }),
    getSettings: () => Promise.resolve({ wineVersion: { type: wineType } })
  })
}

afterEach(() => {
  jest.clearAllMocks()
})

describe('findTargetInArgs', () => {
  test('detects an existing absolute exe path', () => {
    const exePath = join(tmpDir, 'game.exe')
    expect(findTargetInArgs([exePath])).toEqual({
      type: 'exe',
      path: exePath
    })
  })

  test('detects .msi and .bat files', () => {
    const msi = join(tmpDir, 'installer.msi')
    const bat = join(tmpDir, 'run.bat')
    expect(findTargetInArgs([msi])).toEqual({ type: 'exe', path: msi })
    expect(findTargetInArgs([bat])).toEqual({ type: 'exe', path: bat })
  })

  test('resolves relative paths against the working directory', () => {
    const exePath = join(tmpDir, 'game.exe')
    expect(findTargetInArgs(['game.exe'], tmpDir)).toEqual({
      type: 'exe',
      path: exePath
    })
  })

  test('resolves file: URIs', () => {
    const exePath = join(tmpDir, 'game.exe')
    expect(findTargetInArgs([`file://${exePath}`])).toEqual({
      type: 'exe',
      path: exePath
    })
  })

  test('does not detect non-existent or non-windows files', () => {
    expect(findTargetInArgs([join(tmpDir, 'does-not-exist.exe')])).toBeNull()
    expect(findTargetInArgs([join(tmpDir, 'game.exe.bak')])).toBeNull()
  })

  test('detects URIs and forwards them intact', () => {
    const uri = 'ddnet:[::1]:8303'
    expect(findTargetInArgs([uri])).toEqual({
      type: 'uri',
      uri
    })
    expect(findTargetInArgs(['anotherscheme:xyz'])).toEqual({
      type: 'uri',
      uri: 'anotherscheme:xyz'
    })
  })

  test('does not treat heroic:// launch links as URIs', () => {
    expect(
      findTargetInArgs(['heroic://launch?appName=foo&runner=legendary'])
    ).toBeNull()
  })

  test('does not treat Windows drive letters as URIs', () => {
    expect(findTargetInArgs(['C:\\Games\\game.exe'])).toBeNull()
    expect(findTargetInArgs(['C:/Games/game.exe'])).toBeNull()
  })

  test('ignores unrelated arguments', () => {
    expect(findTargetInArgs(['/path/to/heroic', '--some-flag'])).toBeNull()
  })
})

describe('launchTarget', () => {
  test('forwards a URI to plain Wine with `wine start <uri>`', async () => {
    mockGame('wine')
    mockRunWineCommandOnGame.mockResolvedValue({ stdout: '', stderr: '' })

    await launchTarget(
      { type: 'uri', uri: 'ddnet:[::1]:8303' },
      'mock-app',
      'sideload'
    )

    expect(mockRunWineCommandOnGame).toHaveBeenCalledWith(
      'sideload',
      'mock-app',
      {
        commandParts: ['start', 'ddnet:[::1]:8303'],
        protonVerb: 'run',
        options: undefined
      }
    )
  })

  test('forwards a URI to Proton with `start /wait <uri>` and UMU_CONTAINER_NSENTER', async () => {
    mockGame('proton')
    mockRunWineCommandOnGame.mockResolvedValue({ stdout: '', stderr: '' })

    await launchTarget(
      { type: 'uri', uri: 'ddnet:[::1]:8303' },
      'mock-app',
      'sideload'
    )

    expect(mockRunWineCommandOnGame).toHaveBeenCalledWith(
      'sideload',
      'mock-app',
      {
        commandParts: ['start', '/wait', 'ddnet:[::1]:8303'],
        protonVerb: 'runinprefix',
        options: { env: { UMU_CONTAINER_NSENTER: '1' } }
      }
    )
  })

  test('runs an exe with waitforexitandrun', async () => {
    mockGame('wine')
    mockRunWineCommandOnGame.mockResolvedValue({ stdout: '', stderr: '' })

    const exePath = Path.parse(join(tmpDir, 'game.exe'))
    await launchTarget({ type: 'exe', path: exePath }, 'mock-app', 'sideload')

    expect(mockRunWineCommandOnGame).toHaveBeenCalledWith(
      'sideload',
      'mock-app',
      {
        commandParts: [exePath],
        protonVerb: 'waitforexitandrun',
        startFolder: tmpDir
      }
    )
  })

  test('does not launch anything on native games', async () => {
    mockGame('wine', true)
    await launchTarget(
      { type: 'uri', uri: 'ddnet:[::1]:8303' },
      'mock-app',
      'sideload'
    )
    expect(mockRunWineCommandOnGame).not.toHaveBeenCalled()
  })
})

describe('handleTarget', () => {
  test('sends a message for exe files with the flatpak flag', () => {
    mockIsAccessibleWithinFlatpakSandbox.mockReturnValue(false)
    const exePath = Path.parse(join(tmpDir, 'game.exe'))

    handleTarget({ type: 'exe', path: exePath })

    expect(sendFrontendMessage).toHaveBeenCalledWith(
      'exe_handler.showExeFilePicker',
      exePath,
      true,
      false
    )
  })

  test('sends a message for URIs marked as such', () => {
    handleTarget({ type: 'uri', uri: 'ddnet:[::1]:8303' })

    expect(sendFrontendMessage).toHaveBeenCalledWith(
      'exe_handler.showExeFilePicker',
      'ddnet:[::1]:8303',
      false,
      true
    )
  })
})
