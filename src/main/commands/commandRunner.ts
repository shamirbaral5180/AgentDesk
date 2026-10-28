import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../errors'
import { getCurrentProjectRoot } from '../project/projectService'
import { ensureDir, tryReadJsonFile, writeJsonAtomic } from '../utils/fs'

const MAX_BUFFER_CHARS = 200_000

export type CommandOutputHandler = (
  stream: 'stdout' | 'stderr' | 'system',
  text: string
) => void

export type CommandResult = {
  processId: string
  pid: number | undefined
  background: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  logPath: string
}

type ManagedProcess = {
  processId: string
  pid: number | undefined
  command: string
  cwd: string
  background: boolean
  status: 'running' | 'exited' | 'failed' | 'stopped'
  exitCode: number | null
  timedOut: boolean
  startedAt: number
  endedAt: number | null
  stdout: string
  stderr: string
  logPath: string
  child: ChildProcess
}

const processes = new Map<string, ManagedProcess>()

function appendLimited(current: string, text: string): string {
  const next = current + text
  return next.length > MAX_BUFFER_CHARS
    ? next.slice(next.length - MAX_BUFFER_CHARS)
    : next
}

function projectRoot(): string {
  const root = getCurrentProjectRoot()
  if (!root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return root
}

function logPathFor(processId: string): { absolute: string; relative: string } {
  const root = projectRoot()
  const relative = `.agentdesk/logs/commands/${processId}.log`
  return {
    absolute: path.join(root, relative),
    relative
  }
}

function killPidTree(pid: number, fallback?: ChildProcess): void {
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => {
        try {
          fallback?.kill()
        } catch {
          // The process may already be gone.
        }
      })
    } catch {
      try {
        fallback?.kill()
      } catch {
        // The process may already be gone.
      }
    }
    return
  }
  try {
    fallback?.kill('SIGKILL')
  } catch {
    // The process may already be gone.
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) {
    return
  }
  killPidTree(child.pid, child)
}

type PersistedProcess = {
  processId: string
  pid: number
  command: string
  startedAt: number
}

function processRegistryPath(): string | null {
  const root = getCurrentProjectRoot()
  return root ? path.join(root, '.agentdesk', 'tmp', 'processes.json') : null
}

function persistProcessRegistry(): void {
  const registryPath = processRegistryPath()
  if (!registryPath) {
    return
  }
  const running: PersistedProcess[] = [...processes.values()]
    .filter((entry) => entry.status === 'running' && entry.pid)
    .map((entry) => ({
      processId: entry.processId,
      pid: entry.pid as number,
      command: entry.command,
      startedAt: entry.startedAt
    }))
  try {
    ensureDir(path.dirname(registryPath))
    writeJsonAtomic(registryPath, { processes: running })
  } catch {
    // Process cleanup is best effort; the command itself must keep running.
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function reconcileManagedProcesses(): number {
  const registryPath = processRegistryPath()
  if (!registryPath) {
    return 0
  }
  const registry = tryReadJsonFile<{ processes?: PersistedProcess[] }>(registryPath)
  if (!registry?.processes?.length) {
    try {
      fs.rmSync(registryPath, { force: true })
    } catch {
      // Ignore cleanup failures.
    }
    return 0
  }
  let killed = 0
  for (const entry of registry.processes) {
    if (Number.isInteger(entry.pid) && entry.pid > 0 && pidIsAlive(entry.pid)) {
      killPidTree(entry.pid)
      killed += 1
    }
  }
  try {
    fs.rmSync(registryPath, { force: true })
  } catch {
    // Ignore cleanup failures.
  }
  return killed
}

export function runCommand(input: {
  command: string
  cwd: string
  stdin?: string
  timeoutMs?: number
  background?: boolean
  onOutput: CommandOutputHandler
  abortSignal?: AbortSignal
}): Promise<CommandResult> {
  const processId = randomUUID()
  const startedAt = Date.now()
  const logs = logPathFor(processId)
  ensureDir(path.dirname(logs.absolute))
  const logStream = fs.createWriteStream(logs.absolute, { flags: 'a' })
  logStream.write(`# ${new Date(startedAt).toISOString()}\n# cwd: ${input.cwd}\n# $ ${input.command}\n\n`)

  return new Promise<CommandResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      logStream.end()
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let resolved = false
    let timer: NodeJS.Timeout | null = null

    const entry: ManagedProcess = {
      processId,
      pid: child.pid,
      command: input.command,
      cwd: input.cwd,
      background: Boolean(input.background),
      status: 'running',
      exitCode: null,
      timedOut: false,
      startedAt,
      endedAt: null,
      stdout,
      stderr,
      logPath: logs.relative,
      child
    }
    processes.set(processId, entry)
    persistProcessRegistry()

    const settle = (exitCode: number | null, failed = false): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      const endedAt = Date.now()
      entry.status =
        entry.status === 'stopped'
          ? 'stopped'
          : failed
            ? 'failed'
            : timedOut
              ? 'stopped'
              : 'exited'
      entry.exitCode = exitCode
      entry.timedOut = timedOut
      entry.endedAt = endedAt
      entry.stdout = stdout
      entry.stderr = stderr
      logStream.write(
        `\n# exit ${exitCode ?? 'null'}${timedOut ? ' (timed out)' : ''} after ${
          endedAt - startedAt
        } ms\n`
      )
      logStream.end()
      if (!entry.background) {
        processes.delete(processId)
      }
      persistProcessRegistry()
      if (!resolved) {
        resolved = true
        resolve({
          processId,
          pid: child.pid,
          background: entry.background,
          exitCode,
          timedOut,
          durationMs: endedAt - startedAt,
          stdout,
          stderr,
          logPath: logs.relative
        })
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout = appendLimited(stdout, text)
      logStream.write(text)
      input.onOutput('stdout', text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr = appendLimited(stderr, text)
      logStream.write(text)
      input.onOutput('stderr', text)
    })

    child.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      stderr = appendLimited(stderr, `${message}\n`)
      logStream.write(`${message}\n`)
      input.onOutput('system', `${message}\n`)
      settle(null, true)
    })
    child.on('close', (code) => {
      settle(code, false)
    })

    if (input.stdin !== undefined) {
      child.stdin?.write(input.stdin)
    }
    child.stdin?.end()

    if (entry.background) {
      resolved = true
      resolve({
        processId,
        pid: child.pid,
        background: true,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: '',
        logPath: logs.relative
      })
      return
    }

    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        timedOut = true
        killTree(child)
      } else {
        input.abortSignal.addEventListener(
          'abort',
          () => {
            if (!settled) {
              timedOut = true
              input.onOutput('system', '\n[command stopped by Boss]\n')
              killTree(child)
            }
          },
          { once: true }
        )
      }
    }

    const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 1_000), 600_000)
    timer = setTimeout(() => {
      if (!settled) {
        timedOut = true
        input.onOutput('system', `\n[command timed out after ${timeoutMs} ms]\n`)
        killTree(child)
      }
    }, timeoutMs)
  })
}

export type ProcessSummary = {
  processId: string
  pid: number | undefined
  command: string
  cwd: string
  status: string
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  logPath: string
  stdoutTail: string
  stderrTail: string
}

export function listManagedProcesses(): ProcessSummary[] {
  return [...processes.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((entry) => ({
      processId: entry.processId,
      pid: entry.pid,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      logPath: entry.logPath,
      stdoutTail: entry.stdout.slice(-4000),
      stderrTail: entry.stderr.slice(-4000)
    }))
}

export function stopManagedProcess(processId: string): ProcessSummary {
  const entry = processes.get(processId)
  if (!entry) {
    throw new AppError('PROCESS_NOT_FOUND', 'The background process is no longer tracked.')
  }
  if (entry.status === 'running') {
    killTree(entry.child)
    entry.status = 'stopped'
    entry.endedAt = Date.now()
  }
  persistProcessRegistry()
  return {
    processId: entry.processId,
    pid: entry.pid,
    command: entry.command,
    cwd: entry.cwd,
    status: entry.status,
    exitCode: entry.exitCode,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    logPath: entry.logPath,
    stdoutTail: entry.stdout.slice(-4000),
    stderrTail: entry.stderr.slice(-4000)
  }
}

export function killAllManagedProcesses(): void {
  for (const entry of processes.values()) {
    if (entry.status === 'running') {
      killTree(entry.child)
      entry.status = 'stopped'
      entry.endedAt = Date.now()
    }
  }
  processes.clear()
  persistProcessRegistry()
}

