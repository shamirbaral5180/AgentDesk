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

export function writeFileAtomic(filePath: string, content: string): void {
  const dirPath = path.dirname(filePath)
  ensureDir(dirPath)
  const tempPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  )
  fs.writeFileSync(tempPath, content, 'utf8')
  try {
    fs.renameSync(tempPath, filePath)
  } catch {
    fs.copyFileSync(tempPath, filePath)
    fs.rmSync(tempPath, { force: true })
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n')
}

export function readJsonFile<T>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8')
  return JSON.parse(raw) as T
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
