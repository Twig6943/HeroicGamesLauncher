import { existsSync } from 'fs'
import path from 'path'

import { logError, logInfo, LogPrefix } from '../logger'
import { sendFrontendMessage } from '../ipc'
import { runWineCommandOnGame } from '../tools'
import { getGame } from '../utils'
import { isAccessibleWithinFlatpakSandbox } from '../utils/filesystem'
import { Path } from '../schemas'

import type { Runner } from 'common/types'

export type HandledTarget =
  | { type: 'exe'; path: Path }
  | { type: 'uri'; uri: string }

// Extracts the scheme of a URI passed as an argument. Returns null
// for anything that isn't a URI we want to forward:
// - `file:` URIs are handled as file paths
// - `heroic://` links are handled by the protocol handler
// - single-letter "schemes" are Windows drive letters (e.g. `C:\...`)
function getUriScheme(arg: string): string | null {
  const match = arg.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (!match) return null
  const scheme = match[1].toLowerCase()
  if (scheme === 'file' || scheme === 'heroic' || scheme.length < 2) {
    return null
  }
  return scheme
}

async function launchTarget(
  target: HandledTarget,
  appName: string,
  runner: Runner
): Promise<void> {
  const game = getGame(appName, runner)
  if (game.isNative()) {
    logError(['Attempted to run item on native game', game], LogPrefix.Backend)
    return
  }

  const appTitle = game.getGameInfo().title
  const descriptor = target.type === 'exe' ? target.path : `URI ${target.uri}`

  logInfo(
    ['Launching', descriptor, 'in prefix of', appTitle],
    LogPrefix.Backend
  )

  if (target.type === 'uri') {
    // Forward the URI to the selected prefix.
    // Plain Wine:      wine start <URI>
    // Proton (umu):    umu-run start /wait <URI>   (with UMU_CONTAINER_NSENTER=1 so the URI is triggered in an already-running container)
    const { wineVersion } = await game.getSettings()
    const isProton = wineVersion.type === 'proton'

    await runWineCommandOnGame(runner, appName, {
      commandParts: isProton
        ? ['start', '/wait', target.uri]
        : ['start', target.uri],
      protonVerb: isProton ? 'runinprefix' : 'run',
      options: isProton ? { env: { UMU_CONTAINER_NSENTER: '1' } } : undefined
    })
    return
  }

  await runWineCommandOnGame(runner, appName, {
    commandParts: [target.path],
    protonVerb: 'waitforexitandrun',
    startFolder: path.dirname(target.path)
  })
}

function findTargetInArgs(
  args: string[],
  workingDirectory?: string
): HandledTarget | null {
  workingDirectory ??= process.cwd()

  for (const arg of args) {
    let parsedPath: string | null = null

    try {
      // Try resolving file: URI first
      const url = new URL(decodeURIComponent(arg))
      if (url.protocol === 'file:') parsedPath = url.pathname
    } catch {
      parsedPath = arg
    }

    if (parsedPath) {
      // Resolve relative path
      parsedPath = path.isAbsolute(parsedPath)
        ? parsedPath
        : path.join(workingDirectory, parsedPath)

      const windowsExecutableExtensions = ['.exe', '.msi', '.bat']
      const parsed = Path.safeParse(parsedPath)
      const isValid =
        parsed.success &&
        existsSync(parsed.data) &&
        windowsExecutableExtensions.includes(
          path.parse(parsed.data).ext.toLowerCase()
        )

      if (isValid) {
        logInfo(
          ['Detected executable in args:', parsed.data],
          LogPrefix.Backend
        )
        return { type: 'exe', path: parsed.data }
      }
    } else if (getUriScheme(arg)) {
      logInfo(['Detected URI in args:', arg], LogPrefix.Backend)
      return { type: 'uri', uri: arg }
    }
  }
  return null
}

function handleTarget(target: HandledTarget) {
  if (process.platform === 'win32') return
  sendFrontendMessage(
    'exe_handler.showExeFilePicker',
    target.type === 'exe' ? target.path : target.uri,
    target.type === 'exe'
      ? !isAccessibleWithinFlatpakSandbox(target.path)
      : false,
    target.type === 'uri'
  )
}

export { launchTarget, findTargetInArgs, handleTarget }
