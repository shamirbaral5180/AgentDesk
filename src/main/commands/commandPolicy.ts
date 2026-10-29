import path from 'node:path'
import type { ApprovalRisk } from '@shared/types'
import { AppError } from '../errors'
import { isPathInside } from '../utils/fs'

export type CommandAssessment = {
  requiresApproval: boolean
  risk: ApprovalRisk
  reason: string
}

const HARD_BLOCK_PATTERNS: Array<[RegExp, string]> = [
  [/\bsecrets\.bin\b/i, 'Access to AgentDesk secrets is blocked.'],
  [/\.agentdesk[\\/]+secrets/i, 'Access to AgentDesk secrets is blocked.'],
  [/\bid_(rsa|dsa|ecdsa|ed25519)\b/i, 'Access to private keys is blocked.'],
  [/(^|[\s\\/])\.ssh([\\/\s]|$)/i, 'Access to SSH credentials is blocked.'],
  [/(^|[\s\\/])\.aws([\\/\s]|$)/i, 'Access to cloud credentials is blocked.'],
  [/(^|[\s"'`=;|&])\.env(\.|\s|$)/i, 'Access to environment secret files is blocked.'],
  [/\bcredentials(\.json)?\b/i, 'Access to credential stores is blocked.']
]

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
  [/\b(winget|choco|scoop)\s+(install|add)\b/i, 'This command installs host software or a language runtime.'],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add|remove|rm|upgrade|update)\b/i, 'This command installs or changes packages.'],
  [/\b(pip|pip3)\s+install\b/i, 'This command installs Python packages.'],
  [/\b(cargo|go)\s+(install|get|add)\b/i, 'This command installs dependencies.'],
  [/\b(curl|wget|Invoke-WebRequest|iwr|Start-BitsTransfer)\b/i, 'This command downloads from the network.'],
  [/\b(git\s+(clone|push|pull|fetch)|gh\s+release|npm\s+publish)\b/i, 'This command interacts with a remote repository or registry.'],
  [/\b(docker|podman)(\.exe)?\b/i, 'This command uses the container engine and can build, run, pull, or change host resources.'],
  [/\b(vercel|netlify|fly|heroku|aws|gcloud|az)\s+(deploy|publish|up|push)\b/i, 'This command deploys to a remote service.'],
  [/\b(rm|rmdir|del|erase)\b.*(\/s|\/q|-rf|-r\b|--recursive)/i, 'This command can delete files recursively.'],
  [/\b(git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+checkout\s+--\s+\.)/i, 'This command discards uncommitted work.'],
  [/\b(format|diskpart|shutdown|bcdedit|reg\s+delete|takeown|icacls)\b/i, 'This is a system-level or destructive command.'],
  [/\b(powershell|pwsh)\b.*(-enc|-encodedcommand|-executionpolicy\s+bypass)/i, 'This command uses an obfuscated or unrestricted shell.'],
  [/\b(node|python|python3|ruby|perl)\b.*\s(-e|-c)\b/i, 'This command executes inline code and may modify anything.'],
  [/\b(sudo|runas)\b/i, 'This command requests elevated privileges.'],
  [/\b(scp|ssh|rsync)\b/i, 'This command can transfer files to another machine.'],
  [/\b(cmd(\.exe)?\s+\/[ck]|powershell(\.exe)?\b.*\s-(c|command|enc|encodedcommand))\b/i, 'This command launches a nested or encoded shell.'],
  [/\b(bash|sh|zsh|fish|pwsh)\s+-(c|e|command)\b/i, 'This command launches a nested shell.'],
  [/\b(npx|npm\s+(exec|x)|pnpm\s+(dlx|exec)|yarn\s+(dlx|exec)|bunx)\b/i, 'This command runs a downloaded or remote package.'],
  [/\bgit\s+(-c|config|--exec-path|--upload-pack)\b/i, 'This command can change or override git execution behavior.'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[\s\S]*\|\s*(sh|bash|zsh|powershell|pwsh|cmd)\b/i, 'This command pipes downloaded content into a shell.'],
  [/\b(setx?|export|PATH\s*=|\$env:)\b/i, 'This command changes environment variables for the process tree.'],
  [/\b(start-process|start\s+\/b|nohup|schtasks|wmic\s+process\s+call\s+create)\b/i, 'This command starts a detached or scheduled process.'],
  [/(^|[\s;])&\s*$|\bstart\s+["']?[^"' ]+/i, 'This command may run a background or detached process.'],
  [/\b(taskkill|tskill|killall|pkill)\b/i, 'This command terminates processes and may affect the host.']
]

const PATH_ESCAPE_PATTERN = /(^|[\s"'`=;|&])\.\.([\\/]|$)/

function absolutePaths(command: string): string[] {
  const windows = command.match(/[A-Za-z]:[\\/][^\s"'`;|&]*/g) ?? []
  const unix = command.match(/(^|[\s"'`=;|&])\/[^\s"'`;|&]+/g) ?? []
  return [
    ...windows,
    ...unix.map((value) => value.replace(/^[\s"'`=;|&]/, ''))
  ]
}

export function assessCommand(input: {
  command: string
  projectRoot: string
  cwdOutsideProject: boolean
}): CommandAssessment {
  const command = input.command.trim()
  if (!command) {
    throw new AppError('EMPTY_COMMAND', 'A command is required.')
  }

  for (const [pattern, message] of HARD_BLOCK_PATTERNS) {
    if (pattern.test(command)) {
      throw new AppError('COMMAND_BLOCKED', message)
    }
  }

  if (input.cwdOutsideProject) {
    return {
      requiresApproval: true,
      risk: 'high',
      reason: 'The working directory is outside the project.'
    }
  }

  if (PATH_ESCAPE_PATTERN.test(command)) {
    return {
      requiresApproval: true,
      risk: 'high',
      reason: 'The command references a path outside the project.'
    }
  }

  for (const target of absolutePaths(command)) {
    const resolved = path.resolve(target)
    if (!isPathInside(input.projectRoot, resolved)) {
      return {
        requiresApproval: true,
        risk: 'high',
        reason: `The command references an absolute path outside the project: ${target}`
      }
    }
  }

  for (const [pattern, reason] of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) {
      return {
        requiresApproval: true,
        risk: 'high',
        reason
      }
    }
  }

  return {
    requiresApproval: false,
    risk: 'low',
    reason: 'The command is scoped to the project and is not classified as destructive.'
  }
}

export function commandActionKey(cwd: string, command: string): string {
  return `run_command:${cwd.replaceAll('\\', '/')}:${command.trim().replace(/\s+/g, ' ')}`
}
