import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const target = path.join(process.cwd(), 'build', 'runtime', 'npm')
const candidates = [path.join(path.dirname(process.execPath), 'node_modules', 'npm')]
try {
  candidates.push(path.dirname(require.resolve('npm/package.json')))
} catch {
  // npm is usually installed beside node.exe rather than in this project.
}

let source = null
for (const candidate of candidates) {
  if (fs.existsSync(path.join(candidate, 'bin', 'npm-cli.js'))) {
    source = candidate
    break
  }
}

if (!source) {
  console.error(
    'Could not find npm to bundle. Install Node with npm, then rerun the package command.'
  )
  process.exit(1)
}

fs.rmSync(path.join(process.cwd(), 'build', 'runtime'), {
  recursive: true,
  force: true
})
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.cpSync(source, target, { recursive: true })
console.log(`Bundled npm runtime from ${source} into ${target}`)
