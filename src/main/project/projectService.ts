import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { z } from 'zod'
import type {
  ProjectEntry,
  ProjectInfo,
  TeamConfig
} from '@shared/types'
import { createLogger } from '../config/logger'
import { loadSettings, recordRecentProject } from '../config/settings'
import { openProjectDatabase, type ProjectDatabase } from '../db/database'
import { AppError } from '../errors'
import {
  directoryExists,
  ensureDir,
  readJsonFile,
  safeJoin,
  writeFileAtomic,
  writeJsonAtomic
} from '../utils/fs'
import { writeDetectedContext } from './detect'
import {
  loadOrCreateTeam,
  saveTeamConfig,
  toAgentSummaries
} from './teamDefaults'

const log = createLogger('project')

const manifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  appVersion: z.string()
})

type ProjectManifest = z.infer<typeof manifestSchema>

type ProjectContext = {
  root: string
  dataDir: string
  dbPath: string
  teamPath: string
  lockPath: string
  manifest: ProjectManifest
  team: TeamConfig
  database: ProjectDatabase
  info: ProjectInfo
}

const HIDDEN_TREE_NAMES = new Set([
  '.agentdesk',
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv'
])

let current: ProjectContext | null = null

function lockOwnerIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function acquireProjectLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) {
    try {
      const existing = readJsonFile<{ pid?: number }>(lockPath)
      if (existing.pid && lockOwnerIsAlive(existing.pid)) {
        throw new AppError(
          'PROJECT_IN_USE',
          'This project is already open in another AgentDesk instance.',
          `Lock owner PID: ${existing.pid}`
        )
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      log.warn('Removing invalid project lock', { lockPath })
    }
    fs.rmSync(lockPath, { force: true })
  }

  writeJsonAtomic(lockPath, {
    pid: process.pid,
    startedAt: Date.now(),
    appVersion: app.getVersion()
  })
  log.info('Acquired project lock', { lockPath, pid: process.pid })
}

function releaseProjectLock(lockPath: string): void {
  if (!fs.existsSync(lockPath)) {
    return
  }
  try {
    const existing = readJsonFile<{ pid?: number }>(lockPath)
    if (existing.pid && existing.pid !== process.pid) {
      return
    }
  } catch {
    return
  }
  fs.rmSync(lockPath, { force: true })
  log.info('Released project lock', { lockPath })
}

function initialGitignore(): string {
  return [
    'agentdesk.db',
    'agentdesk.db-wal',
    'agentdesk.db-shm',
    'logs/',
    'snapshots/',
    'assets/',
    'backups/',
    'tmp/',
    '*.lock',
    ''
  ].join('\n')
}

function initialProjectBrief(name: string): string {
  return [
    `# ${name}`,
    '',
    'This is the shared project brief for the agent team.',
    '',
    '## Current goal',
    '',
    'Describe the product, the users, and the current milestone here.',
    '',
    '## Constraints',
    '',
    'Add technical or product constraints here.',
    ''
  ].join('\n')
}

function initialArchitecture(): string {
  return [
    '# Architecture',
    '',
    'The Coordinator maintains this document as the project evolves.',
    '',
    '## System shape',
    '',
    '## Major components',
    '',
    '## Key decisions',
    ''
  ].join('\n')
}

function initialConventions(): string {
  return [
    '# Conventions',
    '',
    'Add coding standards, commands, and review expectations here.',
    ''
  ].join('\n')
}

function ensureFile(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    writeFileAtomic(filePath, content)
  }
}

function ensureProjectStructure(root: string, bossName: string): {
  manifest: ProjectManifest
  team: TeamConfig
} {
  const dataDir = path.join(root, '.agentdesk')
  ensureDir(dataDir)
  ensureDir(path.join(dataDir, 'context'))
  ensureDir(path.join(dataDir, 'memory'))
  ensureDir(path.join(dataDir, 'assets'))
  ensureDir(path.join(dataDir, 'snapshots', 'objects'))
  ensureDir(path.join(dataDir, 'logs', 'commands'))
  ensureDir(path.join(dataDir, 'logs', 'mcp'))
  ensureDir(path.join(dataDir, 'backups'))
  ensureDir(path.join(dataDir, 'tmp'))

  ensureFile(path.join(dataDir, '.gitignore'), initialGitignore())

  const manifestPath = path.join(dataDir, 'project.json')
  let manifest: ProjectManifest
  if (!fs.existsSync(manifestPath)) {
    manifest = {
      schemaVersion: 1,
      id: randomUUID(),
      name: path.basename(root) || root,
      createdAt: Date.now(),
      appVersion: app.getVersion()
    }
    writeJsonAtomic(manifestPath, manifest)
    log.info('Created project manifest', { manifestPath })
  } else {
    try {
      manifest = manifestSchema.parse(readJsonFile<unknown>(manifestPath))
    } catch (error) {
      throw new AppError(
        'PROJECT_DATA_INVALID',
        'The .agentdesk/project.json file is invalid.',
        error instanceof Error ? error.message : undefined
      )
    }
  }

  manifest = {
    ...manifest,
    appVersion: app.getVersion()
  }
  writeJsonAtomic(manifestPath, manifest)

  ensureFile(
    path.join(dataDir, 'context', 'project.md'),
    initialProjectBrief(manifest.name)
  )
  ensureFile(
    path.join(dataDir, 'context', 'architecture.md'),
    initialArchitecture()
  )
  ensureFile(
    path.join(dataDir, 'context', 'conventions.md'),
    initialConventions()
  )

  const teamPath = path.join(dataDir, 'team.json')
  const team = loadOrCreateTeam(teamPath, bossName)

  return {
    manifest,
    team
  }
}

function buildProjectInfo(
  root: string,
  manifest: ProjectManifest,
  team: TeamConfig,
  dbPath: string
): ProjectInfo {
  const detection = writeDetectedContext(root, manifest.name)
  return {
    id: manifest.id,
    name: manifest.name,
    path: root,
    dataDir: path.join(root, '.agentdesk'),
    dbPath,
    openedAt: Date.now(),
    detection,
    agents: toAgentSummaries(team),
    teamPath: path.join(root, '.agentdesk', 'team.json')
  }
}

export function openProject(folderPath: string): ProjectInfo {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new AppError('INVALID_PATH', 'A project folder path is required.')
  }
  const root = path.resolve(folderPath)
  if (!directoryExists(root)) {
    throw new AppError(
      'PROJECT_NOT_FOUND',
      'The selected project folder does not exist.',
      root
    )
  }

  if (current && current.root === root) {
    return current.info
  }

  closeProject()

  const settings = loadSettings()
  const structure = ensureProjectStructure(root, settings.bossName)
  const dataDir = path.join(root, '.agentdesk')
  const dbPath = path.join(dataDir, 'agentdesk.db')
  const lockPath = path.join(dataDir, 'app.lock')

  let database: ProjectDatabase | null = null
  let lockAcquired = false

  try {
    acquireProjectLock(lockPath)
    lockAcquired = true

    database = openProjectDatabase(dbPath, path.join(dataDir, 'backups'))
    const info = buildProjectInfo(root, structure.manifest, structure.team, dbPath)

    current = {
      root,
      dataDir,
      dbPath,
      teamPath: path.join(dataDir, 'team.json'),
      lockPath,
      manifest: structure.manifest,
      team: structure.team,
      database,
      info
    }

    try {
      recordRecentProject({
        id: info.id,
        name: info.name,
        path: info.path,
        lastOpenedAt: info.openedAt
      })
    } catch (error) {
      log.warn('Could not update recent projects', { error })
    }

    log.info('Opened project', {
      name: info.name,
      path: info.path,
      stack: info.detection.stacks
    })

    return info
  } catch (error) {
    if (database) {
      try {
        database.close()
      } catch {
        log.warn('Could not close database after failed project open')
      }
    }
    if (lockAcquired) {
      releaseProjectLock(lockPath)
    }
    if (error instanceof AppError) {
      throw error
    }
    throw new AppError(
      'PROJECT_OPEN_FAILED',
      'Could not open the project.',
      error instanceof Error ? error.message : undefined
    )
  }
}

export function closeProject(): void {
  if (!current) {
    return
  }
  const context = current
  current = null
  try {
    context.database.close()
  } catch (error) {
    log.warn('Could not close project database cleanly', { error })
  }
  releaseProjectLock(context.lockPath)
  log.info('Closed project', { path: context.root })
}

export function getCurrentProject(): ProjectInfo | null {
  return current?.info ?? null
}

export function getCurrentTeamConfig(): TeamConfig | null {
  return current?.team ?? null
}

export function updateCurrentTeam(updater: (team: TeamConfig) => TeamConfig): TeamConfig {
  if (!current) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  const next = updater(current.team)
  saveTeamConfig(current.teamPath, next)
  current.team = next
  current.info = {
    ...current.info,
    agents: toAgentSummaries(next)
  }
  log.info('Updated team configuration', { teamPath: current.teamPath })
  return next
}

export function getCurrentProjectDatabase(): ProjectDatabase | null {
  return current?.database ?? null
}

export function getCurrentProjectRoot(): string | null {
  return current?.root ?? null
}

export function listProjectDirectory(relativePath: string): ProjectEntry[] {
  if (!current) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }

  const normalizedRelative = relativePath.replaceAll('\\', '/')
  const target = safeJoin(current.root, normalizedRelative)
  if (!directoryExists(target)) {
    throw new AppError('NOT_A_DIRECTORY', 'The requested path is not a directory.')
  }

  const entries = fs.readdirSync(target, { withFileTypes: true })
  const result: ProjectEntry[] = []

  for (const entry of entries) {
    if (HIDDEN_TREE_NAMES.has(entry.name)) {
      continue
    }
    const entryPath = path.join(target, entry.name)
    const entryRelative = normalizedRelative
      ? `${normalizedRelative.replace(/\/$/, '')}/${entry.name}`
      : entry.name

    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        relativePath: entryRelative,
        type: 'dir',
        size: null
      })
    } else if (entry.isFile()) {
      let size: number | null = null
      try {
        size = fs.statSync(entryPath).size
      } catch {
        size = null
      }
      result.push({
        name: entry.name,
        relativePath: entryRelative,
        type: 'file',
        size
      })
    }
  }

  result.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  return result
}
