import { randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  DiscoveryResult,
  ModelDraft,
  ModelMutationResult,
  ModelPatch,
  ModelRecord,
  ProviderConfig,
  ProviderDraft,
  ProviderKeyInput,
  ProviderMutationResult,
  ProviderPatch,
  ProviderType,
  SettingsWithProjectResult
} from '@shared/types'
import { createLogger } from '../config/logger'
import { deleteSecret, getSecret, setSecret } from '../config/secrets'
import { loadSettings, mutateSettings } from '../config/settings'
import { AppError } from '../errors'
import {
  getCurrentProject,
  getCurrentTeamConfig,
  updateCurrentTeam
} from '../project/projectService'
import { providerKeyName } from './keys'
import { discoverModels as discoverModelsRemote } from './modelDiscovery'
import { normalizeProviderBaseUrl } from './urls'

const log = createLogger('providers')

const DEFAULT_NAMES: Record<ProviderType, string> = {
  openai: 'OpenAI',
  google: 'Google Gemini',
  ollama: 'Ollama',
  custom: 'Custom provider'
}

function findProvider(settings: ReturnType<typeof loadSettings>, id: string): ProviderConfig {
  const provider = settings.providers.find((entry) => entry.id === id)
  if (!provider) {
    throw new AppError('PROVIDER_NOT_FOUND', 'Provider not found.')
  }
  return provider
}

function findModel(settings: ReturnType<typeof loadSettings>, id: string): ModelRecord {
  const model = settings.models.find((entry) => entry.id === id)
  if (!model) {
    throw new AppError('MODEL_NOT_FOUND', 'Model not found.')
  }
  return model
}

function providerName(value: string | undefined, type: ProviderType): string {
  const name = value?.trim()
  return (name || DEFAULT_NAMES[type]).slice(0, 80)
}

function modelDisplayName(value: string | undefined, modelId: string): string {
  const name = value?.trim()
  return (name || modelId).slice(0, 120)
}

function optionalPositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function optionalNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function clearAssignments(predicate: (agent: AgentConfig) => boolean): void {
  const team = getCurrentTeamConfig()
  if (!team) {
    return
  }
  if (!team.agents.some(predicate)) {
    return
  }
  updateCurrentTeam((current) => ({
    ...current,
    agents: current.agents.map((agent) =>
      predicate(agent) ? { ...agent, model: null } : agent
    )
  }))
}

function removeSecretQuietly(providerId: string): void {
  try {
    deleteSecret(providerKeyName(providerId))
  } catch (error) {
    log.warn('Could not remove provider secret', { providerId, error })
  }
}

export function createProvider(draft: ProviderDraft): ProviderMutationResult {
  const type = draft.type
  const baseUrl = normalizeProviderBaseUrl(type, draft.baseUrl)
  const now = Date.now()
  const provider: ProviderConfig = {
    id: `prov_${randomUUID()}`,
    type,
    name: type === 'custom' ? providerName(draft.name, type) : DEFAULT_NAMES[type],
    baseUrl,
    enabled: draft.enabled ?? true,
    hasKey: false,
    createdAt: now,
    updatedAt: now
  }

  const apiKey = draft.apiKey?.trim()
  if (apiKey) {
    setSecret(providerKeyName(provider.id), apiKey)
    provider.hasKey = true
  }

  try {
    const settings = mutateSettings((current) => ({
      ...current,
      providers: [...current.providers, provider]
    }))
    log.info('Created provider', { id: provider.id, type, name: provider.name })
    return { settings, provider }
  } catch (error) {
    if (apiKey) {
      removeSecretQuietly(provider.id)
    }
    throw error
  }
}

export function updateProvider(patch: ProviderPatch): ProviderMutationResult {
  const current = loadSettings()
  const existing = findProvider(current, patch.id)
  const next: ProviderConfig = {
    ...existing,
    name:
      existing.type !== 'custom'
        ? existing.name
        : patch.name === undefined
          ? existing.name
          : providerName(patch.name, existing.type),
    baseUrl:
      patch.baseUrl === undefined
        ? existing.baseUrl
        : normalizeProviderBaseUrl(existing.type, patch.baseUrl),
    enabled: patch.enabled ?? existing.enabled,
    updatedAt: Date.now()
  }
  const settings = mutateSettings((value) => ({
    ...value,
    providers: value.providers.map((provider) =>
      provider.id === existing.id ? next : provider
    )
  }))
  log.info('Updated provider', { id: next.id, name: next.name })
  return { settings, provider: next }
}

export function setProviderKey(input: ProviderKeyInput): ProviderMutationResult {
  const current = loadSettings()
  const provider = findProvider(current, input.id)
  const apiKey = input.apiKey.trim()
  if (!apiKey) {
    throw new AppError('INVALID_API_KEY', 'The API key cannot be empty.')
  }
  setSecret(providerKeyName(provider.id), apiKey)
  const next: ProviderConfig = {
    ...provider,
    hasKey: true,
    updatedAt: Date.now()
  }
  const settings = mutateSettings((value) => ({
    ...value,
    providers: value.providers.map((entry) =>
      entry.id === provider.id ? next : entry
    )
  }))
  log.info('Stored provider key', { providerId: provider.id })
  return { settings, provider: next }
}

export function clearProviderKey(id: string): ProviderMutationResult {
  const current = loadSettings()
  const provider = findProvider(current, id)
  removeSecretQuietly(provider.id)
  const next: ProviderConfig = {
    ...provider,
    hasKey: false,
    updatedAt: Date.now()
  }
  const settings = mutateSettings((value) => ({
    ...value,
    providers: value.providers.map((entry) =>
      entry.id === provider.id ? next : entry
    )
  }))
  log.info('Cleared provider key', { providerId: provider.id })
  return { settings, provider: next }
}

export function deleteProvider(id: string): SettingsWithProjectResult {
  const current = loadSettings()
  const provider = findProvider(current, id)
  removeSecretQuietly(provider.id)
  const settings = mutateSettings((value) => ({
    ...value,
    providers: value.providers.filter((entry) => entry.id !== id),
    models: value.models.filter((model) => model.providerId !== id)
  }))
  clearAssignments(
    (agent) => agent.model?.providerConfigId === provider.id
  )
  log.info('Deleted provider', { providerId: provider.id, name: provider.name })
  return {
    settings,
    project: getCurrentProject()
  }
}

export async function discoverProviderModels(id: string): Promise<DiscoveryResult> {
  const current = loadSettings()
  const provider = findProvider(current, id)
  const apiKey = getSecret(providerKeyName(provider.id))
  const discovered = await discoverModelsRemote(provider, apiKey)
  const now = Date.now()
  let added = 0
  let updated = 0

  const settings = mutateSettings((value) => {
    const models = [...value.models]
    for (const item of discovered) {
      const index = models.findIndex(
        (model) =>
          model.providerId === provider.id && model.modelId === item.modelId
      )
      if (index >= 0) {
        const existing = models[index]
        models[index] = {
          ...existing,
          displayName:
            existing.source === 'manual' ? existing.displayName : item.displayName,
          contextWindow: existing.contextWindow ?? item.contextWindow,
          maxOutputTokens: existing.maxOutputTokens ?? item.maxOutputTokens,
          lastSeenAt: now,
          updatedAt: now
        }
        updated += 1
        continue
      }
      models.push({
        id: `model_${randomUUID()}`,
        providerId: provider.id,
        modelId: item.modelId,
        displayName: item.displayName,
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        supportsTools: item.supportsTools,
        supportsVision: item.supportsVision,
        source: 'discovered',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now
      })
      added += 1
    }

    return {
      ...value,
      providers: value.providers.map((entry) =>
        entry.id === provider.id && apiKey && !entry.hasKey
          ? { ...entry, hasKey: true, updatedAt: now }
          : entry
      ),
      models
    }
  })

  log.info('Discovered provider models', {
    providerId: provider.id,
    discovered: discovered.length,
    added,
    updated
  })

  return {
    settings,
    providerId: provider.id,
    discovered: discovered.length,
    added,
    updated
  }
}

export function addModel(draft: ModelDraft): ModelMutationResult {
  const current = loadSettings()
  const provider = findProvider(current, draft.providerId)
  const modelId = draft.modelId.trim()
  if (!modelId) {
    throw new AppError('INVALID_MODEL_ID', 'Enter a model ID.')
  }
  const duplicate = current.models.some(
    (model) =>
      model.providerId === provider.id &&
      model.modelId.toLowerCase() === modelId.toLowerCase()
  )
  if (duplicate) {
    throw new AppError(
      'MODEL_ALREADY_EXISTS',
      'That model is already in the catalog for this provider.'
    )
  }

  const now = Date.now()
  const model: ModelRecord = {
    id: `model_${randomUUID()}`,
    providerId: provider.id,
    modelId,
    displayName: modelDisplayName(draft.displayName, modelId),
    contextWindow: optionalPositive(draft.contextWindow),
    maxOutputTokens: optionalPositive(draft.maxOutputTokens),
    supportsTools: draft.supportsTools ?? false,
    supportsVision: draft.supportsVision ?? false,
    inputPricePerMillion: optionalNonNegative(draft.inputPricePerMillion),
    outputPricePerMillion: optionalNonNegative(draft.outputPricePerMillion),
    source: 'manual',
    createdAt: now,
    updatedAt: now
  }
  const settings = mutateSettings((value) => ({
    ...value,
    models: [...value.models, model]
  }))
  log.info('Added manual model', {
    providerId: provider.id,
    modelId: model.modelId
  })
  return { settings, model }
}

export function updateModel(patch: ModelPatch): ModelMutationResult {
  const current = loadSettings()
  const existing = findModel(current, patch.id)
  const next: ModelRecord = {
    ...existing,
    displayName:
      patch.displayName === undefined
        ? existing.displayName
        : modelDisplayName(patch.displayName, existing.modelId),
    contextWindow:
      patch.contextWindow === undefined
        ? existing.contextWindow
        : optionalPositive(patch.contextWindow),
    maxOutputTokens:
      patch.maxOutputTokens === undefined
        ? existing.maxOutputTokens
        : optionalPositive(patch.maxOutputTokens),
    supportsTools: patch.supportsTools ?? existing.supportsTools,
    supportsVision: patch.supportsVision ?? existing.supportsVision,
    inputPricePerMillion:
      patch.inputPricePerMillion === undefined
        ? existing.inputPricePerMillion
        : optionalNonNegative(patch.inputPricePerMillion),
    outputPricePerMillion:
      patch.outputPricePerMillion === undefined
        ? existing.outputPricePerMillion
        : optionalNonNegative(patch.outputPricePerMillion),
    updatedAt: Date.now()
  }
  const settings = mutateSettings((value) => ({
    ...value,
    models: value.models.map((model) =>
      model.id === existing.id ? next : model
    )
  }))
  return { settings, model: next }
}

export function deleteModel(id: string): SettingsWithProjectResult {
  const current = loadSettings()
  const model = findModel(current, id)
  const settings = mutateSettings((value) => ({
    ...value,
    models: value.models.filter((entry) => entry.id !== id)
  }))
  clearAssignments(
    (agent) =>
      agent.model?.providerConfigId === model.providerId &&
      agent.model.modelId === model.modelId
  )
  log.info('Deleted model', { modelId: model.modelId, providerId: model.providerId })
  return {
    settings,
    project: getCurrentProject()
  }
}
