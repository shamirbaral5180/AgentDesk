import { spawnSync } from 'node:child_process'

export type HostRuntime = {
  name: string
  command: string
  version: string | null
  available: boolean
}

const commands: Array<{ name: string; command: string; args: string[] }> = [
  { name: 'Node.js', command: 'node', args: ['--version'] },
  { name: 'npm', command: 'npm', args: ['--version'] },
  { name: 'Python', command: 'python', args: ['--version'] },
  { name: 'pip', command: 'pip', args: ['--version'] },
  { name: 'Git', command: 'git', args: ['--version'] },
  { name: 'Docker', command: 'docker', args: ['--version'] },
  { name: '.NET', command: 'dotnet', args: ['--version'] },
  { name: 'Java', command: 'java', args: ['-version'] }
]

let cached: HostRuntime[] | null = null

function firstLine(value: string | null | undefined): string | null {
  const line = (value ?? '').split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
  return line ?? null
}

export function detectHostRuntimes(force = false): HostRuntime[] {
  if (cached && !force) {
    return cached
  }
  cached = commands.map((entry) => {
    const result = spawnSync(entry.command, entry.args, {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    const output = firstLine(result.stdout) ?? firstLine(result.stderr)
    return {
      name: entry.name,
      command: entry.command,
      version: result.status === 0 ? output : output ?? null,
      available: result.status === 0
    }
  })
  return cached
}

export function hostRuntimePrompt(): string {
  const runtimes = detectHostRuntimes()
  return runtimes
    .map((runtime) =>
      runtime.available
        ? `- ${runtime.name}: ${runtime.version ?? 'available'} (use the host command "${runtime.command}")`
        : `- ${runtime.name}: not found on PATH`
    )
    .join('\n')
}
