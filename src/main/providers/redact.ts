export function redactSecrets(
  value: string,
  secrets: Array<string | null | undefined> = []
): string {
  let result = value
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join('[redacted]')
    }
  }
  result = result.replace(
    /([?&](?:key|api[_-]?key|token|access_token)=)[^&\s]+/gi,
    '$1[redacted]'
  )
  result = result.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
  result = result.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
  result = result.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]')
  return result
}
