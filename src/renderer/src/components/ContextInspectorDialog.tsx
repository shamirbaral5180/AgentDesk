import { useEffect } from 'react'
import type { ChatMessage } from '@shared/types'
import { formatBytes, formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'

type ContextInspectorDialogProps = {
  message: ChatMessage | null
  onClose: () => void
}

function tokenLabel(value: number | undefined): string {
  return value === undefined ? '-' : value.toLocaleString()
}

export function ContextInspectorDialog({
  message,
  onClose
}: ContextInspectorDialogProps) {
  useEffect(() => {
    if (!message) {
      return
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [message, onClose])

  if (!message) {
    return null
  }
  const context = message.metadata?.context
  if (!context) {
    return null
  }
  const usage = context.usage ?? message.metadata?.usage
  const memory = context.memory ?? { entries: [], summaries: [] }

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal context-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="context-modal-icon">
              <Icon name="panel" size={18} />
            </span>
            <div>
              <h2 id="context-modal-title">Context inspector</h2>
              <p>
                {message.senderName}  -  {formatRelativeTime(message.createdAt)}  -  exactly what
                the model received
              </p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close context inspector">
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="modal-body context-modal-body">
          <section className="context-summary-grid">
            <div>
              <span>Mode</span>
              <strong>{context.mode === 'build' ? 'Build' : 'Plan'}</strong>
            </div>
            <div>
              <span>Provider</span>
              <strong>{context.model.providerName}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{context.model.displayName}</strong>
            </div>
            <div>
              <span>Temperature</span>
              <strong>{context.model.temperature.toFixed(2)}</strong>
            </div>
            <div>
              <span>Estimated prompt</span>
              <strong>{context.estimatedPromptTokens.toLocaleString()} tokens</strong>
            </div>
            <div>
              <span>Input tokens</span>
              <strong>{tokenLabel(usage?.inputTokens)}</strong>
            </div>
            <div>
              <span>Output tokens</span>
              <strong>{tokenLabel(usage?.outputTokens)}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{context.durationMs ? `${context.durationMs} ms` : '-'}</strong>
            </div>
            <div>
              <span>History sent</span>
              <strong>
                {context.history.length} messages
                {context.historyOmitted > 0
                  ? `  -  ${context.historyOmitted} omitted`
                  : ''}
              </strong>
            </div>
          </section>

          {context.warnings.length > 0 && (
            <section className="context-warning-box">
              <div className="context-section-heading">
                <Icon name="alert" size={15} />
                <h3>Warnings</h3>
              </div>
              <ul>
                {context.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="context-section">
            <div className="context-section-heading">
              <Icon name="database" size={15} />
              <h3>Memory included</h3>
              <span>
                {memory.entries.length} entries - {memory.summaries.length} summaries
              </span>
            </div>
            {memory.entries.length === 0 && memory.summaries.length === 0 ? (
              <p className="context-empty">No memory was included for this run.</p>
            ) : (
              <div className="context-memory-list">
                {memory.summaries.map((summary) => (
                  <details className="context-file" key={`${summary.scope}-${summary.level}`}>
                    <summary>
                      <code>
                        {summary.scope} {summary.level} summary
                      </code>
                      <span>{summary.content.length.toLocaleString()} chars</span>
                    </summary>
                    <pre>{summary.content}</pre>
                  </details>
                ))}
                {memory.entries.map((entry) => (
                  <details className="context-file" key={entry.id}>
                    <summary>
                      <code>
                        {entry.scope}/{entry.kind} - {entry.title}
                      </code>
                      <span>
                        {entry.pinned ? 'pinned - ' : ''}
                        score {entry.score.toFixed(2)}
                      </span>
                    </summary>
                    <pre>{entry.content}</pre>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="context-section">
            <div className="context-section-heading">
              <Icon name="sparkles" size={15} />
              <h3>Tool definitions</h3>
              <span>{context.tools.length} offered</span>
            </div>
            {context.tools.length === 0 ? (
              <p className="context-empty">No tools were offered for this run.</p>
            ) : (
              <div className="context-tool-list">
                {context.tools.map((tool) => (
                  <div className="context-tool-row" key={tool.name}>
                    <code>{tool.name}</code>
                    <span>{tool.description}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {(message.metadata?.toolCalls?.length ?? 0) > 0 && (
            <section className="context-section">
              <div className="context-section-heading">
                <Icon name="terminal" size={15} />
                <h3>Tool calls and results</h3>
                <span>{message.metadata?.toolCalls?.length ?? 0} calls</span>
              </div>
              <div className="context-tool-list">
                {message.metadata?.toolCalls?.map((tool) => (
                  <details className="context-file" key={tool.toolCallId}>
                    <summary>
                      <code>{tool.toolName}</code>
                      <span>
                        {tool.status === 'error'
                          ? 'failed'
                          : `${tool.durationMs ?? 0} ms`}
                      </span>
                    </summary>
                    <div className="context-tool-payload">
                      <span>Input</span>
                      <pre>{JSON.stringify(tool.input, null, 2)}</pre>
                      {tool.output !== undefined && (
                        <>
                          <span>Output returned to the model</span>
                          <pre>
                            {(() => {
                              const value =
                                typeof tool.output === 'string'
                                  ? tool.output
                                  : JSON.stringify(tool.output, null, 2)
                              return value.length > 8000
                                ? `${value.slice(0, 8000)}\n...`
                                : value
                            })()}
                          </pre>
                        </>
                      )}
                      {tool.error && <p className="tool-error">{tool.error}</p>}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}

          <section className="context-section">
            <div className="context-section-heading">
              <Icon name="chat" size={15} />
              <h3>Messages sent</h3>
              <span>{context.history.length} included</span>
            </div>
            <div className="context-history-list">
              {context.history.map((item, index) => (
                <div className="context-history-row" key={`${item.role}-${index}`}>
                  <span className={`context-role ${item.role}`}>{item.role}</span>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.text}</p>
                    {item.imageCount > 0 && (
                      <em>
                        {item.imageCount} image{item.imageCount === 1 ? '' : 's'} included
                      </em>
                    )}
                    {item.toolNames.length > 0 && (
                      <em>Tools used: {item.toolNames.join(', ')}</em>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="context-section">
            <div className="context-section-heading">
              <Icon name="file" size={15} />
              <h3>Context files</h3>
              <span>
                {context.contextFiles.filter((file) => file.exists).length} loaded
              </span>
            </div>
            <div className="context-file-list">
              {context.contextFiles.map((file) => (
                <details className="context-file" key={file.path}>
                  <summary>
                    <code>{file.path}</code>
                    <span>
                      {file.exists ? formatBytes(file.chars) : 'not found'}
                      {file.truncated ? '  -  truncated' : ''}
                    </span>
                  </summary>
                  <pre>{file.exists ? file.content : '(file not found)'}</pre>
                </details>
              ))}
            </div>
          </section>

          <section className="context-section">
            <div className="context-section-heading">
              <Icon name="terminal" size={15} />
              <h3>System prompt</h3>
              <span>{context.system.length.toLocaleString()} chars</span>
            </div>
            <pre className="context-system-prompt">{context.system}</pre>
          </section>
        </div>

        <footer className="modal-footer">
          <span className="modal-footer-note">
            <Icon name="lock" size={14} />
            This snapshot is stored with the message inside the project database.
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}






