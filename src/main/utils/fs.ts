import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function directoryExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function fsyncDirectory(dirPath: string): void {
  try {
    const handle = fs.openSync(dirPath, 'r')
    try {
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    // Directory fsync is not supported on every Windows filesystem.
  }
}

export function rotateBackupFiles(filePath: string, keep = 3): string[] {
  const created: string[] = []
  try {
    if (!fs.existsSync(filePath)) {
      return created
    }
    for (let index = keep; index >= 1; index -= 1) {
      const source = index === 1 ? filePath : `${filePath}.${index - 1}.bak`
      const target = `${filePath}.${index}.bak`
      if (fs.existsSync(source)) {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { force: true })
        }
        fs.copyFileSync(source, target)
        created.push(target)
      }
    }
    const primary = `${filePath}.bak`
    fs.copyFileSync(filePath, primary)
    created.push(primary)
  } catch {
    // A backup failure must never prevent the primary write.
  }
  return created
}

export type AtomicWriteOptions = {
  backup?: boolean
  backupCount?: number
}

export function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): void {
  const dirPath = path.dirname(filePath)
  ensureDir(dirPath)
  if (options.backup) {
    rotateBackupFiles(filePath, options.backupCount ?? 3)
  }
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`
  )
  const handle = fs.openSync(tempPath, 'w')
  try {
    fs.writeFileSync(handle, content, 'utf8')
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(tempPath, filePath)
  } catch {
    fs.copyFileSync(tempPath, filePath)
    fs.rmSync(tempPath, { force: true })
  }
  fsyncDirectory(dirPath)
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n', options)
}

export function cleanTextFile(raw: string): string {
  let value = raw
  if (value.charCodeAt(0) === 0xfeff) {
    value = value.slice(1)
  }
  if (value.includes('\0')) {
    throw new Error('File contains NUL bytes and is not a valid text document.')
  }
  return value
}

export function readJsonFile<T>(filePath: string): T {
  const raw = cleanTextFile(fs.readFileSync(filePath, 'utf8'))
  return JSON.parse(raw) as T
}

export function tryReadJsonFile<T>(filePath: string): T | null {
  try {
    return readJsonFile<T>(filePath)
  } catch {
    return null
  }
}

export function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

export function removeFileIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    return
  }
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const root = normalizeForCompare(path.resolve(rootPath))
  const candidate = normalizeForCompare(path.resolve(candidatePath))
  if (root === candidate) {
    return true
  }
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function safeJoin(rootPath: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new Error('Path contains an invalid character')
  }
  const normalizedRelative = relativePath.replaceAll('\\', '/')
  if (path.isAbsolute(normalizedRelative) || /^[A-Za-z]:/.test(normalizedRelative)) {
    throw new Error('Absolute paths are not allowed')
  }
  const target = path.resolve(rootPath, normalizedRelative)
  if (!isPathInside(rootPath, target)) {
    throw new Error('Path escapes the project root')
  }
  return target
}

export function timestampSlug(date = new Date()): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-')
}

export function toPortablePath(basePath: string, targetPath: string): string {
  const relative = path.relative(basePath, targetPath)
  return relative.split(path.sep).join('/')
}

export function directorySize(dirPath: string): number {
  let total = 0
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += directorySize(target)
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(target).size
        } catch {
          // The file may have disappeared during the scan.
        }
      }
    }
  } catch {
    return total
  }
  return total
}
