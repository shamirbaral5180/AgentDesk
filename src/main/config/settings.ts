import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  APP_SCHEMA_VERSION,
  type AppSettings,
  type CostControlSettings,
  type RecentProject,
  type RetentionSettings,
  type SettingsPatch,
  type SettingsRecoveryNotice,
  type ThemePreference,
  type UpdatePreferences,
  type WindowState
} from '@shared/types'
import { getAppPaths } from './appPaths'
import { createLogger } from './logger'
import {
  readJsonFile,
  timestampSlug,
  tryReadJsonFile,
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

export const DEFAULT_RETENTION: RetentionSettings = {
  sessionDays: 90,
  meetingDays: 90,
  usageDays: 180,
  mcpAuditDays: 30,
  toolCallDays: 30,
  commandLogDays: 14,
  snapshotDays: 30,
  databaseBackups: 5
}

export const DEFAULT_COST_CONTROL: CostControlSettings = {
  monthlyCapUsd: 50,
  warnPercent: 80,
  hardStop: true
}

export const DEFAULT_UPDATES: UpdatePreferences = {
  dismissedVersion: null,
  lastCheckedAt: null
}

const retentionSchema = z.object({
  sessionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.sessionDays),
  meetingDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.meetingDays),
  usageDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.usageDays),
  mcpAuditDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.mcpAuditDays),
  toolCallDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.toolCallDays),
  commandLogDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.commandLogDays),
  snapshotDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION.snapshotDays),
  databaseBackups: z.number().int().min(1).max(50).default(DEFAULT_RETENTION.databaseBackups)
})

const costControlSchema = z.object({
  monthlyCapUsd: z.number().nonnegative().max(100_000).default(DEFAULT_COST_CONTROL.monthlyCapUsd),
  warnPercent: z.number().int().min(1).max(100).default(DEFAULT_COST_CONTROL.warnPercent),
  hardStop: z.boolean().default(DEFAULT_COST_CONTROL.hardStop)
})

const updatePreferencesSchema = z.object({
  dismissedVersion: z.string().max(40).nullable().default(null),
  lastCheckedAt: z.number().int().nonnegative().nullable().default(null)
})

const recoveryNoticeSchema = z
  .object({
    recoveredAt: z.number().int().nonnegative(),
    notes: z.array(z.string()).max(50),
    backupPaths: z.array(z.string()).max(20)
  })
  .nullable()
  .default(null)

const appSettingsSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    bossName: z.string().min(1).max(80),
    theme: z.enum(['dark', 'light', 'system']),
    recentProjects: z.array(recentProjectSchema).max(20),
    window: windowStateSchema,
    providers: z.array(providerSchema),
    models: z.array(modelSchema),
    retention: retentionSchema.default(DEFAULT_RETENTION),
    costControl: costControlSchema.default(DEFAULT_COST_CONTROL),
    updates: updatePreferencesSchema.default(DEFAULT_UPDATES),
    recovery: recoveryNoticeSchema,
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
    retention: { ...DEFAULT_RETENTION },
    costControl: { ...DEFAULT_COST_CONTROL },
    updates: { ...DEFAULT_UPDATES },
    recovery: null,
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

function backupCandidates(filePath: string): string[] {
  const candidates = [`${filePath}.bak`]
  for (let index = 1; index <= 3; index += 1) {
    candidates.push(`${filePath}.${index}.bak`)
  }
  return candidates.filter((candidate) => fs.existsSync(candidate))
}

function salvageArray<T>(
  raw: unknown,
  schema: z.ZodType<T>,
  notes: string[],
  label: string
): T[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) {
      notes.push(`${label} was not an array and was reset.`)
    }
    return []
  }
  const result: T[] = []
  let dropped = 0
  for (const entry of raw) {
    const parsed = schema.safeParse(entry)
    if (parsed.success) {
      result.push(parsed.data)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    notes.push(`${dropped} invalid ${label} entr${dropped === 1 ? 'y was' : 'ies were'} dropped; the rest were preserved.`)
  }
  return result
}

function salvageSettings(raw: unknown): { settings: AppSettings; notes: string[] } {
  const base = defaults()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { settings: base, notes: ['The settings document was not a JSON object.'] }
  }
  const value = raw as Record<string, unknown>
  const notes: string[] = []
  const bossNameParsed = z.string().min(1).max(80).safeParse(value.bossName)
  if (!bossNameParsed.success) {
    notes.push('Boss name was invalid and was reset.')
  }
  const themeParsed = z.enum(['dark', 'light', 'system']).safeParse(value.theme)
  if (!themeParsed.success) {
    notes.push('Theme was invalid and was reset.')
  }
  const windowParsed = windowStateSchema.safeParse(value.window)
  if (!windowParsed.success) {
    notes.push('Window state was invalid and was reset.')
  }
  const retentionParsed = retentionSchema.safeParse(value.retention ?? DEFAULT_RETENTION)
  if (!retentionParsed.success) {
    notes.push('Retention settings were invalid and were reset.')
  }
  const costParsed = costControlSchema.safeParse(value.costControl ?? DEFAULT_COST_CONTROL)
  if (!costParsed.success) {
    notes.push('Cost controls were invalid and were reset.')
  }
  const updatesParsed = updatePreferencesSchema.safeParse(value.updates ?? DEFAULT_UPDATES)
  if (!updatesParsed.success) {
    notes.push('Update preferences were invalid and were reset.')
  }
  const schemaVersion = z.number().int().positive().safeParse(value.schemaVersion)
  const createdAt = z.number().int().nonnegative().safeParse(value.createdAt)
  const updatedAt = z.number().int().nonnegative().safeParse(value.updatedAt)

  return {
    settings: {
      ...base,
      schemaVersion: schemaVersion.success ? schemaVersion.data : base.schemaVersion,
      bossName: bossNameParsed.success ? bossNameParsed.data : base.bossName,
      theme: themeParsed.success ? themeParsed.data : base.theme,
      window: windowParsed.success ? windowParsed.data : base.window,
      recentProjects: salvageArray(
        value.recentProjects,
        recentProjectSchema,
        notes,
        'recent project'
      ).slice(0, 12),
      providers: salvageArray(value.providers, providerSchema, notes, 'provider'),
      models: salvageArray(value.models, modelSchema, notes, 'model'),
      retention: retentionParsed.success ? retentionParsed.data : base.retention,
      costControl: costParsed.success ? costParsed.data : base.costControl,
      updates: updatesParsed.success ? updatesParsed.data : base.updates,
      recovery:
        value.recovery === undefined
          ? null
          : recoveryNoticeSchema.safeParse(value.recovery).success
            ? (value.recovery as SettingsRecoveryNotice)
            : null,
      createdAt: createdAt.success ? createdAt.data : base.createdAt,
      updatedAt: updatedAt.success ? updatedAt.data : base.updatedAt
    },
    notes
  }
}

function quarantineInvalid(filePath: string): string | null {
  const target = path.join(
    path.dirname(filePath),
    `settings.invalid-${timestampSlug()}.json`
  )
  try {
    fs.copyFileSync(filePath, target)
    return target
  } catch {
    log.warn('Could not back up invalid settings file', { filePath })
    return null
  }
}

export function loadSettings(): AppSettings {
  if (cache) {
    return cache
  }

  const filePath = settingsPath()
  if (!fs.existsSync(filePath)) {
    const initial = defaults()
    writeJsonAtomic(filePath, initial, { backup: false })
    cache = initial
    log.info('Created default settings', { path: filePath })
    return initial
  }

  let notes: string[] = []
  let backupPaths: string[] = []
  try {
    const raw = readJsonFile<unknown>(filePath)
    const salvaged = salvageSettings(raw)
    notes = salvaged.notes
    const validated = appSettingsSchema.parse(salvaged.settings) as AppSettings
    if (notes.length > 0) {
      const invalidPath = quarantineInvalid(filePath)
      if (invalidPath) {
        backupPaths.push(invalidPath)
      }
      validated.recovery = {
        recoveredAt: Date.now(),
        notes,
        backupPaths
      }
      writeJsonAtomic(filePath, validated, { backup: true })
      log.warn('Recovered settings section by section', {
        filePath,
        notes,
        backupPaths
      })
    }
    cache = validated
    return validated
  } catch (error) {
    const invalidPath = quarantineInvalid(filePath)
    if (invalidPath) {
      backupPaths.push(invalidPath)
    }
    for (const candidate of backupCandidates(filePath)) {
      const raw = tryReadJsonFile<unknown>(candidate)
      if (raw === null) {
        continue
      }
      const salvaged = salvageSettings(raw)
      try {
        const validated = appSettingsSchema.parse(salvaged.settings) as AppSettings
        validated.recovery = {
          recoveredAt: Date.now(),
          notes: [
            'The settings file was unreadable; the most recent valid backup was restored.',
            ...salvaged.notes
          ],
          backupPaths: [candidate, ...backupPaths]
        }
        writeJsonAtomic(filePath, validated, { backup: false })
        cache = validated
        log.error('Restored settings from backup', {
          filePath,
          backupPath: candidate,
          error
        })
        return validated
      } catch {
        continue
      }
    }
    const reset = defaults()
    reset.recovery = {
      recoveredAt: Date.now(),
      notes: [
        'The settings file and every backup were unreadable. Default settings were restored.',
        ...notes
      ],
      backupPaths
    }
    writeJsonAtomic(filePath, reset, { backup: false })
    cache = reset
    log.error('Invalid settings file; restored defaults', {
      filePath,
      backupPaths,
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
  writeJsonAtomic(settingsPath(), validated, { backup: true })
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

export function updateSettingsPreferences(patch: {
  retention?: Partial<RetentionSettings>
  costControl?: Partial<CostControlSettings>
  updates?: Partial<UpdatePreferences>
  clearRecovery?: boolean
}): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    retention: { ...current.retention, ...patch.retention },
    costControl: { ...current.costControl, ...patch.costControl },
    updates: { ...current.updates, ...patch.updates },
    recovery: patch.clearRecovery ? null : current.recovery
  }
  return saveSettings(next)
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

export function getSettingsRecoveryNotice(): SettingsRecoveryNotice | null {
  return loadSettings().recovery
}

export function clearSettingsCache(): void {
  cache = null
}
