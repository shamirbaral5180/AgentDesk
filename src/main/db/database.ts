import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../config/logger'
import { ensureDir, timestampSlug } from '../utils/fs'
import { MIGRATIONS } from './migrations'

const log = createLogger('database')

export type ProjectDatabase = {
  db: DatabaseSync
  path: string
  backupsDir: string
  maxBackups: number
  close: () => void
}

export type DatabaseBackup = {
  path: string
  bytes: number
  createdAt: number
  version: number
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined
  if (!row?.value) {
    return 0
  }
  const parsed = Number.parseInt(row.value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(version))
}

export function quickCheck(db: DatabaseSync): { ok: boolean; result: string } {
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    const values = rows.map((row) => String(Object.values(row)[0] ?? ''))
    const result = values.join('; ') || 'ok'
    return { ok: values.every((value) => value.toLowerCase() === 'ok'), result }
  } catch (error) {
    return {
      ok: false,
      result: error instanceof Error ? error.message : String(error)
    }
  }
}

export function integrityCheck(db: DatabaseSync): { ok: boolean; result: string } {
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
    const values = rows.map((row) => String(Object.values(row)[0] ?? ''))
    const result = values.join('; ') || 'ok'
    return { ok: values.every((value) => value.toLowerCase() === 'ok'), result }
  } catch (error) {
    return {
      ok: false,
      result: error instanceof Error ? error.message : String(error)
    }
  }
}

export function listDatabaseBackups(backupsDir: string): DatabaseBackup[] {
  if (!fs.existsSync(backupsDir)) {
    return []
  }
  try {
    return fs
      .readdirSync(backupsDir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const fullPath = path.join(backupsDir, name)
        const stat = fs.statSync(fullPath)
        const match = /^agentdesk-v(\d+)-/i.exec(name)
        return {
          path: fullPath,
          bytes: stat.size,
          createdAt: stat.mtimeMs,
          version: match ? Number.parseInt(match[1], 10) : 0
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

function rotateDatabaseBackups(backupsDir: string, keep: number): void {
  const backups = listDatabaseBackups(backupsDir)
  for (const backup of backups.slice(Math.max(keep, 1))) {
    try {
      fs.rmSync(backup.path, { force: true })
    } catch (error) {
      log.warn('Could not remove old database backup', { path: backup.path, error })
    }
  }
}

export function backupDatabase(input: {
  db: DatabaseSync
  dbPath: string
  backupsDir: string
  version: number
  keep?: number
  label?: string
}): string {
  ensureDir(input.backupsDir)
  try {
    input.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (error) {
    log.warn('Could not checkpoint database before backup', { error })
  }
  const name = `agentdesk-v${input.version}-${timestampSlug()}${
    input.label ? `-${input.label}` : ''
  }.db`
  const backupPath = path.join(input.backupsDir, name)
  fs.copyFileSync(input.dbPath, backupPath)
  rotateDatabaseBackups(input.backupsDir, input.keep ?? 5)
  log.info('Created database backup', { backupPath })
  return backupPath
}

export function restoreLatestBackup(input: {
  dbPath: string
  backupsDir: string
}): string | null {
  const latest = listDatabaseBackups(input.backupsDir)[0]
  if (!latest) {
    return null
  }
  for (const suffix of ['-wal', '-shm']) {
    const target = `${input.dbPath}${suffix}`
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true })
    }
  }
  const quarantine = `${input.dbPath}.corrupt-${timestampSlug()}`
  try {
    if (fs.existsSync(input.dbPath)) {
      fs.copyFileSync(input.dbPath, quarantine)
    }
  } catch (error) {
    log.warn('Could not quarantine corrupt database', { error })
  }
  fs.copyFileSync(latest.path, input.dbPath)
  log.warn('Restored database from backup', {
    backupPath: latest.path,
    quarantine
  })
  return latest.path
}

function openDatabase(dbPath: string, backupsDir: string, maxBackups: number): ProjectDatabase {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
  )

  const schemaVersion = readSchemaVersion(db)
  for (const migration of MIGRATIONS) {
    if (migration.version <= schemaVersion) {
      continue
    }
    if (migration.version > schemaVersion && schemaVersion > 0) {
      backupDatabase({
        db,
        dbPath,
        backupsDir,
        version: schemaVersion,
        keep: maxBackups,
        label: `pre-v${migration.version}`
      })
      break
    }
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= readSchemaVersion(db)) {
      continue
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      writeSchemaVersion(db, migration.version)
      db.exec('COMMIT')
      log.info('Applied database migration', { version: migration.version })
    } catch (error) {
      db.exec('ROLLBACK')
      db.close()
      throw error
    }
  }

  const foreign = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (foreign.length > 0) {
    log.warn('Database foreign-key check reported rows', { rows: foreign.length })
  }

  return {
    db,
    path: dbPath,
    backupsDir,
    maxBackups,
    close: () => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // Closing should continue even if the checkpoint fails.
      }
      db.close()
    }
  }
}

export function openProjectDatabase(
  dbPath: string,
  backupsDir: string,
  maxBackups = 5
): ProjectDatabase {
  ensureDir(path.dirname(dbPath))
  ensureDir(backupsDir)
  const existed = fs.existsSync(dbPath)

  let database = openDatabase(dbPath, backupsDir, maxBackups)
  const check = quickCheck(database.db)
  if (existed && !check.ok) {
    log.error('Database quick check failed; attempting restore', {
      dbPath,
      result: check.result
    })
    try {
      database.db.close()
    } catch {
      // Continue with restoration.
    }
    const restored = restoreLatestBackup({ dbPath, backupsDir })
    if (!restored) {
      throw new Error(
        `The project database is corrupt and no backup is available. ${check.result}`
      )
    }
    database = openDatabase(dbPath, backupsDir, maxBackups)
    const after = quickCheck(database.db)
    if (!after.ok) {
      database.db.close()
      throw new Error(
        `The restored project database is still corrupt. ${after.result}`
      )
    }
  }

  return database
}

export function listTableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}
