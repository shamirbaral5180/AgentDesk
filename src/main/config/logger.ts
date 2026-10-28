import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getAppPaths } from './appPaths'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|cookie|credential)/i
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/g

function sanitizeString(value: string): string {
  return value.replace(SECRET_PATTERN, '[redacted]').slice(0, 8000)
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return '[depth-limit]'
  }
  if (value === null || value === undefined) {
    return value
  }
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1))
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1)
    }
    return result
  }
  return String(value)
}

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(getAppPaths().logsDir, `app-${date}.log`)
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const record = {
    time: new Date().toISOString(),
    level,
    scope,
    message: sanitizeString(message),
    meta: meta === undefined ? undefined : redact(meta)
  }

  const line = JSON.stringify(record) + '\n'

  try {
    fs.appendFileSync(logFilePath(), line, 'utf8')
  } catch (error) {
    console.error('Failed to write log file', error)
  }

  if (!app.isPackaged || level === 'error' || level === 'warn') {
    const method = level === 'debug' ? 'log' : level
    console[method](`[${scope}] ${message}`, meta ?? '')
  }
}

export function redactForDisplay(value: unknown): unknown {
  return redact(value)
}

export type Logger = {
  debug: (message: string, meta?: unknown) => void
  info: (message: string, meta?: unknown) => void
  warn: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, meta) => writeLog('debug', scope, message, meta),
    info: (message, meta) => writeLog('info', scope, message, meta),
    warn: (message, meta) => writeLog('warn', scope, message, meta),
    error: (message, meta) => writeLog('error', scope, message, meta)
  }
}

export const logger = createLogger('app')
