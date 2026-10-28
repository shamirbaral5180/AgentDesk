import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { APP_NAME } from '@shared/types'

export type AppPaths = {
  appRoot: string
  appDataDir: string
  logsDir: string
  cacheDir: string
  tmpDir: string
  sessionDir: string
  crashDir: string
  settingsPath: string
  secretsPath: string
  mcpDir: string
  mcpPackagesDir: string
  mcpRuntimeDir: string
  mcpLogsDir: string
  mcpServersPath: string
}

let cachedPaths: AppPaths | null = null

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

function ensureFile(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf8')
  }
}

export function initializeAppPaths(): AppPaths {
  if (cachedPaths) {
    return cachedPaths
  }

  const appRoot = app.isPackaged ? path.dirname(process.execPath) : process.cwd()
  const appDataDir = app.isPackaged
    ? path.join(appRoot, 'data')
    : path.join(process.cwd(), '.dev-data')

  const logsDir = path.join(appDataDir, 'logs')
  const cacheDir = path.join(appDataDir, 'cache')
  const tmpDir = path.join(appDataDir, 'tmp')
  const sessionDir = path.join(appDataDir, 'session')
  const crashDir = path.join(appDataDir, 'crashes')
  const mcpDir = path.join(appDataDir, 'mcp')
  const mcpPackagesDir = path.join(mcpDir, 'packages')
  const mcpRuntimeDir = path.join(mcpDir, 'runtime')
  const mcpLogsDir = path.join(mcpDir, 'logs')

  ensureDir(appDataDir)
  ensureDir(logsDir)
  ensureDir(cacheDir)
  ensureDir(tmpDir)
  ensureDir(sessionDir)
  ensureDir(crashDir)
  ensureDir(mcpDir)
  ensureDir(mcpPackagesDir)
  ensureDir(mcpRuntimeDir)
  ensureDir(mcpLogsDir)

  fs.accessSync(appDataDir, fs.constants.W_OK)

  const paths: AppPaths = {
    appRoot,
    appDataDir,
    logsDir,
    cacheDir,
    tmpDir,
    sessionDir,
    crashDir,
    settingsPath: path.join(appDataDir, 'settings.json'),
    secretsPath: path.join(appDataDir, 'secrets.bin'),
    mcpDir,
    mcpPackagesDir,
    mcpRuntimeDir,
    mcpLogsDir,
    mcpServersPath: path.join(mcpDir, 'servers.json')
  }

  ensureFile(
    paths.mcpServersPath,
    JSON.stringify({ schemaVersion: 1, servers: [] }, null, 2) + '\n'
  )

  app.setName(APP_NAME)
  app.setPath('userData', appDataDir)
  app.setPath('sessionData', sessionDir)
  app.setPath('temp', tmpDir)
  app.setPath('crashDumps', crashDir)
  app.setPath('logs', logsDir)
  app.setAppLogsPath(logsDir)
  app.commandLine.appendSwitch('disk-cache-dir', cacheDir)

  process.env.TMP = tmpDir
  process.env.TEMP = tmpDir

  cachedPaths = paths
  return paths
}

export function getAppPaths(): AppPaths {
  if (!cachedPaths) {
    return initializeAppPaths()
  }
  return cachedPaths
}
