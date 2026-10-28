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
  close: () => void
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

function backupDatabase(db: DatabaseSync, dbPath: string, backupsDir: string, version: number): void {
  ensureDir(backupsDir)
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (error) {
    log.warn('Could not checkpoint database before backup', { error })
  }
  const backupPath = path.join(
    backupsDir,
    `agentdesk-v${version}-${timestampSlug()}.db`
  )
  fs.copyFileSync(dbPath, backupPath)
  log.info('Created database backup before migration', { backupPath })
}

export function openProjectDatabase(dbPath: string, backupsDir: string): ProjectDatabase {
  ensureDir(path.dirname(dbPath))
  const existed = fs.existsSync(dbPath)
  const db = new DatabaseSync(dbPath)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
  )

  const currentVersion = readSchemaVersion(db)
  const latestVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

  if (existed && currentVersion > 0 && currentVersion < latestVersion) {
    backupDatabase(db, dbPath, backupsDir, currentVersion)
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
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

  return {
    db,
    path: dbPath,
    close: () => {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        return
      }
      db.close()
    }
  }
}

export function listTableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  return rows.map((row) => row.name)
}
