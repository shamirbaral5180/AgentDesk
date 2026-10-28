import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelRecord, ProviderConfig } from '@shared/types'
import { getSecret } from '../config/secrets'
import { AppError } from '../errors'
import { providerKeyName } from './keys'
import { openAICompatibleBaseUrl } from './urls'

export function createLanguageModel(
  provider: ProviderConfig,
  model: ModelRecord
) {
  const apiKey = getSecret(providerKeyName(provider.id))

  if (provider.type === 'openai') {
    if (!apiKey) {
      throw new AppError(
        'PROVIDER_KEY_MISSING',
        'This OpenAI provider has no API key.'
      )
    }
    return createOpenAI({
      apiKey,
      baseURL: provider.baseUrl
    })(model.modelId)
  }

  if (provider.type === 'google') {
    if (!apiKey) {
      throw new AppError(
        'PROVIDER_KEY_MISSING',
        'This Google provider has no API key.'
      )
    }
    return createGoogle({
      apiKey,
      baseURL: provider.baseUrl
    })(model.modelId)
  }

  if (provider.type === 'ollama') {
    return createOpenAICompatible({
      name: 'ollama',
      baseURL: openAICompatibleBaseUrl(provider),
      apiKey: apiKey ?? 'ollama',
      includeUsage: true
    })(model.modelId)
  }

  if (!provider.baseUrl) {
    throw new AppError(
      'PROVIDER_BASE_URL_MISSING',
      'This custom provider has no base URL.'
    )
  }

  return createOpenAICompatible({
    name: 'custom',
    baseURL: provider.baseUrl,
    apiKey: apiKey ?? 'not-needed',
    includeUsage: true
  })(model.modelId)
}
