import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import type { SettingsRecoveryNotice } from '@shared/types'
import { getAppPaths } from './appPaths'
import { createLogger } from './logger'
import {
  readJsonFile,
  timestampSlug,
  tryReadJsonFile,
  writeJsonAtomic
} from '../utils/fs'

const log = createLogger('secrets')

const secretFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string().min(1), z.string().min(1))
})

type SecretFile = z.infer<typeof secretFileSchema>

let cache: SecretFile | null = null
let recoveryNotice: SettingsRecoveryNotice | null = null

function secretsPath(): string {
  return getAppPaths().secretsPath
}

function backupCandidates(filePath: string): string[] {
  const candidates = [`${filePath}.bak`]
  for (let index = 1; index <= 3; index += 1) {
    candidates.push(`${filePath}.${index}.bak`)
  }
  return candidates.filter((candidate) => fs.existsSync(candidate))
}

function quarantineInvalid(filePath: string): string | null {
  const target = path.join(
    path.dirname(filePath),
    `secrets.invalid-${timestampSlug()}.bin`
  )
  try {
    fs.copyFileSync(filePath, target)
    return target
  } catch {
    log.warn('Could not back up invalid secrets file')
    return null
  }
}

function salvageSecretFile(raw: unknown): { value: SecretFile; notes: string[] } {
  const notes: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: { version: 1, entries: {} }, notes: ['Secret store was not a JSON object.'] }
  }
  const value = raw as Record<string, unknown>
  const entriesRaw = value.entries
  if (typeof entriesRaw !== 'object' || entriesRaw === null || Array.isArray(entriesRaw)) {
    return {
      value: { version: 1, entries: {} },
      notes: ['Secret entries were missing or invalid.']
    }
  }
  const entries: Record<string, string> = {}
  let dropped = 0
  for (const [key, entry] of Object.entries(entriesRaw as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key || typeof entry !== 'string' || !entry) {
      dropped += 1
      continue
    }
    entries[key] = entry
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} malformed secret entr${dropped === 1 ? 'y was' : 'ies were'} dropped; unrelated keys were preserved.`
    )
  }
  return { value: { version: 1, entries }, notes }
}

function load(): SecretFile {
  if (cache) {
    return cache
  }
  const filePath = secretsPath()
  if (!fs.existsSync(filePath)) {
    cache = { version: 1, entries: {} }
    recoveryNotice = null
    return cache
  }

  try {
    const raw = readJsonFile<unknown>(filePath)
    const salvaged = salvageSecretFile(raw)
    if (salvaged.notes.length > 0) {
      const invalidPath = quarantineInvalid(filePath)
      recoveryNotice = {
        recoveredAt: Date.now(),
        notes: salvaged.notes,
        backupPaths: invalidPath ? [invalidPath] : []
      }
      writeJsonAtomic(filePath, salvaged.value, { backup: true })
      log.warn('Recovered secrets entry by entry', {
        notes: salvaged.notes,
        backupPaths: recoveryNotice.backupPaths
      })
    }
    cache = salvaged.value
    return cache
  } catch (error) {
    const invalidPath = quarantineInvalid(filePath)
    for (const candidate of backupCandidates(filePath)) {
      const raw = tryReadJsonFile<unknown>(candidate)
      if (raw === null) {
        continue
      }
      const salvaged = salvageSecretFile(raw)
      if (Object.keys(salvaged.value.entries).length === 0 && salvaged.notes.length > 0) {
        continue
      }
      cache = salvaged.value
      recoveryNotice = {
        recoveredAt: Date.now(),
        notes: [
          'The secret store was unreadable; the most recent valid backup was restored.',
          ...salvaged.notes
        ],
        backupPaths: [candidate, ...(invalidPath ? [invalidPath] : [])]
      }
      writeJsonAtomic(filePath, cache, { backup: false })
      log.error('Restored secrets from backup', {
        backupPath: candidate,
        error
      })
      return cache
    }
    cache = { version: 1, entries: {} }
    recoveryNotice = {
      recoveredAt: Date.now(),
      notes: [
        'The secret store and every backup were unreadable. Encrypted keys must be entered again.'
      ],
      backupPaths: invalidPath ? [invalidPath] : []
    }
    writeJsonAtomic(filePath, cache, { backup: false })
    log.error('Invalid secrets file; reset to empty', {
      backupPaths: recoveryNotice.backupPaths,
      error
    })
    return cache
  }
}

function persist(value: SecretFile): void {
  writeJsonAtomic(secretsPath(), value, { backup: true })
  cache = value
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is not available')
  }
}

export function setSecret(key: string, value: string): void {
  assertEncryptionAvailable()
  const current = load()
  const encrypted = safeStorage.encryptString(value).toString('base64')
  persist({
    version: 1,
    entries: {
      ...current.entries,
      [key]: encrypted
    }
  })
}

export function getSecret(key: string): string | null {
  const current = load()
  const encrypted = current.entries[key]
  if (!encrypted) {
    return null
  }
  try {
    assertEncryptionAvailable()
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch (error) {
    log.error('Dropping one undecryptable secret; unrelated keys are preserved', {
      key,
      error
    })
    const nextEntries = { ...current.entries }
    delete nextEntries[key]
    const noticeNotes = [
      `One encrypted secret (${key}) could not be decrypted on this machine and was removed.`
    ]
    recoveryNotice = {
      recoveredAt: Date.now(),
      notes: [...(recoveryNotice?.notes ?? []), ...noticeNotes],
      backupPaths: recoveryNotice?.backupPaths ?? []
    }
    try {
      persist({ version: 1, entries: nextEntries })
    } catch (persistError) {
      log.warn('Could not persist secret removal', { persistError })
    }
    return null
  }
}

export function deleteSecret(key: string): void {
  const current = load()
  if (!(key in current.entries)) {
    return
  }
  const nextEntries = { ...current.entries }
  delete nextEntries[key]
  persist({
    version: 1,
    entries: nextEntries
  })
}

export function hasSecret(key: string): boolean {
  return Boolean(load().entries[key])
}

export function listSecretKeys(): string[] {
  return Object.keys(load().entries).sort()
}

export function getSecretsRecoveryNotice(): SettingsRecoveryNotice | null {
  load()
  return recoveryNotice
}

export function clearSecretsRecoveryNotice(): void {
  recoveryNotice = null
}

export function clearSecretsCache(): void {
  cache = null
  recoveryNotice = null
}
