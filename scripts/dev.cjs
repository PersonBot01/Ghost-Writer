const { spawn } = require('node:child_process')
const { access } = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const nodePath = process.execPath
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const tscCli = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const electronCli = path.join(projectRoot, 'node_modules', 'electron', 'cli.js')
const electronEntry = path.join(projectRoot, '.')
const electronMain = path.join(projectRoot, 'dist-electron', 'electron', 'main.js')
const devUrl = 'http://localhost:5173'

const processes = []
let shuttingDown = false

const renderer = spawnProcess('renderer', [viteCli, '--strictPort', '--clearScreen', 'false'])
const compiler = spawnProcess('electron', [
  tscCli,
  '-p',
  'tsconfig.electron.json',
  '--watch',
  '--preserveWatchOutput',
])

processes.push(renderer, compiler)

void launchDesktopWhenReady()

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

for (const child of processes) {
  child.on('exit', (code) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    shutdown()
    process.exitCode = code ?? 0
  })
}

async function launchDesktopWhenReady() {
  try {
    await waitForReadiness()
    if (shuttingDown) {
      return
    }

    const desktop = spawnProcess('desktop', [electronCli, electronEntry], {
      env: {
        ...process.env,
        INIT_CWD: projectRoot,
        VITE_DEV_SERVER_URL: devUrl,
      },
    })
    processes.push(desktop)

    desktop.on('exit', (code) => {
      if (shuttingDown) {
        return
      }

      shuttingDown = true
      shutdown()
      process.exitCode = code ?? 0
    })
  } catch (error) {
    writePrefixed('desktop', `${error instanceof Error ? error.message : String(error)}\n`)
    shutdown()
    process.exitCode = 1
  }
}

function spawnProcess(name, args, options = {}) {
  const child = spawn(nodePath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    env: {
      ...process.env,
      INIT_CWD: projectRoot,
    },
    ...options,
  })

  child.stdout.on('data', (chunk) => {
    writePrefixed(name, chunk.toString())
  })

  child.stderr.on('data', (chunk) => {
    writePrefixed(name, chunk.toString())
  })

  child.on('error', (error) => {
    writePrefixed(name, `${error.message}\n`)
  })

  return child
}

function writePrefixed(name, content) {
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    if (!line) {
      continue
    }
    process.stdout.write(`[${name}] ${line}\n`)
  }
}

async function waitForReadiness() {
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    const [fileReady, urlReady] = await Promise.all([exists(electronMain), responds(devUrl)])
    if (fileReady && urlReady) {
      return
    }
    await sleep(400)
  }
  throw new Error('Timed out waiting for the Vite server and Electron build output to be ready.')
}

async function exists(targetPath) {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

async function responds(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume()
      resolve(response.statusCode !== undefined && response.statusCode < 500)
    })
    request.on('error', () => resolve(false))
    request.setTimeout(1000, () => {
      request.destroy()
      resolve(false)
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shutdown() {
  if (shuttingDown) {
    for (const child of processes) {
      if (!child.killed) {
        child.kill()
      }
    }
    return
  }

  shuttingDown = true
  for (const child of processes) {
    if (!child.killed) {
      child.kill()
    }
  }
}
