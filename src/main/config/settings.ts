import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  APP_SCHEMA_VERSION,
  type AppSettings,
  type RecentProject,
  type SettingsPatch,
  type ThemePreference,
  type WindowState
} from '@shared/types'
import { getAppPaths } from './appPaths'
import { createLogger } from './logger'
import {
  readJsonFile,
  timestampSlug,
  writeJsonAtomic
} from '../utils/fs'

const log = createLogger('settings')

const providerSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['openai', 'google', 'ollama', 'custom']),
  name: z.string().min(1),
  baseUrl: z.string().default(''),
  enabled: z.boolean().default(true),
  hasKey: z.boolean().default(false),
  createdAt: z.number().int().nonnegative().default(() => Date.now()),
  updatedAt: z.number().int().nonnegative().default(() => Date.now())
})

const modelSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  inputPricePerMillion: z.number().nonnegative().optional(),
  outputPricePerMillion: z.number().nonnegative().optional(),
  source: z.enum(['discovered', 'manual']).default('discovered'),
  createdAt: z.number().int().nonnegative().default(() => Date.now()),
  updatedAt: z.number().int().nonnegative().default(() => Date.now()),
  lastSeenAt: z.number().int().nonnegative().optional()
})

const recentProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  lastOpenedAt: z.number().int().nonnegative()
})

const windowStateSchema = z.object({
  width: z.number().int().min(320),
  height: z.number().int().min(240),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  maximized: z.boolean().optional()
})

const appSettingsSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    bossName: z.string().min(1).max(80),
    theme: z.enum(['dark', 'light', 'system']),
    recentProjects: z.array(recentProjectSchema).max(20),
    window: windowStateSchema,
    providers: z.array(providerSchema),
    models: z.array(modelSchema),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .passthrough()

let cache: AppSettings | null = null

function defaults(): AppSettings {
  const now = Date.now()
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    bossName: 'Boss',
    theme: 'dark',
    recentProjects: [],
    window: {
      width: 1280,
      height: 820
    },
    providers: [],
    models: [],
    createdAt: now,
    updatedAt: now
  }
}

function settingsPath(): string {
  return getAppPaths().settingsPath
}

function normalizePath(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function loadSettings(): AppSettings {
  if (cache) {
    return cache
  }

  const filePath = settingsPath()
  if (!fs.existsSync(filePath)) {
    const initial = defaults()
    writeJsonAtomic(filePath, initial)
    cache = initial
    log.info('Created default settings', { path: filePath })
    return initial
  }

  try {
    const parsed = appSettingsSchema.parse(readJsonFile<unknown>(filePath)) as AppSettings
    cache = parsed
    return parsed
  } catch (error) {
    const backupPath = path.join(
      path.dirname(filePath),
      `settings.invalid-${timestampSlug()}.json`
    )
    try {
      fs.copyFileSync(filePath, backupPath)
    } catch {
      log.warn('Could not back up invalid settings file', { filePath })
    }
    const reset = defaults()
    writeJsonAtomic(filePath, reset)
    cache = reset
    log.error('Invalid settings file; restored defaults', {
      filePath,
      backupPath,
      error
    })
    return reset
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  const validated = appSettingsSchema.parse({
    ...settings,
    updatedAt: Date.now()
  }) as AppSettings
  writeJsonAtomic(settingsPath(), validated)
  cache = validated
  return validated
}

export function mutateSettings(
  updater: (current: AppSettings) => AppSettings
): AppSettings {
  return saveSettings(updater(loadSettings()))
}

export function updateSettings(patch: SettingsPatch): AppSettings {
  const current = loadSettings()
  const bossName = patch.bossName === undefined ? current.bossName : patch.bossName.trim()
  if (!bossName) {
    throw new Error('Boss name cannot be empty')
  }
  const theme: ThemePreference = patch.theme ?? current.theme
  return saveSettings({
    ...current,
    bossName,
    theme
  })
}

export function recordRecentProject(project: RecentProject): AppSettings {
  const current = loadSettings()
  const target = normalizePath(project.path)
  const next = current.recentProjects.filter((entry) => normalizePath(entry.path) !== target)
  next.unshift(project)
  next.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  return saveSettings({
    ...current,
    recentProjects: next.slice(0, 12)
  })
}

export function removeRecentProject(projectPath: string): AppSettings {
  const current = loadSettings()
  const target = normalizePath(projectPath)
  return saveSettings({
    ...current,
    recentProjects: current.recentProjects.filter(
      (entry) => normalizePath(entry.path) !== target
    )
  })
}

export function updateWindowState(windowState: WindowState): AppSettings {
  const current = loadSettings()
  return saveSettings({
    ...current,
    window: {
      ...current.window,
      ...windowState
    }
  })
}

export function getSettingsFilePath(): string {
  return settingsPath()
}
