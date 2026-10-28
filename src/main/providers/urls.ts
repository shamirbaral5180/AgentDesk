import type { ProviderConfig, ProviderType } from '@shared/types'
import { AppError } from '../errors'

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://127.0.0.1:11434',
  custom: ''
}

function ensureUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AppError('INVALID_BASE_URL', 'Enter a valid provider base URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('INVALID_BASE_URL', 'The base URL must use http or https.')
  }
  if (parsed.username || parsed.password) {
    throw new AppError('INVALID_BASE_URL', 'Base URLs cannot contain credentials.')
  }
  return parsed
}

export function normalizeProviderBaseUrl(
  type: ProviderType,
  rawValue?: string
): string {
  const fallback = DEFAULT_BASE_URLS[type]
  const value = (rawValue?.trim() || fallback).replace(/\/+$/, '')
  if (!value) {
    throw new AppError(
      'INVALID_BASE_URL',
      'A base URL is required for a custom provider.'
    )
  }
  const parsed = ensureUrl(value)
  if (type === 'openai' && (parsed.pathname === '/' || parsed.pathname === '')) {
    return `${parsed.origin}/v1`
  }
  if (type === 'google' && (parsed.pathname === '/' || parsed.pathname === '')) {
    return `${parsed.origin}/v1beta`
  }
  if (type === 'ollama') {
    return value.replace(/\/v1$/, '')
  }
  return value
}

export function providerModelsEndpoint(provider: ProviderConfig): string {
  if (provider.type === 'ollama') {
    return `${provider.baseUrl}/api/tags`
  }
  return `${provider.baseUrl}/models`
}

export function openAICompatibleBaseUrl(provider: ProviderConfig): string {
  if (provider.type === 'ollama') {
    return `${provider.baseUrl}/v1`
  }
  return provider.baseUrl
}
