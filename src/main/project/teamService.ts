import { randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  AgentCreateInput,
  AgentModelSelection,
  AgentModelRef,
  AgentPermissions,
  AgentRosterPatch,
  ModelRecord,
  ProviderConfig,
  TeamConfig,
  TeamMutationResult
} from '@shared/types'
import { loadSettings } from '../config/settings'
import { AppError } from '../errors'
import { defaultSkillsForRole } from '../skills/builtinSkills'
import {
  getCurrentProject,
  getCurrentTeamConfig,
  updateCurrentTeam
} from './projectService'

function findModel(modelRecordId: string): {
  model: ModelRecord
  provider: ProviderConfig
} {
  const settings = loadSettings()
  const model = settings.models.find((entry) => entry.id === modelRecordId)
  if (!model) {
    throw new AppError(
      'MODEL_NOT_FOUND',
      'The selected model no longer exists. Refresh models and try again.'
    )
  }
  const provider = settings.providers.find((entry) => entry.id === model.providerId)
  if (!provider) {
    throw new AppError(
      'PROVIDER_NOT_FOUND',
      'The provider for the selected model no longer exists.'
    )
  }
  return { model, provider }
}

function clampTemperature(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback
  if (!Number.isFinite(candidate)) {
    return fallback
  }
  return Math.min(Math.max(candidate, 0), 2)
}

export function getTeam(): TeamConfig | null {
  return getCurrentTeamConfig()
}

export function setAgentModel(selection: AgentModelSelection): TeamMutationResult {
  const currentTeam = getCurrentTeamConfig()
  if (!currentTeam) {
    throw new AppError('NO_PROJECT', 'Open a project before assigning models.')
  }

  const resolved = selection.modelRecordId
    ? findModel(selection.modelRecordId)
    : null

  const nextTeam = updateCurrentTeam((team) => {
    const agent = team.agents.find((entry) => entry.id === selection.agentId)
    if (!agent) {
      throw new AppError('AGENT_NOT_FOUND', 'The selected agent does not exist.')
    }

    let model: AgentModelRef | null = null
    if (resolved) {
      model = {
        providerType: resolved.provider.type,
        providerConfigId: resolved.provider.id,
        modelId: resolved.model.modelId,
        temperature: clampTemperature(
          selection.temperature,
          agent.model?.temperature ?? 0.2
        )
      }
    }

    return {
      ...team,
      agents: team.agents.map((entry) =>
        entry.id === selection.agentId ? { ...entry, model } : entry
      )
    }
  })

  const project = getCurrentProject()
  if (!project) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }

  return {
    team: nextTeam,
    project
  }
}

function mutationResult(team: TeamConfig): TeamMutationResult {
  const project = getCurrentProject()
  if (!project) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return { team, project }
}

function sanitizePermissions(
  permissions: AgentPermissions | undefined,
  fallback: AgentPermissions
): AgentPermissions {
  if (!permissions) {
    return fallback
  }
  return {
    tools: [...new Set(permissions.tools.map((tool) => tool.trim()).filter(Boolean))],
    writeGlobs: [...new Set(permissions.writeGlobs.map((glob) => glob.trim()).filter(Boolean))],
    denyGlobs: [...new Set(permissions.denyGlobs.map((glob) => glob.trim()).filter(Boolean))]
  }
}

function updateAgentInTeam(team: TeamConfig, patch: AgentRosterPatch): TeamConfig {
  const existing = team.agents.find((agent) => agent.id === patch.id)
  if (!existing) {
    throw new AppError('AGENT_NOT_FOUND', 'The selected agent does not exist.')
  }
  const color = patch.color?.trim() ?? existing.color
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new AppError('INVALID_COLOR', 'Agent color must be a six-digit hex value.')
  }
  const updated: AgentConfig = {
    ...existing,
    name: patch.name?.trim() || existing.name,
    roleKey: patch.roleKey?.trim() || existing.roleKey,
    tagline: patch.tagline?.trim() ?? existing.tagline,
    color,
    enabled: patch.enabled ?? existing.enabled,
    promptAppend: patch.promptAppend ?? existing.promptAppend,
    skills: patch.skills ?? existing.skills ?? [],
    permissions: sanitizePermissions(patch.permissions, existing.permissions)
  }
  return {
    ...team,
    agents: team.agents.map((agent) => (agent.id === patch.id ? updated : agent))
  }
}

export function updateAgent(patch: AgentRosterPatch): TeamMutationResult {
  const currentTeam = getCurrentTeamConfig()
  if (!currentTeam) {
    throw new AppError('NO_PROJECT', 'Open a project before editing the team.')
  }
  const nextTeam = updateCurrentTeam((team) => updateAgentInTeam(team, patch))
  return mutationResult(nextTeam)
}

export function addAgent(input: AgentCreateInput): TeamMutationResult {
  const currentTeam = getCurrentTeamConfig()
  if (!currentTeam) {
    throw new AppError('NO_PROJECT', 'Open a project before editing the team.')
  }
  const name = input.name.trim()
  if (!name) {
    throw new AppError('INVALID_AGENT', 'An agent name is required.')
  }
  if (currentTeam.agents.length >= 12) {
    throw new AppError('TEAM_LIMIT', 'The team is limited to twelve agents.')
  }
  const color = input.color?.trim() || '#8ab7ff'
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new AppError('INVALID_COLOR', 'Agent color must be a six-digit hex value.')
  }
  const roleKey =
    input.roleKey?.trim() ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) ||
    'specialist'
  const permissions = sanitizePermissions(input.permissions, {
    tools: ['read', 'search', 'memory'],
    writeGlobs: [],
    denyGlobs: ['.agentdesk/agentdesk.db*', '.agentdesk/snapshots/**']
  })
  const agent: AgentConfig = {
    id: `custom-${randomUUID().slice(0, 8)}`,
    name,
    roleKey,
    tagline: input.tagline?.trim() || 'Custom specialist.',
    color,
    enabled: true,
    promptAppend: input.promptAppend?.trim() || '',
    model: null,
    skills: input.skills ?? defaultSkillsForRole(roleKey),
    permissions
  }
  const nextTeam = updateCurrentTeam((team) => ({
    ...team,
    agents: [...team.agents, agent]
  }))
  return mutationResult(nextTeam)
}

export function deleteAgent(agentId: string): TeamMutationResult {
  const currentTeam = getCurrentTeamConfig()
  if (!currentTeam) {
    throw new AppError('NO_PROJECT', 'Open a project before editing the team.')
  }
  const agent = currentTeam.agents.find((entry) => entry.id === agentId)
  if (!agent) {
    throw new AppError('AGENT_NOT_FOUND', 'The selected agent does not exist.')
  }
  if (!agent.id.startsWith('custom-')) {
    throw new AppError(
      'AGENT_PROTECTED',
      'The six default agents cannot be deleted. Disable the agent instead.'
    )
  }
  if (currentTeam.agents.filter((entry) => entry.enabled).length <= 1) {
    throw new AppError('TEAM_LIMIT', 'At least one agent must remain enabled.')
  }
  const nextTeam = updateCurrentTeam((team) => ({
    ...team,
    agents: team.agents.filter((entry) => entry.id !== agentId)
  }))
  return mutationResult(nextTeam)
}
