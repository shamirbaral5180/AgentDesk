import type { AgentDeskApi } from '@shared/types'

declare global {
  interface Window {
    agentdesk: AgentDeskApi
  }
}

export {}
