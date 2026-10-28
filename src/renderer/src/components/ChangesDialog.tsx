import { useEffect, useState } from 'react'
import type { ChangeRecord } from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'

type ChangesDialogProps = {
  sessionId: string
  onClose: () => void
  onFilesChanged: () => void
}

function changeLabel(change: ChangeRecord): string {
  switch (change.type) {
    case 'write':
      return 'Wrote file'
    case 'patch':
      return 'Patched file'
    case 'delete':
      return 'Deleted file'
    case 'move':
      return 'Moved file'
    case 'revert':
      return 'Reverted file'
    case 'command':
      return 'Ran command'
    default:
      return 'Changed project'
  }
}

function changeIcon(change: ChangeRecord): 'file' | 'terminal' | 'refresh' | 'arrow-right' {
  if (change.type === 'command') {
    return 'terminal'
  }
  if (change.type === 'revert') {
    return 'refresh'
  }
  if (change.type === 'move') {
    return 'arrow-right'
  }
  return 'file'
}

export function ChangesDialog({ sessionId, onClose, onFilesChanged }: ChangesDialogProps) {
  const [changes, setChanges] = useState<ChangeRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [revertingId, setRevertingId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.agentdesk
      .listChanges(sessionId)
      .then((result) => {
        if (cancelled) {
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setChanges(result.data)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load changes.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function revert(change: ChangeRecord): Promise<void> {
    if (!change.canRevert || revertingId) {
      return
    }
    const confirmed = window.confirm(
      `Revert this change to ${change.path ?? 'the project'}? Later edits to the same path may also be overwritten.`
    )
    if (!confirmed) {
      return
    }
    setRevertingId(change.id)
    setError('')
    try {
      const result = await window.agentdesk.revertChange(change.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setChanges(result.data.changes)
      onFilesChanged()
    } catch (revertError) {
      setError(
        revertError instanceof Error ? revertError.message : 'The change could not be reverted.'
      )
    } finally {
      setRevertingId(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="modal changes-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changes-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <span className="changes-modal-icon">
              <Icon name="clock" size={18} />
            </span>
            <div>
              <h2 id="changes-title">Changes</h2>
              <p>File edits, snapshots, and commands recorded in this conversation.</p>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close changes">
            <Icon name="close" size={17} />
          </button>
        </header>

        <div className="modal-body changes-body">
          {error && (
            <div className="approval-error">
              <Icon name="alert" size={14} />
              {error}
            </div>
          )}
          {loading ? (
            <div className="settings-loading">
              <span />
              <span />
              <span />
            </div>
          ) : changes.length === 0 ? (
            <div className="settings-empty-state">
              <span className="settings-empty-icon">
                <Icon name="file" size={23} />
              </span>
              <h3>No changes yet</h3>
              <p>Build mode will record file writes, patches, deletes, moves, and commands here.</p>
            </div>
          ) : (
            <div className="changes-list">
              {changes.map((change) => (
                <div className="change-row" key={change.id}>
                  <span className={`change-icon ${change.type}`}>
                    <Icon name={changeIcon(change)} size={15} />
                  </span>
                  <div className="change-copy">
                    <div className="change-title-row">
                      <strong>{changeLabel(change)}</strong>
                      <span>{formatRelativeTime(change.createdAt)}</span>
                    </div>
                    {change.type === 'command' ? (
                      <code className="change-path">{change.command}</code>
                    ) : (
                      <code className="change-path">{change.path}</code>
                    )}
                    {change.type === 'command' && (
                      <span
                        className={
                          change.exitCode === 0
                            ? 'change-exit success'
                            : 'change-exit failure'
                        }
                      >
                        exit {change.exitCode ?? 'running'}
                      </span>
                    )}
                    {change.beforeHash && change.afterHash && (
                      <span className="change-hash">
                        {change.beforeHash.slice(0, 8) || 'absent'} to{' '}
                        {change.afterHash.slice(0, 8) || 'absent'}
                      </span>
                    )}
                  </div>
                  {change.canRevert && (
                    <button
                      className="btn btn-quiet btn-small"
                      type="button"
                      onClick={() => void revert(change)}
                      disabled={Boolean(revertingId)}
                    >
                      <Icon name="refresh" size={13} />
                      {revertingId === change.id ? 'Reverting...' : 'Revert'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <span className="modal-footer-note">
            <Icon name="shield" size={14} />
            Snapshots live inside the project workspace and travel with the repository.
          </span>
          <button className="btn btn-quiet btn-small" type="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}

