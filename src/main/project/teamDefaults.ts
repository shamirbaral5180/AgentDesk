import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import {
  APP_SCHEMA_VERSION,
  type AgentConfig,
  type AgentSummary,
  type TeamConfig
} from '@shared/types'
import { createLogger } from '../config/logger'
import { readJsonFile, timestampSlug, writeJsonAtomic } from '../utils/fs'
import { defaultSkillsForRole } from '../skills/builtinSkills'

const log = createLogger('team')

const modelSchema = z.object({
  providerType: z.enum(['openai', 'google', 'ollama', 'custom']),
  providerConfigId: z.string(),
  modelId: z.string(),
  fallbackModelId: z.string().optional(),
  temperature: z.number().min(0).max(2)
})

const permissionsSchema = z.object({
  writeGlobs: z.array(z.string()),
  denyGlobs: z.array(z.string()),
  tools: z.array(z.string())
})

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  roleKey: z.string().min(1),
  tagline: z.string(),
  color: z.string().min(1),
  enabled: z.boolean(),
  promptAppend: z.string(),
  model: modelSchema.nullable(),
  skills: z.array(z.string()).default([]),
  permissions: permissionsSchema
})

const teamConfigSchema = z.object({
  schemaVersion: z.number().int().positive(),
  boss: z.object({
    name: z.string().min(1),
    preferences: z.string()
  }),
  agents: z.array(agentSchema).min(1),
  orchestration: z.object({
    maxRounds: z.number().int().positive(),
    maxTurns: z.number().int().positive(),
    maxMessages: z.number().int().positive(),
    maxMinutes: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCostUsd: z.number().positive(),
    maxToolStepsPerTurn: z.number().int().positive(),
    maxReviewCycles: z.number().int().positive(),
    maxConcurrentAgents: z.number().int().min(1).max(8).default(4)
  }),
  permissions: z.object({
    autoWriteInsideRepo: z.boolean(),
    autoShellInsideRepo: z.boolean(),
    askOutsideRepo: z.boolean(),
    askInstall: z.boolean(),
    askNetwork: z.boolean(),
    askDeploy: z.boolean()
  }),
  mcp: z.object({
    enabledServerIds: z.array(z.string()).default([]),
    toolPolicies: z.record(z.string(), z.enum(['allow', 'ask', 'deny'])).default({})
  })
})

const denyGlobs = ['.agentdesk/agentdesk.db*', '.agentdesk/snapshots/**']

function baseTools(extra: string[]): string[] {
  return [
    'read',
    'search',
    'write',
    'patch',
    'message',
    'task',
    'decision',
    'memory',
    'mcp',
    ...extra
  ]
}

export function createDefaultTeam(bossName: string): TeamConfig {
  const agents: AgentConfig[] = [
    {
      id: 'coordinator',
      name: 'Coordinator & Architect',
      roleKey: 'coordinator',
      tagline: 'Plans, delegates, maintains architecture, and reports to you.',
      color: '#e6b450',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: ['.agentdesk/context/**'],
        denyGlobs,
        tools: baseTools(['run_command', 'end_meeting'])
      }
    },
    {
      id: 'frontend',
      name: 'Frontend Developer',
      roleKey: 'frontend',
      tagline: 'Builds the interface, components, interactions, and accessibility.',
      color: '#4f9cf9',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: [
          'src/renderer/**',
          'src/components/**',
          'src/pages/**',
          'src/styles/**',
          '**/*.css',
          '**/*.tsx',
          '**/*.jsx',
          '**/*.html'
        ],
        denyGlobs,
        tools: baseTools(['run_command'])
      }
    },
    {
      id: 'backend',
      name: 'Backend Developer',
      roleKey: 'backend',
      tagline: 'Implements services, APIs, authentication, and business logic.',
      color: '#6ee7b7',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: [
          'src/main/**',
          'src/server/**',
          'src/api/**',
          'server/**',
          '**/*.ts',
          '**/*.js'
        ],
        denyGlobs,
        tools: baseTools(['run_command'])
      }
    },
    {
      id: 'database',
      name: 'Database & Infrastructure Engineer',
      roleKey: 'database',
      tagline: 'Designs schemas, migrations, storage, and performance.',
      color: '#c084fc',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: [
          '**/*.sql',
          '**/migrations/**',
          '**/schema/**',
          '**/*.db',
          'infra/**'
        ],
        denyGlobs,
        tools: baseTools(['run_command'])
      }
    },
    {
      id: 'qa',
      name: 'QA, Security & Code Reviewer',
      roleKey: 'qa',
      tagline: 'Tests behavior, reviews code, checks security, and verifies fixes.',
      color: '#f87171',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: [
          'tests/**',
          '**/*.test.*',
          '**/*.spec.*',
          '**/__tests__/**'
        ],
        denyGlobs,
        tools: baseTools(['run_command'])
      }
    },
    {
      id: 'devops',
      name: 'DevOps & Documentation Engineer',
      roleKey: 'devops',
      tagline: 'Manages builds, packaging, CI, logging, and documentation.',
      color: '#38bdf8',
      enabled: true,
      promptAppend: '',
      model: null,
      skills: [],
      permissions: {
        writeGlobs: [
          'package.json',
          '*.config.*',
          '.github/**',
          'docs/**',
          'scripts/**',
          '**/*.md'
        ],
        denyGlobs,
        tools: baseTools(['run_command'])
      }
    }
  ]

  for (const agent of agents) {
    agent.skills = defaultSkillsForRole(agent.roleKey)
  }

  return {
    schemaVersion: APP_SCHEMA_VERSION,
    boss: {
      name: bossName,
      preferences: ''
    },
    agents,
    orchestration: {
      maxRounds: 3,
      maxTurns: 32,
      maxMessages: 50,
      maxMinutes: 15,
      maxTokens: 300000,
      maxCostUsd: 2,
      maxToolStepsPerTurn: 8,
      maxReviewCycles: 2,
      maxConcurrentAgents: 4
    },
    permissions: {
      autoWriteInsideRepo: true,
      autoShellInsideRepo: true,
      askOutsideRepo: true,
      askInstall: true,
      askNetwork: true,
      askDeploy: true
    },
    mcp: {
      enabledServerIds: [],
      toolPolicies: {}
    }
  }
}

export function loadOrCreateTeam(teamPath: string, bossName: string): TeamConfig {
  if (!fs.existsSync(teamPath)) {
    const team = createDefaultTeam(bossName)
    writeJsonAtomic(teamPath, team)
    log.info('Created default team configuration', { teamPath })
    return team
  }

  try {
    const team = teamConfigSchema.parse(readJsonFile<unknown>(teamPath)) as TeamConfig
    for (const agent of team.agents) {
      if (!agent.skills || agent.skills.length === 0) {
        agent.skills = defaultSkillsForRole(agent.roleKey)
      }
    }
    return team
  } catch (error) {
    const backupPath = path.join(
      path.dirname(teamPath),
      `team.invalid-${timestampSlug()}.json`
    )
    try {
      fs.copyFileSync(teamPath, backupPath)
    } catch {
      log.warn('Could not back up invalid team configuration', { teamPath })
    }
    const team = createDefaultTeam(bossName)
    writeJsonAtomic(teamPath, team)
    log.error('Invalid team configuration; restored defaults', {
      teamPath,
      backupPath,
      error
    })
    return team
  }
}

export function saveTeamConfig(teamPath: string, team: TeamConfig): void {
  const validated = teamConfigSchema.parse(team) as TeamConfig
  writeJsonAtomic(teamPath, validated)
}

export function toAgentSummaries(team: TeamConfig): AgentSummary[] {
  return team.agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    roleKey: agent.roleKey,
    tagline: agent.tagline,
    color: agent.color,
    enabled: agent.enabled,
    model: agent.model,
    modelLabel: agent.model
      ? `${agent.model.providerType} / ${agent.model.modelId}`
      : null,
    skills: agent.skills ?? defaultSkillsForRole(agent.roleKey)
  }))
}
