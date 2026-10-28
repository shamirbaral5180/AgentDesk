import type { ProviderConfig } from '@shared/types'
import { AppError } from '../errors'
import { redactSecrets } from './redact'
import { providerModelsEndpoint } from './urls'

export type DiscoveredModel = {
  modelId: string
  displayName: string
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsVision: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function httpError(
  response: Response,
  body: string,
  secrets: string[],
  endpoint: string
): AppError {
  const detail = redactSecrets(body.slice(0, 1200), secrets)
  if (response.status === 401 || response.status === 403) {
    return new AppError(
      'PROVIDER_AUTH_FAILED',
      'Authentication failed. Check the API key for this provider.',
      detail || `HTTP ${response.status}`
    )
  }
  if (response.status === 404) {
    return new AppError(
      'PROVIDER_ENDPOINT_NOT_FOUND',
      'The provider endpoint was not found. Check the base URL.',
      `${endpoint}${detail ? `\n${detail}` : ''}`
    )
  }
  if (response.status === 429) {
    return new AppError(
      'PROVIDER_RATE_LIMITED',
      'The provider is rate limiting requests. Try again in a moment.',
      detail
    )
  }
  return new AppError(
    'PROVIDER_REQUEST_FAILED',
    `The provider returned HTTP ${response.status}.`,
    detail || undefined
  )
}

async function fetchJson(
  endpoint: string,
  headers: Record<string, string>,
  secrets: string[]
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AppError(
      'PROVIDER_UNREACHABLE',
      'Could not reach the provider. Check that it is running and the base URL is correct.',
      redactSecrets(`${endpoint}\n${message}`, secrets)
    )
  }

  const body = await readResponseBody(response)
  if (!response.ok) {
    throw httpError(response, body, secrets, endpoint)
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new AppError(
      'PROVIDER_INVALID_RESPONSE',
      'The provider returned a response that is not valid JSON.',
      redactSecrets(body.slice(0, 500), secrets)
    )
  }
}

function openAIModelLooksChatCapable(modelId: string): boolean {
  return !/(embedding|whisper|tts|dall-e|moderation|transcribe|rerank|image|audio)/i.test(
    modelId
  )
}

function openAICapabilities(modelId: string): {
  supportsTools: boolean
  supportsVision: boolean
} {
  const id = modelId.toLowerCase()
  return {
    supportsTools: /^(gpt-|chatgpt|o[1-9]|codex)/.test(id),
    supportsVision:
      /(gpt-4o|gpt-4\.1|gpt-5|gpt-6|o[1-9]|vision|multimodal)/.test(id)
  }
}

function parseOpenAICompatible(
  payload: unknown,
  provider: ProviderConfig
): DiscoveredModel[] {
  if (!isRecord(payload)) {
    throw new AppError(
      'PROVIDER_INVALID_RESPONSE',
      'The provider returned an unexpected models response.'
    )
  }

  const data = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : null
  if (!data) {
    throw new AppError(
      'PROVIDER_INVALID_RESPONSE',
      'The provider models response does not contain a model list.'
    )
  }

  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    const modelId = isRecord(entry)
      ? readString(entry.id)
      : typeof entry === 'string'
        ? readString(entry)
        : null
    if (!modelId || seen.has(modelId)) {
      continue
    }
    if (
      (provider.type === 'openai' || provider.type === 'custom') &&
      !openAIModelLooksChatCapable(modelId)
    ) {
      continue
    }
    seen.add(modelId)
    const capabilities = openAICapabilities(modelId)
    models.push({
      modelId,
      displayName: modelId,
      supportsTools: capabilities.supportsTools,
      supportsVision: capabilities.supportsVision
    })
  }
  return models
}

function parseGoogle(payload: unknown): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new AppError(
      'PROVIDER_INVALID_RESPONSE',
      'Google returned an unexpected models response.'
    )
  }

  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of payload.models) {
    if (!isRecord(entry)) {
      continue
    }
    const rawName = readString(entry.name)
    if (!rawName) {
      continue
    }
    const modelId = rawName.replace(/^models\//, '')
    if (!modelId || seen.has(modelId)) {
      continue
    }
    const methods = Array.isArray(entry.supportedGenerationMethods)
      ? entry.supportedGenerationMethods.filter(
          (method): method is string => typeof method === 'string'
        )
      : []
    if (methods.length > 0 && !methods.includes('generateContent')) {
      continue
    }
    if (/embedding|aqa/i.test(modelId)) {
      continue
    }
    seen.add(modelId)
    models.push({
      modelId,
      displayName: readString(entry.displayName) ?? modelId,
      contextWindow: readNumber(entry.inputTokenLimit),
      maxOutputTokens: readNumber(entry.outputTokenLimit),
      supportsTools: true,
      supportsVision: true
    })
  }
  return models
}

function parseOllama(payload: unknown): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new AppError(
      'PROVIDER_INVALID_RESPONSE',
      'Ollama returned an unexpected models response.'
    )
  }

  const models: DiscoveredModel[] = []
  const seen = new Set<string>()
  for (const entry of payload.models) {
    if (!isRecord(entry)) {
      continue
    }
    const modelId = readString(entry.name) ?? readString(entry.model)
    if (!modelId || seen.has(modelId)) {
      continue
    }
    seen.add(modelId)
    models.push({
      modelId,
      displayName: modelId,
      supportsTools: false,
      supportsVision: /(vision|llava|bakllava|qwen.*vl|gemma3)/i.test(modelId)
    })
  }
  return models
}

export async function discoverModels(
  provider: ProviderConfig,
  apiKey: string | null
): Promise<DiscoveredModel[]> {
  const secrets = [apiKey].filter((value): value is string => Boolean(value))
  if ((provider.type === 'openai' || provider.type === 'google') && !apiKey) {
    throw new AppError(
      'PROVIDER_KEY_MISSING',
      'Add an API key for this provider before discovering models.'
    )
  }

  const endpoint = providerModelsEndpoint(provider)
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }

  if (provider.type === 'google') {
    headers['x-goog-api-key'] = apiKey ?? ''
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }

  const payload = await fetchJson(endpoint, headers, secrets)

  if (provider.type === 'google') {
    return parseGoogle(payload)
  }
  if (provider.type === 'ollama') {
    return parseOllama(payload)
  }
  return parseOpenAICompatible(payload, provider)
}
