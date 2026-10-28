import type { ProviderConfig } from '@shared/types'
import { getSecret } from '../config/secrets'
import { providerKeyName } from './keys'
import { redactSecrets } from './redact'

export function formatProviderError(error: unknown, provider: ProviderConfig): string {
  const raw = error instanceof Error ? error.message : String(error)
  const sanitized = redactSecrets(raw, [getSecret(providerKeyName(provider.id))])

  if (/401|403|unauthorized|invalid api key|authentication/i.test(sanitized)) {
    return 'Authentication failed. Check this provider\'s API key.'
  }
  if (/404|not found|does not exist/i.test(sanitized)) {
    return 'The model or endpoint was not found. Check the model ID and base URL.'
  }
  if (/429|rate limit|too many requests/i.test(sanitized)) {
    return 'The provider is rate limiting requests. Try again in a moment.'
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(sanitized)) {
    return `Could not reach ${provider.name}. Check that the provider is running and reachable.`
  }
  if (/context length|too many tokens|maximum context/i.test(sanitized)) {
    return 'The conversation is too long for this model. Start a new chat or use a smaller context.'
  }
  return sanitized.slice(0, 800) || 'The model request failed.'
}
