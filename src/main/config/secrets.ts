import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'
import { z } from 'zod'
import { getAppPaths } from './appPaths'
import { createLogger } from './logger'
import { readJsonFile, timestampSlug, writeJsonAtomic } from '../utils/fs'

const log = createLogger('secrets')

const secretFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.string())
})

type SecretFile = z.infer<typeof secretFileSchema>

let cache: SecretFile | null = null

function secretsPath(): string {
  return getAppPaths().secretsPath
}

function load(): SecretFile {
  if (cache) {
    return cache
  }
  const filePath = secretsPath()
  if (!fs.existsSync(filePath)) {
    cache = { version: 1, entries: {} }
    return cache
  }
  try {
    cache = secretFileSchema.parse(readJsonFile<unknown>(filePath))
    return cache
  } catch (error) {
    const backupPath = path.join(
      path.dirname(filePath),
      `secrets.invalid-${timestampSlug()}.bin`
    )
    try {
      fs.copyFileSync(filePath, backupPath)
    } catch {
      log.warn('Could not back up invalid secrets file')
    }
    cache = { version: 1, entries: {} }
    log.error('Invalid secrets file; reset to empty', { backupPath, error })
    return cache
  }
}

function persist(value: SecretFile): void {
  writeJsonAtomic(secretsPath(), value)
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
    log.error('Could not decrypt secret', { key, error })
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
