export function formatRelativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  if (delta < 60_000) {
    return 'Just now'
  }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return `${days}d ago`
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return ''
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
}

export function shortPath(value: string, maxLength = 54): string {
  if (value.length <= maxLength) {
    return value
  }
  const head = value.slice(0, Math.floor(maxLength / 2) - 2)
  const tail = value.slice(-Math.floor(maxLength / 2))
  return `${head}...${tail}`
}

export function commandOrFallback(value: string | undefined): string {
  return value ?? 'Not detected'
}

export function agentModelLabel(
  settings: import('@shared/types').AppSettings,
  agent: import('@shared/types').AgentSummary
): string | null {
  if (!agent.model) {
    return null
  }
  const model = settings.models.find(
    (entry) =>
      entry.providerId === agent.model?.providerConfigId &&
      entry.modelId === agent.model?.modelId
  )
  const provider = settings.providers.find(
    (entry) => entry.id === agent.model?.providerConfigId
  )
  if (!model) {
    return agent.modelLabel
  }
  return `${provider?.name ?? agent.model.providerType} / ${model.displayName}`
}
