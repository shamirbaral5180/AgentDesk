import fs from 'node:fs'
import path from 'node:path'
import type { AgentConfig } from '@shared/types'
import { AppError } from '../errors'
import { isPathInside, safeJoin } from '../utils/fs'

const ALWAYS_PROTECTED_DIRS = new Set([
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

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.|$)/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i,
  /\.(pem|key|p12|pfx)$/i
]

export function normalizeRelativePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob)
  let pattern = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          pattern += '(?:.*/)?'
          index += 2
        } else {
          pattern += '.*'
          index += 1
        }
      } else {
        pattern += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      pattern += '[^/]'
      continue
    }
    if (character === '/') {
      pattern += '/'
      continue
    }
    pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`)
}

export function matchesAnyGlob(relativePath: string, globs: string[]): boolean {
  const normalized = normalizeRelativePath(relativePath)
  return globs.some((glob) => globToRegExp(glob).test(normalized))
}

function assertNotProtected(relativePath: string): string {
  let relative = normalizeRelativePath(relativePath)
  if (relative.startsWith('/') && !relative.startsWith('//')) {
    relative = relative.replace(/^\/+/, '')
  }
  if (!relative) {
    throw new AppError('INVALID_PATH', 'A file path is required.')
  }
  if (
    path.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    relative.startsWith('//') ||
    relative.startsWith('\\\\')
  ) {
    throw new AppError('ABSOLUTE_PATH_DENIED', 'File tools require project-relative paths.')
  }
  const segments = relative.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new AppError('PATH_ESCAPE_DENIED', 'The path must stay inside the project.')
  }
  if (
    segments.some(
      (segment) =>
        segment.includes(':') ||
        /[. ]$/.test(segment) ||
        WINDOWS_RESERVED.test(segment)
    )
  ) {
    throw new AppError(
      'PATH_ESCAPE_DENIED',
      'Windows alternate data streams, reserved names, and trailing dots or spaces are blocked.'
    )
  }
  if (segments.some((segment) => ALWAYS_PROTECTED_DIRS.has(segment.toLowerCase()))) {
    throw new AppError(
      'PROTECTED_PATH',
      'That path is private, generated, or excluded from agent file tools.'
    )
  }
  if (isSensitiveFileName(segments[segments.length - 1])) {
    throw new AppError(
      'SENSITIVE_PATH',
      'Credential-like files are blocked, even with approval.'
    )
  }
  return relative
}

export function resolveWritableProjectPath(
  root: string,
  relativePath: string
): { relative: string; absolute: string } {
  const relative = assertNotProtected(relativePath)
  const absolute = safeJoin(root, relative)
  let parent = path.dirname(absolute)
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent)
    if (next === parent) {
      break
    }
    parent = next
  }
  const realParent = fs.realpathSync(parent)
  if (!isPathInside(root, realParent)) {
    throw new AppError(
      'PATH_ESCAPE_DENIED',
      'The target path resolves outside the project through a symlink.'
    )
  }
  if (fs.existsSync(absolute)) {
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      throw new AppError('SYMLINK_DENIED', 'Symbolic links cannot be modified.')
    }
    const realTarget = fs.realpathSync(absolute)
    if (!isPathInside(root, realTarget)) {
      throw new AppError(
        'PATH_ESCAPE_DENIED',
        'The target path resolves outside the project through a link.'
      )
    }
  }
  return { relative, absolute }
}

export function agentScopeDecision(
  agent: AgentConfig,
  relativePath: string
): { inScope: boolean; reason: string } {
  const relative = normalizeRelativePath(relativePath)
  if (matchesAnyGlob(relative, agent.permissions.denyGlobs)) {
    throw new AppError(
      'DENIED_BY_ROLE',
      `${agent.name} is not allowed to modify ${relative}.`
    )
  }
  if (matchesAnyGlob(relative, agent.permissions.writeGlobs)) {
    return {
      inScope: true,
      reason: `${relative} is inside this agent's write scope.`
    }
  }
  return {
    inScope: false,
    reason: `${relative} is inside the project but outside ${agent.name}'s write scope.`
  }
}

export function resolveCommandCwd(
  root: string,
  cwd: string | undefined
): { absolute: string; outsideProject: boolean } {
  const requested = cwd?.trim() ? cwd.trim() : '.'
  const absolute = path.isAbsolute(requested) || /^[A-Za-z]:/.test(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested)
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new AppError('INVALID_CWD', `Working directory not found: ${requested}`)
  }
  return {
    absolute,
    outsideProject: !isPathInside(root, absolute)
  }
}

export function projectRelativeDisplay(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/') || '.'
}
