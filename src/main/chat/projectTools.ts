import fs from 'node:fs'
import path from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type {
  AgentConfig,
  AgentTodo,
  AgentTodoStatus,
  ApprovalActionType,
  ApprovalRisk,
  ApprovalScope,
  ChatMode,
  ChatToolDefinition,
  MeetingMessage,
  ProjectPermissionDefaults
} from '@shared/types'
import {
  listManagedProcesses,
  runCommand,
  stopManagedProcess
} from '../commands/commandRunner'
import {
  assessCommand,
  commandActionKey
} from '../commands/commandPolicy'
import { hashBuffer, recordChange, snapshotFile } from '../changes/changeService'
import { memorySummaryForTool } from '../memory/memoryService'
import { isPathInside, safeJoin, writeFileAtomic } from '../utils/fs'
import {
  isSensitiveFileName,
  matchesAnyGlob,
  normalizeRelativePath,
  projectRelativeDisplay,
  resolveCommandCwd,
  resolveWritableProjectPath
} from './pathPolicy'

const IGNORED_DIRS = new Set([
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
  'venv',
  'bin',
  'obj'
])

const MAX_READ_BYTES = 1_500_000
const MAX_READ_CHARS = 30_000
const MAX_SEARCH_BYTES = 512_000
const MAX_SEARCH_RESULTS = 60
const MAX_SEARCH_FILES = 5_000
const MAX_COMMAND_OUTPUT = 16_000

type Entry = {
  path: string
  type: 'file' | 'dir'
  size: number | null
}

export type AgentToolRuntime = {
  mode: ChatMode
  sessionId: string
  runId: string
  agentId: string
  meetingId?: string
  taskId?: string
  turnId?: string
  assertWriteAllowed?: (relativePath: string) => void
  requestApproval: (input: {
    actionType: ApprovalActionType
    actionKey: string
    risk: ApprovalRisk
    reason: string
    payload: Record<string, unknown>
    neverGrant?: boolean
  }) => Promise<{
    decision: 'approved' | 'denied'
    scope?: ApprovalScope
  }>
  emitOutput: (
    toolCallId: string,
    stream: 'stdout' | 'stderr' | 'system',
    text: string
  ) => void
  postMessage?: (input: {
    text: string
    targetAgentId?: string | null
    kind?: 'message' | 'notify' | 'question'
  }) => MeetingMessage | null
  requestFromAgent?: (input: {
    targetAgentId: string
    title: string
    description: string
    acceptanceCriteria?: string
    fileGlobs?: string[]
    priority?: number
  }) => { taskId: string; title: string; targetAgentId: string } | null
  askBoss?: (input: {
    question: string
    options: string[]
  }) => Promise<string>
  readTodos?: () => AgentTodo[]
  writeTodos?: (
    items: Array<{ content: string; status?: AgentTodoStatus }>
  ) => AgentTodo[]
}

export type AgentToolBundle = {
  tools: ToolSet
  definitions: ChatToolDefinition[]
  names: string[]
  warnings: string[]
}

function normalizeRelative(input: string): string {
  const normalized = normalizeRelativePath(input)
  if (normalized.startsWith('/') && !normalized.startsWith('//')) {
    return normalized.replace(/^\/+/, '')
  }
  return normalized
}

function assertUsableRelative(relativePath: string): string {
  const relative = normalizeRelative(relativePath)
  if (!relative) {
    return ''
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new Error('Absolute paths are not allowed. Use a project-relative path.')
  }
  const segments = relative.split('/')
  if (segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error('The path must stay inside the project.')
  }
  if (segments[0] === '.agentdesk' || segments[0] === '.git') {
    throw new Error('That path is private to AgentDesk or git and is not readable.')
  }
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) {
    throw new Error('That path is excluded from agent inspection.')
  }
  if (isSensitiveFileName(segments[segments.length - 1])) {
    throw new Error('Credential-like files are excluded from repository tools.')
  }
  return relative
}

function resolveProjectPath(root: string, relativePath: string): {
  relative: string
  absolute: string
} {
  const relative = assertUsableRelative(relativePath)
  const absolute = safeJoin(root, relative)
  if (!fs.existsSync(absolute)) {
    throw new Error(`Path not found: ${relative || '.'}`)
  }
  const realPath = fs.realpathSync(absolute)
  if (!isPathInside(root, realPath)) {
    throw new Error('The path resolves outside the project.')
  }
  return { relative, absolute }
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  return sample.includes(0)
}

function toRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function walkEntries(
  root: string,
  start: string,
  maxDepth: number,
  maxEntries: number
): { entries: Entry[]; truncated: boolean } {
  const entries: Entry[] = []
  let truncated = false
  const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }]

  while (queue.length > 0) {
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    const current = queue.shift()
    if (!current) {
      break
    }
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) {
        return a.isDirectory() ? -1 : 1
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true
        break
      }
      if (dirent.isSymbolicLink()) {
        continue
      }
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name) || dirent.name.startsWith('.')) {
          continue
        }
        const child = path.join(current.dir, dirent.name)
        entries.push({
          path: toRelative(root, child),
          type: 'dir',
          size: null
        })
        if (current.depth + 1 < maxDepth) {
          queue.push({ dir: child, depth: current.depth + 1 })
        }
        continue
      }
      if (!dirent.isFile() || isSensitiveFileName(dirent.name)) {
        continue
      }
      const child = path.join(current.dir, dirent.name)
      let size: number | null = null
      try {
        size = fs.statSync(child).size
      } catch {
        size = null
      }
      entries.push({
        path: toRelative(root, child),
        type: 'file',
        size
      })
    }
  }

  return { entries, truncated }
}

function readFileTool(
  root: string,
  input: { path: string; startLine?: number; endLine?: number }
): Record<string, unknown> {
  const { relative, absolute } = resolveProjectPath(root, input.path)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${relative}`)
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File is too large to read (${Math.round(stat.size / 1024)} KB). Read a smaller file or search it instead.`
    )
  }
  const buffer = fs.readFileSync(absolute)
  if (isProbablyBinary(buffer)) {
    throw new Error('Binary files are not readable with this tool.')
  }
  const raw = buffer.toString('utf8')
  const allLines = raw.split(/\r?\n/)
  const totalLines = allLines.length
  const startLine = Math.max(1, input.startLine ?? 1)
  const endLine = Math.min(totalLines, input.endLine ?? totalLines)
  if (startLine > endLine) {
    throw new Error('startLine must be less than or equal to endLine.')
  }
  const selected = allLines.slice(startLine - 1, endLine).join('\n')
  const truncated = selected.length > MAX_READ_CHARS
  const content = truncated
    ? `${selected.slice(0, MAX_READ_CHARS)}\n\n[truncated; request a narrower line range]`
    : selected
  return {
    path: relative,
    size: stat.size,
    totalLines,
    startLine,
    endLine,
    truncated,
    content
  }
}

function searchProject(
  root: string,
  input: {
    query: string
    caseSensitive?: boolean
    maxResults?: number
  }
): Record<string, unknown> {
  const query = input.query.trim()
  if (query.length < 2) {
    throw new Error('Search queries must be at least 2 characters.')
  }
  const maxResults = Math.min(
    Math.max(input.maxResults ?? 30, 1),
    MAX_SEARCH_RESULTS
  )
  const needle = input.caseSensitive ? query : query.toLowerCase()
  const matches: Array<{
    path: string
    line: number
    column: number
    snippet: string
  }> = []
  let filesScanned = 0
  let truncated = false
  const queue: string[] = [root]

  while (queue.length > 0 && filesScanned < MAX_SEARCH_FILES && !truncated) {
    const current = queue.shift()
    if (!current) {
      break
    }
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (filesScanned >= MAX_SEARCH_FILES) {
        truncated = true
        break
      }
      if (dirent.isSymbolicLink()) {
        continue
      }
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name) || dirent.name.startsWith('.')) {
          continue
        }
        queue.push(path.join(current, dirent.name))
        continue
      }
      if (!dirent.isFile() || isSensitiveFileName(dirent.name)) {
        continue
      }
      const absolute = path.join(current, dirent.name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolute)
      } catch {
        continue
      }
      if (stat.size > MAX_SEARCH_BYTES) {
        continue
      }
      filesScanned += 1
      let buffer: Buffer
      try {
        buffer = fs.readFileSync(absolute)
      } catch {
        continue
      }
      if (isProbablyBinary(buffer)) {
        continue
      }
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const haystack = input.caseSensitive ? line : line.toLowerCase()
        const column = haystack.indexOf(needle)
        if (column === -1) {
          continue
        }
        const start = Math.max(0, column - 70)
        const end = Math.min(line.length, column + needle.length + 90)
        matches.push({
          path: toRelative(root, absolute),
          line: index + 1,
          column: column + 1,
          snippet: line.slice(start, end).trim()
        })
        if (matches.length >= maxResults) {
          truncated = true
          break
        }
      }
      if (truncated) {
        break
      }
    }
  }

  return {
    query,
    caseSensitive: Boolean(input.caseSensitive),
    filesScanned,
    truncated,
    matches
  }
}

function globProject(
  root: string,
  input: { pattern: string; limit?: number }
): Record<string, unknown> {
  const pattern = normalizeRelative(input.pattern)
  if (!pattern) {
    throw new Error('A glob pattern is required.')
  }
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000)
  const walked = walkEntries(root, root, 12, 5000)
  const matches = walked.entries
    .filter((entry) => entry.type === 'file' && matchesAnyGlob(entry.path, [pattern]))
    .slice(0, limit)
    .map((entry) => entry.path)
  return {
    pattern,
    count: matches.length,
    truncated: walked.truncated || matches.length >= limit,
    matches
  }
}

function grepProject(
  root: string,
  input: {
    pattern: string
    include?: string
    caseSensitive?: boolean
    maxResults?: number
    contextLines?: number
  }
): Record<string, unknown> {
  const raw = input.pattern
  if (!raw || raw.length < 1) {
    throw new Error('A search pattern is required.')
  }
  let expression: RegExp
  try {
    expression = new RegExp(raw, input.caseSensitive ? 'g' : 'gi')
  } catch {
    throw new Error('The pattern is not a valid regular expression.')
  }
  const include = input.include ? normalizeRelative(input.include) : null
  const maxResults = Math.min(Math.max(input.maxResults ?? 40, 1), 120)
  const contextLines = Math.min(Math.max(input.contextLines ?? 0, 0), 3)
  const matches: Array<{
    path: string
    line: number
    column: number
    snippet: string
  }> = []
  let filesScanned = 0
  let truncated = false
  const queue: string[] = [root]
  while (queue.length > 0 && filesScanned < MAX_SEARCH_FILES && !truncated) {
    const current = queue.shift()
    if (!current) {
      break
    }
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      if (filesScanned >= MAX_SEARCH_FILES) {
        truncated = true
        break
      }
      if (dirent.isSymbolicLink()) {
        continue
      }
      if (dirent.isDirectory()) {
        if (IGNORED_DIRS.has(dirent.name) || dirent.name.startsWith('.')) {
          continue
        }
        queue.push(path.join(current, dirent.name))
        continue
      }
      if (!dirent.isFile() || isSensitiveFileName(dirent.name)) {
        continue
      }
      const absolute = path.join(current, dirent.name)
      const relative = toRelative(root, absolute)
      if (include && !matchesAnyGlob(relative, [include])) {
        continue
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(absolute)
      } catch {
        continue
      }
      if (stat.size > MAX_SEARCH_BYTES) {
        continue
      }
      filesScanned += 1
      let buffer: Buffer
      try {
        buffer = fs.readFileSync(absolute)
      } catch {
        continue
      }
      if (isProbablyBinary(buffer)) {
        continue
      }
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0
        const match = expression.exec(lines[index])
        if (!match) {
          continue
        }
        const startLine = Math.max(0, index - contextLines)
        const endLine = Math.min(lines.length - 1, index + contextLines)
        matches.push({
          path: relative,
          line: index + 1,
          column: match.index + 1,
          snippet: lines.slice(startLine, endLine + 1).join('\n').trim()
        })
        if (matches.length >= maxResults) {
          truncated = true
          break
        }
      }
      if (truncated) {
        break
      }
    }
  }
  return {
    pattern: raw,
    include: include ?? '**/*',
    filesScanned,
    truncated,
    matches
  }
}

function applyPatchToText(
  before: string,
  patch: string
): string {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  let result = before
  let index = 0
  while (index < lines.length) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[index].trim())
    if (header) {
      index += 1
      continue
    }
    const hunk = /^@@\s*(.*?)\s*@@/.exec(lines[index])
    if (!hunk) {
      index += 1
      continue
    }
    index += 1
    const removed: string[] = []
    const added: string[] = []
    while (index < lines.length && !/^@@\s*(.*?)\s*@@/.test(lines[index])) {
      const line = lines[index]
      if (line.startsWith('-')) {
        removed.push(line.slice(1))
      } else if (line.startsWith('+')) {
        added.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        removed.push(line.slice(1))
        added.push(line.slice(1))
      }
      index += 1
    }
    const oldBlock = removed.join('\n')
    const newBlock = added.join('\n')
    if (!oldBlock) {
      result = `${result.replace(/\s*$/, '')}\n${newBlock}\n`
      continue
    }
    const occurrences = result.split(oldBlock).length - 1
    if (occurrences === 0) {
      throw new Error('apply_patch could not find the removed lines. Read the file and retry.')
    }
    if (occurrences > 1) {
      throw new Error('apply_patch matched more than one location. Include more context.')
    }
    result = result.replace(oldBlock, newBlock)
  }
  return result
}

function toolEnabled(agent: AgentConfig, names: string[]): boolean {
  return names.some((name) => agent.permissions.tools.includes(name))
}

async function approveFileAction(input: {
  agent: AgentConfig
  relativePath: string
  actionType: ApprovalActionType
  actionKey: string
  risk: ApprovalRisk
  reason: string
  payload: Record<string, unknown>
  runtime: AgentToolRuntime
  permissions: ProjectPermissionDefaults
}): Promise<void> {
  if (input.permissions.autoWriteInsideRepo) {
    return
  }
  const result = await input.runtime.requestApproval({
    actionType: input.actionType,
    actionKey: input.actionKey,
    risk: input.risk,
    reason: `Project policy requires approval for this write: ${input.relativePath}`,
    payload: input.payload
  })
  if (result.decision !== 'approved') {
    throw new Error('The Boss denied this file change.')
  }
}

function previewText(value: string, limit = 1200): string {
  return value.length > limit ? `${value.slice(0, limit)}\nâ€¦` : value
}

export function createAgentTools(input: {
  root: string
  agent: AgentConfig
  runtime: AgentToolRuntime
  permissions: ProjectPermissionDefaults
}): AgentToolBundle {
  const { root, agent, runtime, permissions } = input
  const warnings: string[] = []
  const readEnabled = toolEnabled(agent, ['read', 'list'])
  const searchEnabled = toolEnabled(agent, ['search', 'read'])
  const writeEnabled = toolEnabled(agent, ['write'])
  const commandEnabled = toolEnabled(agent, ['run_command'])
  const buildMode = runtime.mode === 'build'
  const tools: ToolSet = {}

  if (readEnabled) {
    tools.list_files = tool({
      description:
        'List files and folders inside the project. Excludes node_modules, build output, .git, .agentdesk, credential files, and symlinks.',
      inputSchema: z.object({
        path: z
          .string()
          .max(1024)
          .optional()
          .describe('Project-relative folder path. Omit for the repository root.'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe('Folder recursion depth, 1 to 4. Defaults to 2.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(300)
          .optional()
          .describe('Maximum entries to return. Defaults to 200.')
      }),
      execute: async ({ path: relativePath, depth, limit }) => {
        const { relative, absolute } = resolveProjectPath(root, relativePath ?? '')
        const stat = fs.statSync(absolute)
        if (!stat.isDirectory()) {
          throw new Error(`Not a directory: ${relative || '.'}`)
        }
        const result = walkEntries(root, absolute, depth ?? 2, limit ?? 200)
        return {
          path: relative || '.',
          count: result.entries.length,
          truncated: result.truncated,
          entries: result.entries
        }
      }
    })

    tools.read_file = tool({
      description:
        'Read a UTF-8 text file from the project. Supports optional 1-based line ranges. Excludes credential-like files, binary files, and private AgentDesk data.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048).describe('Project-relative file path.'),
        startLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('First line to return, 1-based.'),
        endLine: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Last line to return, inclusive.')
      }),
      execute: async ({ path: relativePath, startLine, endLine }) =>
        readFileTool(root, {
          path: relativePath,
          startLine,
          endLine
        })
    })
  } else {
    warnings.push('The read permission is disabled for this agent.')
  }

  if (agent.permissions.tools.includes('memory')) {
    tools.recall_memory = tool({
      description:
        'Search this agent personal memory and the shared project memory from earlier sessions. Use it when the Boss asks what happened before, what was decided, or what remains unfinished.',
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .max(500)
          .describe('What to recall, e.g. "login decision" or "files changed".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum memory entries to return. Defaults to 5.')
      }),
      execute: async ({ query, limit }) =>
        memorySummaryForTool({
          agentId: agent.id,
          query,
          limit
        })
    })
  } else {
    warnings.push('The memory permission is disabled for this agent.')
  }

  if (searchEnabled) {
    tools.search_project = tool({
      description:
        'Search project text files for a literal string. Case-insensitive by default. Returns file, line, column, and a short snippet.',
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .max(200)
          .describe('Literal text to find. Regular expressions are not supported.'),
        caseSensitive: z
          .boolean()
          .optional()
          .describe('Match case exactly. Defaults to false.'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('Maximum matches to return. Defaults to 30.')
      }),
      execute: async ({ query, caseSensitive, maxResults }) =>
        searchProject(root, {
          query,
          caseSensitive,
          maxResults
        })
    })
  } else {
    warnings.push('The search permission is disabled for this agent.')
  }

  if (buildMode && writeEnabled) {
    tools.write_file = tool({
      description:
        'Create or overwrite a UTF-8 text file inside the project. A content-addressed snapshot is taken before the change. Writes outside the agent write scope may require Boss approval.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048).describe('Project-relative file path.'),
        content: z.string().max(2_000_000).describe('Complete new file content.')
      }),
      execute: async ({ path: relativePath, content }, options) => {
        const { relative, absolute } = resolveWritableProjectPath(root, relativePath)
        runtime.assertWriteAllowed?.(relative)
        const existing = fs.existsSync(absolute)
        if (existing && !fs.statSync(absolute).isFile()) {
          throw new Error(`Not a regular file: ${relative}`)
        }
        if (existing && fs.readFileSync(absolute).toString('utf8') === content) {
          return {
            path: relative,
            changed: false,
            bytes: Buffer.byteLength(content, 'utf8')
          }
        }
        await approveFileAction({
          agent,
          relativePath: relative,
          actionType: 'write_file',
          actionKey: `write_file:${relative}`,
          risk: 'medium',
          reason: `Write ${relative}`,
          payload: {
            operation: 'write_file',
            path: relative,
            bytes: Buffer.byteLength(content, 'utf8'),
            preview: previewText(content)
          },
          runtime,
          permissions
        })
        const snapshot = snapshotFile(runtime.sessionId, relative, 'before write_file')
        ensureWriteDir(absolute)
        writeFileAtomic(absolute, content)
        const afterHash = hashBuffer(Buffer.from(content, 'utf8'))
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'write',
          path: relative,
          beforeHash: snapshot.objectHash,
          afterHash,
          snapshotId: snapshot.id,
          metadata: {
            bytes: Buffer.byteLength(content, 'utf8'),
            created: !snapshot.existed,
            toolCallId: options.toolCallId
          }
        })
        return {
          path: relative,
          changed: true,
          created: !snapshot.existed,
          bytes: Buffer.byteLength(content, 'utf8'),
          changeId: change.id
        }
      }
    })

    tools.patch_file = tool({
      description:
        'Replace exactly one occurrence of oldText with newText in a project text file. A snapshot is taken before the change. Use this for focused edits instead of rewriting whole files.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048).describe('Project-relative file path.'),
        oldText: z.string().min(1).max(200_000).describe('Exact text to replace.'),
        newText: z.string().max(200_000).describe('Replacement text.')
      }),
      execute: async ({ path: relativePath, oldText, newText }, options) => {
        const { relative, absolute } = resolveWritableProjectPath(root, relativePath)
        runtime.assertWriteAllowed?.(relative)
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          throw new Error(`File not found: ${relative}`)
        }
        const before = fs.readFileSync(absolute, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (occurrences === 0) {
          throw new Error('oldText was not found in the file. Read the file again and retry.')
        }
        if (occurrences > 1) {
          throw new Error(
            `oldText occurs ${occurrences} times. Include more surrounding context so it matches exactly once.`
          )
        }
        const after = before.replace(oldText, newText)
        await approveFileAction({
          agent,
          relativePath: relative,
          actionType: 'patch_file',
          actionKey: `patch_file:${relative}`,
          risk: 'medium',
          reason: `Patch ${relative}`,
          payload: {
            operation: 'patch_file',
            path: relative,
            oldText: previewText(oldText),
            newText: previewText(newText)
          },
          runtime,
          permissions
        })
        const snapshot = snapshotFile(runtime.sessionId, relative, 'before patch_file')
        writeFileAtomic(absolute, after)
        const afterHash = hashBuffer(Buffer.from(after, 'utf8'))
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'patch',
          path: relative,
          beforeHash: snapshot.objectHash,
          afterHash,
          snapshotId: snapshot.id,
          metadata: { toolCallId: options.toolCallId }
        })
        return {
          path: relative,
          changed: true,
          changeId: change.id
        }
      }
    })

    tools.delete_path = tool({
      description:
        'Delete one regular file inside the project. A snapshot is taken first so the Boss can revert it. Directories are not deleted by this tool.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048).describe('Project-relative file path.')
      }),
      execute: async ({ path: relativePath }, options) => {
        const { relative, absolute } = resolveWritableProjectPath(root, relativePath)
        runtime.assertWriteAllowed?.(relative)
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          throw new Error(`File not found: ${relative}`)
        }
        await approveFileAction({
          agent,
          relativePath: relative,
          actionType: 'delete_path',
          actionKey: `delete_path:${relative}`,
          risk: 'high',
          reason: `Delete ${relative}`,
          payload: {
            operation: 'delete_path',
            path: relative
          },
          runtime,
          permissions
        })
        const snapshot = snapshotFile(runtime.sessionId, relative, 'before delete_path')
        fs.rmSync(absolute, { force: true })
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'delete',
          path: relative,
          beforeHash: snapshot.objectHash,
          afterHash: '',
          snapshotId: snapshot.id,
          metadata: { toolCallId: options.toolCallId }
        })
        return {
          path: relative,
          deleted: true,
          changeId: change.id
        }
      }
    })

    tools.move_path = tool({
      description:
        'Move or rename one regular file inside the project. The destination must not exist. Both sides are snapshotted so the move can be reverted.',
      inputSchema: z.object({
        from: z.string().min(1).max(2048).describe('Current project-relative file path.'),
        to: z.string().min(1).max(2048).describe('New project-relative file path.')
      }),
      execute: async ({ from, to }, options) => {
        const source = resolveWritableProjectPath(root, from)
        const target = resolveWritableProjectPath(root, to)
        runtime.assertWriteAllowed?.(source.relative)
        runtime.assertWriteAllowed?.(target.relative)
        if (!fs.existsSync(source.absolute) || !fs.statSync(source.absolute).isFile()) {
          throw new Error(`File not found: ${source.relative}`)
        }
        if (fs.existsSync(target.absolute)) {
          throw new Error(`Destination already exists: ${target.relative}`)
        }
        if (!permissions.autoWriteInsideRepo) {
          const result = await runtime.requestApproval({
            actionType: 'move_path',
            actionKey: `move_path:${source.relative}->${target.relative}`,
            risk: 'medium',
            reason: 'Project policy requires approval for file moves.',
            payload: {
              operation: 'move_path',
              from: source.relative,
              to: target.relative
            }
          })
          if (result.decision !== 'approved') {
            throw new Error('The Boss denied this file move.')
          }
        }

        const sourceSnapshot = snapshotFile(
          runtime.sessionId,
          source.relative,
          'before move_path source'
        )
        const targetSnapshot = snapshotFile(
          runtime.sessionId,
          target.relative,
          'before move_path target'
        )
        ensureWriteDir(target.absolute)
        fs.renameSync(source.absolute, target.absolute)
        const afterHash = hashBuffer(fs.readFileSync(target.absolute))
        const removed = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'delete',
          path: source.relative,
          beforeHash: sourceSnapshot.objectHash,
          afterHash: '',
          snapshotId: sourceSnapshot.id,
          metadata: {
            movedTo: target.relative,
            toolCallId: options.toolCallId
          }
        })
        const created = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'write',
          path: target.relative,
          beforeHash: targetSnapshot.objectHash,
          afterHash,
          snapshotId: targetSnapshot.id,
          metadata: {
            movedFrom: source.relative,
            toolCallId: options.toolCallId
          }
        })
        return {
          from: source.relative,
          to: target.relative,
          moved: true,
          changeIds: [removed.id, created.id]
        }
      }
    })
  } else if (buildMode && !writeEnabled) {
    warnings.push('Write tools are disabled by this agent\'s permissions.')
  }

  if (buildMode && typeof runtime.readTodos === 'function' && typeof runtime.writeTodos === 'function') {
    tools.todo_write = tool({
      description:
        'Replace your personal task checklist for this Build meeting. Use it to keep a short flow of concrete steps. Only you see your list.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              content: z.string().min(1).max(300),
              status: z.enum(['pending', 'in_progress', 'done', 'blocked']).optional()
            })
          )
          .max(30)
      }),
      execute: async ({ items }) => ({
        todos: runtime.writeTodos!(items)
      })
    })
    tools.todo_read = tool({
      description: 'Read your personal task checklist for this Build meeting.',
      inputSchema: z.object({}),
      execute: async () => ({ todos: runtime.readTodos!() })
    })
  }

  if (buildMode) {
    if (typeof runtime.postMessage === 'function') {
      tools.post_message = tool({
        description:
          'Post a message to the shared team channel. Everyone sees it. Use it to coordinate, report progress, or notify another agent. Only the Coordinator replies to the Boss.',
        inputSchema: z.object({
          content: z.string().min(1).max(4000),
          targetAgentId: z
            .string()
            .max(200)
            .optional()
            .describe('Optional agent id to address directly, e.g. backend.'),
          kind: z.enum(['message', 'notify']).optional()
        }),
        execute: async ({ content, targetAgentId, kind }) => ({
          message: runtime.postMessage!({
            text: content,
            targetAgentId: targetAgentId ?? null,
            kind: kind ?? 'message'
          })
        })
      })
    }

    if (typeof runtime.requestFromAgent === 'function') {
      tools.request_from_agent = tool({
        description:
          'Ask another agent to build something you depend on. This creates a high-priority task for them, posts a request in the team channel, and puts your current task into waiting mode until they finish. Use it instead of stalling or writing their part yourself.',
        inputSchema: z.object({
          targetAgentId: z.string().min(1).max(200).describe('Agent id, e.g. backend.'),
          title: z.string().min(3).max(160),
          description: z.string().min(3).max(4000),
          acceptanceCriteria: z.string().max(1000).optional(),
          fileGlobs: z.array(z.string().max(512)).max(30).optional(),
          priority: z.number().int().min(1).max(3).optional()
        }),
        execute: async (input) => {
          const request = runtime.requestFromAgent!(input)
          if (!request) {
            throw new Error('The request could not be created.')
          }
          return {
            ...request,
            waiting: true,
            note: 'Your current task is now waiting. End this turn and resume after the request is completed.'
          }
        }
      })
    }

    if (typeof runtime.askBoss === 'function') {
      tools.ask_boss = tool({
        description:
          'Ask the Boss for a product decision when you are genuinely blocked by ambiguity. Provide 2 to 6 concrete options. The Coordinator presents the question, and this turn waits for the Boss answer.',
        inputSchema: z.object({
          question: z.string().min(5).max(1000),
          options: z.array(z.string().min(1).max(200)).min(2).max(6)
        }),
        execute: async (input) => ({
          answer: await runtime.askBoss!(input)
        })
      })
    }
  }

  if (searchEnabled) {
    tools.glob = tool({
      description:
        'Find files by glob pattern, for example **/*.ts or src/**/*.tsx. Returns project-relative paths.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(1000).optional()
      }),
      execute: async ({ pattern, limit }) =>
        globProject(root, { pattern, limit })
    })
    tools.grep = tool({
      description:
        'Search project files with a regular expression. Optional include glob filters files. Returns path, line, column, and context.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(500),
        include: z.string().max(512).optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(120).optional(),
        contextLines: z.number().int().min(0).max(3).optional()
      }),
      execute: async (input) => grepProject(root, input)
    })
  }

  if (buildMode && writeEnabled) {
    tools.edit_file = tool({
      description:
        'Replace exactly one exact block in a project text file. Use this for focused edits; apply_patch is also available for multi-hunk patches.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048),
        oldText: z.string().min(1).max(200_000),
        newText: z.string().max(200_000)
      }),
      execute: async ({ path: relativePath, oldText, newText }, options) => {
        const { relative, absolute } = resolveWritableProjectPath(root, relativePath)
        runtime.assertWriteAllowed?.(relative)
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          throw new Error(`File not found: ${relative}`)
        }
        const before = fs.readFileSync(absolute, 'utf8')
        const occurrences = before.split(oldText).length - 1
        if (occurrences === 0) {
          throw new Error('oldText was not found. Read the file again and retry.')
        }
        if (occurrences > 1) {
          throw new Error('oldText matched more than once. Include more context.')
        }
        const after = before.replace(oldText, newText)
        await approveFileAction({
          agent,
          relativePath: relative,
          actionType: 'patch_file',
          actionKey: `edit_file:${relative}`,
          risk: 'medium',
          reason: `Edit ${relative}`,
          payload: {
            operation: 'edit_file',
            path: relative,
            oldText: previewText(oldText),
            newText: previewText(newText)
          },
          runtime,
          permissions
        })
        const snapshot = snapshotFile(runtime.sessionId, relative, 'before edit_file')
        writeFileAtomic(absolute, after)
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'patch',
          path: relative,
          beforeHash: snapshot.objectHash,
          afterHash: hashBuffer(Buffer.from(after, 'utf8')),
          snapshotId: snapshot.id,
          metadata: { toolCallId: options.toolCallId }
        })
        return { path: relative, changed: true, changeId: change.id }
      }
    })

    tools.apply_patch = tool({
      description:
        'Apply a unified multi-hunk patch to one file. Format: @@ context @@ then lines prefixed with space, - or +. Use for larger structured edits.',
      inputSchema: z.object({
        path: z.string().min(1).max(2048),
        patch: z.string().min(1).max(400_000)
      }),
      execute: async ({ path: relativePath, patch }, options) => {
        const { relative, absolute } = resolveWritableProjectPath(root, relativePath)
        runtime.assertWriteAllowed?.(relative)
        const before = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : ''
        const after = applyPatchToText(before, patch)
        await approveFileAction({
          agent,
          relativePath: relative,
          actionType: 'patch_file',
          actionKey: `apply_patch:${relative}`,
          risk: 'medium',
          reason: `Apply patch to ${relative}`,
          payload: {
            operation: 'apply_patch',
            path: relative,
            patch: previewText(patch, 2000)
          },
          runtime,
          permissions
        })
        const snapshot = snapshotFile(runtime.sessionId, relative, 'before apply_patch')
        ensureWriteDir(absolute)
        writeFileAtomic(absolute, after)
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'patch',
          path: relative,
          beforeHash: snapshot.objectHash,
          afterHash: hashBuffer(Buffer.from(after, 'utf8')),
          snapshotId: snapshot.id,
          metadata: { toolCallId: options.toolCallId }
        })
        return { path: relative, changed: true, changeId: change.id }
      }
    })
  }

  if (buildMode && commandEnabled) {
    tools.run_command = tool({
      description:
        'Run a shell command in the project. Output streams back live. Commands that install, download, deploy, push, request privileges, run inline code, touch paths outside the project, or use the working directory outside the project require Boss approval. Set background=true for a long-running process.',
      inputSchema: z.object({
        command: z.string().min(1).max(20_000).describe('Shell command to run.'),
        cwd: z
          .string()
          .max(2048)
          .optional()
          .describe('Project-relative or absolute working directory. Omit for the project root.'),
        stdin: z.string().max(20_000).optional().describe('Optional stdin input.'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(600_000)
          .optional()
          .describe('Foreground timeout in milliseconds. Defaults to 120000.'),
        background: z
          .boolean()
          .optional()
          .describe('Start the process in the background and return immediately.')
      }),
      execute: async (
        { command, cwd, stdin, timeoutMs, background },
        options
      ) => {
        const cwdResolution = resolveCommandCwd(root, cwd)
        const assessment = assessCommand({
          command,
          projectRoot: root,
          cwdOutsideProject: cwdResolution.outsideProject
        })
        const cwdDisplay = cwdResolution.outsideProject
          ? cwdResolution.absolute
          : projectRelativeDisplay(root, cwdResolution.absolute)
        const needsApproval =
          assessment.requiresApproval || !permissions.autoShellInsideRepo
        if (needsApproval) {
          const result = await runtime.requestApproval({
            actionType: 'run_command',
            actionKey: commandActionKey(cwdDisplay, command),
            risk: assessment.risk,
            reason: assessment.requiresApproval
              ? assessment.reason
              : 'Project policy requires approval for shell commands.',
            payload: {
              operation: 'run_command',
              command,
              cwd: cwdDisplay,
              background: Boolean(background),
              timeoutMs: timeoutMs ?? 120_000,
              risk: assessment.risk
            }
          })
          if (result.decision !== 'approved') {
            throw new Error('The Boss denied this command.')
          }
        }

        const result = await runCommand({
          command,
          cwd: cwdResolution.absolute,
          stdin,
          timeoutMs,
          background,
          abortSignal: options.abortSignal,
          onOutput: (stream, text) => {
            runtime.emitOutput(options.toolCallId, stream, text)
          }
        })
        const change = recordChange({
          sessionId: runtime.sessionId,
          meetingId: runtime.meetingId,
          taskId: runtime.taskId,
          turnId: runtime.turnId,
          agentId: agent.id,
          type: 'command',
          command,
          exitCode: result.exitCode,
          metadata: {
            cwd: cwdDisplay,
            background: result.background,
            processId: result.processId,
            pid: result.pid,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            logPath: result.logPath,
            toolCallId: options.toolCallId,
            stdoutTail: result.stdout.slice(-4000),
            stderrTail: result.stderr.slice(-4000)
          }
        })
        return {
          processId: result.processId,
          pid: result.pid,
          background: result.background,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdout: result.stdout.slice(-MAX_COMMAND_OUTPUT),
          stderr: result.stderr.slice(-MAX_COMMAND_OUTPUT),
          logPath: result.logPath,
          changeId: change.id
        }
      }
    })

    tools.list_processes = tool({
      description:
        'List background processes started by agents in this project, including status and recent output.',
      inputSchema: z.object({}),
      execute: async () => ({
        processes: listManagedProcesses()
      })
    })

    tools.stop_process = tool({
      description:
        'Stop a background process started by an agent. Use list_processes to find the processId.',
      inputSchema: z.object({
        processId: z.string().min(1).max(200)
      }),
      execute: async ({ processId }) => ({
        process: stopManagedProcess(processId)
      })
    })
  } else if (buildMode && !commandEnabled) {
    warnings.push('Command tools are disabled by this agent\'s permissions.')
  }

  const definitions = Object.entries(tools).map(([name, entry]) => ({
    name,
    description:
      typeof entry.description === 'string'
        ? entry.description
        : 'Project tool.'
  }))

  return {
    tools,
    definitions,
    names: Object.keys(tools),
    warnings
  }
}

function ensureWriteDir(absolutePath: string): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
}


