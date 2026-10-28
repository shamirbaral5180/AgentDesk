import { useEffect, useRef, useState } from 'react'
import type { ModelRecord, ModelTestEvent, ProviderConfig } from '@shared/types'
import { Icon } from '../Icon'

type ModelTestDialogProps = {
  provider: ProviderConfig
  model: ModelRecord
  onClose: () => void
}

type TestStatus = 'idle' | 'starting' | 'streaming' | 'done' | 'error' | 'cancelled'

const DEFAULT_PROMPT =
  'Reply with one short sentence confirming this model connection is working, then name the model you are.'

export function ModelTestDialog({ provider, model, onClose }: ModelTestDialogProps) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [output, setOutput] = useState('')
  const [status, setStatus] = useState<TestStatus>('idle')
  const [error, setError] = useState('')
  const [usage, setUsage] = useState<{ input?: number; output?: number; duration?: number }>({})
  const testIdRef = useRef<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.agentdesk.onModelTestEvent((event: ModelTestEvent) => {
      if (!testIdRef.current) {
        testIdRef.current = event.testId
      }
      if (event.testId !== testIdRef.current) {
        return
      }
      if (event.type === 'start') {
        setStatus('streaming')
        return
      }
      if (event.type === 'delta') {
        setStatus('streaming')
        setOutput((current) => current + event.text)
        return
      }
      if (event.type === 'done') {
        setStatus('done')
        setOutput(event.text)
        setUsage({
          input: event.inputTokens,
          output: event.outputTokens,
          duration: event.durationMs
        })
        return
      }
      if (event.type === 'error') {
        setStatus('error')
        setError(event.message)
        return
      }
      if (event.type === 'cancelled') {
        setStatus('cancelled')
      }
    })
    return () => {
      unsubscribe()
      if (testIdRef.current) {
        void window.agentdesk.cancelModelTest(testIdRef.current)
        testIdRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function runTest(): Promise<void> {
    if (!prompt.trim()) {
      setError('Enter a prompt first.')
      setStatus('error')
      return
    }
    setOutput('')
    setError('')
    setUsage({})
    setStatus('starting')
    testIdRef.current = null
    try {
      const result = await window.agentdesk.startModelTest({
        providerId: provider.id,
        modelId: model.modelId,
        prompt: prompt.trim()
      })
      if (!result.ok) {
        setStatus('error')
        setError(result.error.message)
        return
      }
      testIdRef.current = result.data.testId
    } catch (startError) {
      setStatus('error')
      setError(startError instanceof Error ? startError.message : 'Could not start the test.')
    }
  }

  function stopTest(): void {
    if (testIdRef.current) {
      void window.agentdesk.cancelModelTest(testIdRef.current)
      testIdRef.current = null
    }
    setStatus('cancelled')
  }

  function closeDialog(): void {
    if (testIdRef.current) {
      void window.agentdesk.cancelModelTest(testIdRef.current)
      testIdRef.current = null
    }
    onClose()
  }

  const running = status === 'starting' || status === 'streaming'
  const statusLabel =
    status === 'idle'
      ? 'Ready'
      : status === 'starting'
        ? 'Connecting'
        : status === 'streaming'
          ? 'Streaming'
          : status === 'done'
            ? 'Completed'
            : status === 'cancelled'
              ? 'Cancelled'
              : 'Failed'

  return (
    <div className="modal-backdrop test-backdrop" onMouseDown={closeDialog} role="presentation">
      <div
        className="test-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-test-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="test-header">
          <div className="test-title-group">
            <span className="test-icon">
              <Icon name="terminal" size={18} />
            </span>
            <div>
              <span className="eyebrow">Live connection test</span>
              <h2 id="model-test-title">{model.displayName}</h2>
              <p>
                {provider.name} <span> - </span> <code>{model.modelId}</code>
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={closeDialog} aria-label="Close test">
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="test-body">
          <label className="field">
            <span>Test prompt</span>
            <textarea
              className="test-prompt"
              rows={3}
              value={prompt}
              maxLength={4000}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={running}
            />
          </label>

          <div className="test-toolbar">
            <span className={`test-status ${status}`}>
              <span className="status-dot" />
              {statusLabel}
            </span>
            <div className="test-actions">
              {running ? (
                <button className="btn btn-ghost btn-small" type="button" onClick={stopTest}>
                  Stop
                </button>
              ) : (
                <button className="btn btn-primary btn-small" type="button" onClick={() => void runTest()}>
                  <Icon name="sparkles" size={14} />
                  Run test
                </button>
              )}
            </div>
          </div>

          <div className={`test-output ${status}`} aria-live="polite">
            {output ? (
              <pre>{output}</pre>
            ) : status === 'error' ? (
              <div className="test-error">
                <Icon name="alert" size={16} />
                {error}
              </div>
            ) : status === 'starting' ? (
              <span className="test-placeholder">Opening the connection...</span>
            ) : status === 'streaming' ? (
              <span className="test-placeholder">Waiting for the first token...</span>
            ) : (
              <span className="test-placeholder">
                Run the test to stream a real response from this model.
              </span>
            )}
            {running && <span className="stream-caret" />}
          </div>

          {(usage.input !== undefined || usage.output !== undefined) && (
            <div className="test-usage">
              <span>
                <Icon name="clock" size={13} />
                {usage.duration ? `${(usage.duration / 1000).toFixed(1)}s` : 'Completed'}
              </span>
              <span>{usage.input ?? 0} input tokens</span>
              <span>{usage.output ?? 0} output tokens</span>
            </div>
          )}
        </div>

        <footer className="test-footer">
          <span>
            Stored keys are resolved in the main process and never sent back to the interface.
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={closeDialog}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

