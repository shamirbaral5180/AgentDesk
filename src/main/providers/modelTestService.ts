import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { streamText } from 'ai'
import {
  IPC_CHANNELS,
  type ModelRecord,
  type ModelTestEvent,
  type ModelTestRequest,
  type ProviderConfig
} from '@shared/types'
import { createLogger } from '../config/logger'
import { loadSettings } from '../config/settings'
import { AppError } from '../errors'
import { createLanguageModel } from './modelGateway'
import { formatProviderError } from './providerErrors'

const log = createLogger('model-test')
const activeTests = new Map<string, AbortController>()

const DEFAULT_TEST_PROMPT =
  'Reply with one short sentence confirming this model connection is working, then name the model you are.'

function sendEvent(sender: WebContents, event: ModelTestEvent): void {
  if (!sender.isDestroyed()) {
    sender.send(IPC_CHANNELS.modelTestEvent, event)
  }
}

function providerFromSettings(id: string): ProviderConfig {
  const settings = loadSettings()
  const provider = settings.providers.find((entry) => entry.id === id)
  if (!provider) {
    throw new AppError('PROVIDER_NOT_FOUND', 'Provider not found.')
  }
  return provider
}

function modelFromSettings(providerId: string, modelId: string): ModelRecord {
  const settings = loadSettings()
  const model = settings.models.find(
    (entry) => entry.providerId === providerId && entry.modelId === modelId
  )
  if (!model) {
    throw new AppError('MODEL_NOT_FOUND', 'Model not found.')
  }
  return model
}

async function runTest(
  sender: WebContents,
  testId: string,
  provider: ProviderConfig,
  model: ModelRecord,
  prompt: string,
  controller: AbortController
): Promise<void> {
  const startedAt = Date.now()
  sendEvent(sender, {
    testId,
    type: 'start',
    providerName: provider.name,
    modelId: model.modelId
  })

  try {
    const languageModel = createLanguageModel(provider, model)
    const result = streamText({
      model: languageModel,
      instructions:
        'You are a connection test inside AgentDesk. Be concise and confirm the connection.',
      prompt,
      maxOutputTokens: 256,
      temperature: 0.2,
      maxRetries: 0,
      timeout: 60_000,
      abortSignal: controller.signal
    })

    let fullText = ''
    for await (const delta of result.textStream) {
      if (controller.signal.aborted) {
        break
      }
      fullText += delta
      sendEvent(sender, {
        testId,
        type: 'delta',
        text: delta
      })
    }

    if (controller.signal.aborted) {
      sendEvent(sender, { testId, type: 'cancelled' })
      return
    }

    const usage = await result.usage
    sendEvent(sender, {
      testId,
      type: 'done',
      text: fullText,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    if (controller.signal.aborted) {
      sendEvent(sender, { testId, type: 'cancelled' })
      return
    }
    const message = formatProviderError(error, provider)
    sendEvent(sender, {
      testId,
      type: 'error',
      message
    })
    log.error('Model test failed', {
      providerId: provider.id,
      modelId: model.modelId,
      message
    })
  } finally {
    activeTests.delete(testId)
  }
}

export function startModelTest(
  sender: WebContents,
  request: ModelTestRequest
): { testId: string } {
  const provider = providerFromSettings(request.providerId)
  const model = modelFromSettings(provider.id, request.modelId)
  if (!provider.enabled) {
    throw new AppError(
      'PROVIDER_DISABLED',
      'Enable this provider before testing a model.'
    )
  }

  const prompt = request.prompt.trim().slice(0, 4000) || DEFAULT_TEST_PROMPT
  const testId = randomUUID()
  const controller = new AbortController()
  activeTests.set(testId, controller)
  void runTest(sender, testId, provider, model, prompt, controller)
  return { testId }
}

export function cancelModelTest(testId: string): void {
  const controller = activeTests.get(testId)
  controller?.abort()
}

export function cancelAllModelTests(): void {
  for (const controller of activeTests.values()) {
    controller.abort()
  }
  activeTests.clear()
}
