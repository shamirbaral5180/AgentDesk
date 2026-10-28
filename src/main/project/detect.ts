import fs from 'node:fs'
import path from 'node:path'
import type { ProjectDetection } from '@shared/types'
import { readTextIfExists, writeFileAtomic } from '../utils/fs'
import { createLogger } from '../config/logger'

const log = createLogger('detect')

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agentdesk',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'target',
  'bin',
  'obj',
  'venv',
  '.venv',
  '__pycache__',
  'coverage',
  '.turbo',
  '.cache'
])

type PackageJson = {
  name?: string
  main?: string
  packageManager?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function readPackageJson(projectRoot: string): PackageJson | null {
  const packagePath = path.join(projectRoot, 'package.json')
  const raw = readTextIfExists(packagePath)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as PackageJson
  } catch {
    return null
  }
}

function detectPackageManager(projectRoot: string, pkg: PackageJson | null): string | null {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared) {
    return declared
  }
  const lockfiles: Array<[string, string]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm']
  ]
  for (const [filename, manager] of lockfiles) {
    if (fs.existsSync(path.join(projectRoot, filename))) {
      return manager
    }
  }
  return pkg ? 'npm' : null
}

function detectFromPackage(
  projectRoot: string,
  pkg: PackageJson,
  stacks: string[],
  notes: string[]
): void {
  const dependencies = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {})
  }
  const has = (name: string): boolean => Boolean(dependencies[name])

  const addStack = (label: string): void => {
    if (!stacks.includes(label)) {
      stacks.push(label)
    }
  }

  addStack('Node.js')

  if (has('electron')) addStack('Electron')
  if (has('react')) addStack('React')
  if (has('next')) addStack('Next.js')
  if (has('vite')) addStack('Vite')
  if (has('vue')) addStack('Vue')
  if (has('svelte')) addStack('Svelte')
  if (has('@angular/core')) addStack('Angular')
  if (has('express')) addStack('Express')
  if (has('fastify')) addStack('Fastify')
  if (has('@nestjs/core')) addStack('NestJS')
  if (has('tailwindcss')) addStack('Tailwind CSS')
  if (has('prisma') || has('@prisma/client')) addStack('Prisma')
  if (has('drizzle-orm')) addStack('Drizzle ORM')
  if (has('better-sqlite3') || has('sqlite3')) addStack('SQLite')
  if (has('typescript') || fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
    addStack('TypeScript')
  }
  if (has('vitest') || has('jest') || has('playwright') || has('cypress')) {
    addStack('Testing')
  }
  if (has('@modelcontextprotocol/sdk') || has('@modelcontextprotocol/client')) {
    addStack('MCP')
  }
  if (has('ai') || has('@ai-sdk/openai') || has('@ai-sdk/google')) {
    addStack('AI SDK')
  }

  if (!pkg.scripts || Object.keys(pkg.scripts).length === 0) {
    notes.push('package.json has no scripts; agents will inspect the toolchain directly.')
  }
}

function detectOtherFiles(projectRoot: string, stacks: string[], notes: string[]): void {
  const addStack = (label: string): void => {
    if (!stacks.includes(label)) {
      stacks.push(label)
    }
  }

  const topLevel = fs.readdirSync(projectRoot, { withFileTypes: true })
  const names = new Set(topLevel.map((entry) => entry.name))

  if ([...names].some((name) => name.endsWith('.sln') || name.endsWith('.csproj'))) {
    addStack('.NET')
  }
  if (names.has('pyproject.toml') || names.has('requirements.txt')) {
    addStack('Python')
  }
  if (names.has('Cargo.toml')) {
    addStack('Rust')
  }
  if (names.has('go.mod')) {
    addStack('Go')
  }
  if (names.has('CMakeLists.txt')) {
    addStack('C/C++')
  }
  if (names.has('Dockerfile') || names.has('docker-compose.yml') || names.has('compose.yaml')) {
    addStack('Docker')
  }
  if (names.has('.github')) {
    addStack('GitHub Actions')
  }
  if (names.has('pnpm-workspace.yaml')) {
    notes.push('pnpm workspace detected; the project contains multiple packages.')
  }
}

function detectCommands(
  projectRoot: string,
  pkg: PackageJson | null,
  packageManager: string | null,
  stacks: string[]
): ProjectDetection['commands'] {
  const commands: ProjectDetection['commands'] = {}
  const scriptCommand = (scriptName: string): string | undefined => {
    if (!pkg?.scripts?.[scriptName] || !packageManager) {
      return undefined
    }
    if (packageManager === 'npm' && scriptName === 'test') {
      return 'npm test'
    }
    return `${packageManager} run ${scriptName}`
  }

  if (pkg && packageManager) {
    commands.install = `${packageManager} install`
    commands.build = scriptCommand('build')
    commands.test = scriptCommand('test')
    commands.lint = scriptCommand('lint')
    commands.dev = scriptCommand('dev')
  }

  if (stacks.includes('.NET')) {
    commands.install = commands.install ?? 'dotnet restore'
    commands.build = commands.build ?? 'dotnet build'
    commands.test = commands.test ?? 'dotnet test'
  }
  if (stacks.includes('Rust')) {
    commands.build = commands.build ?? 'cargo build'
    commands.test = commands.test ?? 'cargo test'
  }
  if (stacks.includes('Go')) {
    commands.build = commands.build ?? 'go build ./...'
    commands.test = commands.test ?? 'go test ./...'
  }
  if (stacks.includes('Python')) {
    commands.test = commands.test ?? 'pytest'
    if (fs.existsSync(path.join(projectRoot, 'uv.lock'))) {
      commands.install = commands.install ?? 'uv sync'
    } else if (fs.existsSync(path.join(projectRoot, 'requirements.txt'))) {
      commands.install = commands.install ?? 'pip install -r requirements.txt'
    }
  }

  return commands
}

function detectEntryPoints(projectRoot: string, pkg: PackageJson | null): string[] {
  const candidates = new Set<string>()
  const addIfExists = (relativePath: string): void => {
    if (fs.existsSync(path.join(projectRoot, relativePath))) {
      candidates.add(relativePath)
    }
  }

  if (pkg?.main) {
    candidates.add(pkg.main.replace(/^\.\//, ''))
  }
  ;[
    'src/main.ts',
    'src/main.tsx',
    'src/index.ts',
    'src/index.tsx',
    'src/App.tsx',
    'index.js',
    'index.ts',
    'main.py',
    'Program.cs',
    'src/main.rs',
    'main.go'
  ].forEach(addIfExists)

  return [...candidates].slice(0, 8)
}

function detectGitBranch(projectRoot: string): string | null {
  const headPath = path.join(projectRoot, '.git', 'HEAD')
  const head = readTextIfExists(headPath)
  if (!head) {
    return null
  }
  const trimmed = head.trim()
  const match = /^ref:\s+refs\/heads\/(.+)$/.exec(trimmed)
  if (match) {
    return match[1]
  }
  return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed.slice(0, 8) : null
}

function countFiles(projectRoot: string, limit = 8000): number {
  let count = 0
  const stack: string[] = [projectRoot]

  while (stack.length > 0 && count < limit) {
    const current = stack.pop()
    if (!current) {
      break
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(path.join(current, entry.name))
        }
      } else if (entry.isFile()) {
        count += 1
        if (count >= limit) {
          break
        }
      }
    }
  }

  return count
}

export function detectProject(projectRoot: string): ProjectDetection {
  const stacks: string[] = []
  const notes: string[] = []
  const pkg = readPackageJson(projectRoot)
  const packageManager = detectPackageManager(projectRoot, pkg)

  if (pkg) {
    detectFromPackage(projectRoot, pkg, stacks, notes)
  }
  detectOtherFiles(projectRoot, stacks, notes)

  const gitBranch = detectGitBranch(projectRoot)
  if (gitBranch) {
    notes.push(`Git branch: ${gitBranch}.`)
  } else if (fs.existsSync(path.join(projectRoot, '.git'))) {
    notes.push('Git repository detected, but the branch could not be read.')
  }

  if (stacks.length === 0) {
    notes.push('No known stack detected yet; agents will inspect the repository directly.')
  }

  const fileCount = countFiles(projectRoot)
  if (fileCount >= 8000) {
    notes.push('File count capped at 8,000 for project detection.')
  }

  return {
    stacks,
    packageManager,
    scripts: pkg?.scripts ?? {},
    commands: detectCommands(projectRoot, pkg, packageManager, stacks),
    entryPoints: detectEntryPoints(projectRoot, pkg),
    gitBranch,
    fileCount,
    notes
  }
}

function list(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(', ') : fallback
}

export function renderDetectedMarkdown(
  projectName: string,
  detection: ProjectDetection
): string {
  const lines: string[] = []
  lines.push(`# Detected Project Context`)
  lines.push('')
  lines.push(`Project: ${projectName}`)
  lines.push('')
  lines.push('## Stack')
  lines.push('')
  lines.push(list(detection.stacks, 'Not detected'))
  lines.push('')
  lines.push('## Commands')
  lines.push('')
  lines.push('| Action | Command |')
  lines.push('| --- | --- |')
  lines.push(`| Install | ${detection.commands.install ?? 'Not detected'} |`)
  lines.push(`| Build | ${detection.commands.build ?? 'Not detected'} |`)
  lines.push(`| Test | ${detection.commands.test ?? 'Not detected'} |`)
  lines.push(`| Lint | ${detection.commands.lint ?? 'Not detected'} |`)
  lines.push(`| Dev | ${detection.commands.dev ?? 'Not detected'} |`)
  lines.push('')
  lines.push('## Details')
  lines.push('')
  lines.push(`- Package manager: ${detection.packageManager ?? 'None'}`)
  lines.push(`- Git branch: ${detection.gitBranch ?? 'None'}`)
  lines.push(`- Source files: ${detection.fileCount}`)
  lines.push(`- Entry points: ${list(detection.entryPoints, 'Not detected')}`)
  lines.push('')
  if (detection.notes.length > 0) {
    lines.push('## Notes')
    lines.push('')
    for (const note of detection.notes) {
      lines.push(`- ${note}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function writeDetectedContext(projectRoot: string, projectName: string): ProjectDetection {
  const detection = detectProject(projectRoot)
  const contextPath = path.join(projectRoot, '.agentdesk', 'context', 'detected.md')
  const nextContent = renderDetectedMarkdown(projectName, detection)
  const currentContent = readTextIfExists(contextPath)
  if (currentContent !== nextContent) {
    writeFileAtomic(contextPath, nextContent)
    log.info('Updated detected project context', { contextPath })
  }
  return detection
}
