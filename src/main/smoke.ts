import fs from 'node:fs'
import path from 'node:path'
import { getAppPaths } from './config/appPaths'
import { listTableNames } from './db/database'
import { removeRecentProject } from './config/settings'
import {
  closeProject,
  getCurrentProjectDatabase,
  openProject
} from './project/projectService'

export async function runSmokeTest(): Promise<number> {
  const paths = getAppPaths()
  const root = path.join(paths.tmpDir, `smoke-${Date.now()}`)

  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          name: 'smoke-project',
          version: '1.0.0',
          scripts: {
            build: 'tsc',
            test: 'vitest run'
          },
          dependencies: {
            electron: '45.0.0',
            react: '19.3.1',
            typescript: '5.9.3'
          }
        },
        null,
        2
      ),
      'utf8'
    )
    fs.writeFileSync(
      path.join(root, 'src', 'App.tsx'),
      'export function App() { return null }\n',
      'utf8'
    )

    const project = openProject(root)
    const database = getCurrentProjectDatabase()
    if (!database) {
      throw new Error('Database was not opened')
    }

    const tables = listTableNames(database.db)
    const dataDir = path.join(root, '.agentdesk')
    const lockPath = path.join(dataDir, 'app.lock')

    const result = {
      ok: true,
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
        stacks: project.detection.stacks,
        packageManager: project.detection.packageManager,
        fileCount: project.detection.fileCount,
        agents: project.agents.length
      },
      dataDir,
      dbPath: project.dbPath,
      tableCount: tables.length,
      hasTeam: fs.existsSync(path.join(dataDir, 'team.json')),
      hasDetectedContext: fs.existsSync(path.join(dataDir, 'context', 'detected.md')),
      hasLock: fs.existsSync(lockPath),
      appDataDir: paths.appDataDir
    }

    closeProject()

    result.hasLock = fs.existsSync(lockPath)
    removeRecentProject(root)
    fs.rmSync(root, { recursive: true, force: true })

    console.log(`SMOKE_RESULT ${JSON.stringify(result)}`)
    return 0
  } catch (error) {
    console.error('SMOKE_FAILED', error)
    try {
      closeProject()
      removeRecentProject(root)
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      return 1
    }
    return 1
  }
}
