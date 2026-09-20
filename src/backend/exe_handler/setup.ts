import { findTargetInArgs, handleTarget, launchTarget } from '.'
import { app, type Event } from 'electron'
import { addHandler, addOneTimeListener } from '../ipc'
import { Path } from '../schemas'

interface Options {
  event?: Event
  workingDirectory?: string
}

function findAndHandle(
  argv: string[],
  { event, workingDirectory }: Options = {}
): void {
  const maybeTarget = findTargetInArgs(argv, workingDirectory)
  if (maybeTarget) {
    event?.preventDefault()
    handleTarget(maybeTarget)
  }
}

addHandler(
  'exe_handler.launchWithExeFile',
  (_e, target, appName, runner, isUri) => {
    if (isUri) {
      return launchTarget({ type: 'uri', uri: target }, appName, runner)
    }
    const parsed = Path.safeParse(target)
    if (!parsed.success) return
    return launchTarget({ type: 'exe', path: parsed.data }, appName, runner)
  }
)

addOneTimeListener('frontendReady', () => findAndHandle(process.argv))

app.on('second-instance', (event, argv, workingDirectory) =>
  findAndHandle(argv, { event, workingDirectory })
)
app.on('open-file', (event, rawPath) => findAndHandle([rawPath], { event }))
app.on('open-url', (event, rawUri) => findAndHandle([rawUri], { event }))
