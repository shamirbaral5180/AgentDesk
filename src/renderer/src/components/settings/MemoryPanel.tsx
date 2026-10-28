import { useEffect, useState } from 'react'
import type {
  MemoryBundle,
  MemoryEntry,
  ProjectInfo
} from '@shared/types'
import { formatRelativeTime } from '../../lib/format'
import { Icon } from '../Icon'

type MemoryPanelProps = {
  project: ProjectInfo | null
}

type ScopeFilter = 'all' | 'personal' | 'shared'

function summaryLabel(summary: import('@shared/types').MemorySummary): string {
  if (summary.scope === 'session') {
    return `Session summary${summary.sessionId ? ` - ${summary.sessionId.slice(0, 8)}` : ''}`
  }
  return `${summary.scope} rolling summary`
}

export function MemoryPanel({ project }: MemoryPanelProps) {
  const [bundle, setBundle] = useState<MemoryBundle>({ entries: [], summaries: [] })
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!project) {
      setBundle({ entries: [], summaries: [] })
      return
    }
    setLoading(true)
    setError('')
    window.agentdesk
      .listMemory()
      .then((result) => {
        if (cancelled) {
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setBundle(result.data)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load memory.')
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
  }, [project?.id])

  async function togglePin(entry: MemoryEntry): Promise<void> {
    setBusyId(entry.id)
    setError('')
    try {
      const result = await window.agentdesk.setMemoryPinned({
        id: entry.id,
        pinned: !entry.pinned
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setBundle((current) => ({
        ...current,
        entries: current.entries
          .map((item) => (item.id === result.data.id ? result.data : item))
          .sort((a, b) => {
            if (a.pinned !== b.pinned) {
              return a.pinned ? -1 : 1
            }
            return b.updatedAt - a.updatedAt
          })
      }))
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : 'Could not pin the memory.')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(entry: MemoryEntry): Promise<void> {
    if (!window.confirm(`Delete this memory: "${entry.title}"?`)) {
      return
    }
    setBusyId(entry.id)
    setError('')
    try {
      const result = await window.agentdesk.deleteMemory(entry.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setBundle((current) => ({
        ...current,
        entries: current.entries.filter((item) => item.id !== entry.id)
      }))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not delete the memory.')
    } finally {
      setBusyId(null)
    }
  }

  if (!project) {
    return (
      <div className="memory-panel">
        <div className="settings-empty-state">
          <span className="settings-empty-icon">
            <Icon name="database" size={23} />
          </span>
          <h3>No project is open</h3>
          <p>Open a project to inspect its personal and shared memory.</p>
        </div>
      </div>
    )
  }

  const normalizedSearch = search.trim().toLowerCase()
  const entries = bundle.entries
    .filter((entry) => scope === 'all' || entry.scope === scope)
    .filter(
      (entry) =>
        !normalizedSearch ||
        `${entry.title}\n${entry.content}\n${entry.kind}`
          .toLowerCase()
          .includes(normalizedSearch)
    )
  const pinnedCount = bundle.entries.filter((entry) => entry.pinned).length
  const personalCount = bundle.entries.filter((entry) => entry.scope === 'personal').length
  const sharedCount = bundle.entries.filter((entry) => entry.scope === 'shared').length

  return (
    <div className="memory-panel">
      <div className="memory-toolbar">
        <div>
          <span className="eyebrow">Continuity</span>
          <h3>Project memory</h3>
          <p>
            Turn reports, commitments, blockers, decisions, and rolling summaries for this
            project. Pinned entries are prioritized during recall.
          </p>
        </div>
        <div className="memory-stats">
          <span>
            <strong>{bundle.entries.length}</strong> active
          </span>
          <span>
            <strong>{personalCount}</strong> personal
          </span>
          <span>
            <strong>{sharedCount}</strong> shared
          </span>
          <span>
            <strong>{pinnedCount}</strong> pinned
          </span>
        </div>
      </div>

      <div className="memory-controls">
        <div className="memory-filters">
          {(['all', 'personal', 'shared'] as ScopeFilter[]).map((value) => (
            <button
              className={scope === value ? 'memory-filter active' : 'memory-filter'}
              key={value}
              type="button"
              onClick={() => setScope(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <input
          className="memory-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search memory..."
          aria-label="Search memory"
        />
      </div>

      {error && <p className="form-notice error">{error}</p>}

      {loading ? (
        <div className="settings-loading">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <>
          {bundle.summaries.length > 0 && (
            <section className="memory-summaries">
              <div className="memory-section-label">Rolling summaries</div>
              {bundle.summaries.slice(0, 6).map((summary) => (
                <details className="memory-summary" key={summary.id}>
                  <summary>
                    <span>{summaryLabel(summary)}</span>
                    <code>v{summary.version}</code>
                    <span>{formatRelativeTime(summary.updatedAt)}</span>
                  </summary>
                  <pre>{summary.content}</pre>
                </details>
              ))}
            </section>
          )}

          <section className="memory-entries">
            <div className="memory-section-label">
              Memories <span>{entries.length} shown</span>
            </div>
            {entries.length === 0 ? (
              <div className="settings-empty-state">
                <span className="settings-empty-icon">
                  <Icon name="sparkles" size={23} />
                </span>
                <h3>No memories match</h3>
                <p>Complete a turn or change the filters to see stored project memory.</p>
              </div>
            ) : (
              entries.map((entry) => (
                <article className={entry.pinned ? 'memory-entry pinned' : 'memory-entry'} key={entry.id}>
                  <div className="memory-entry-head">
                    <span className={`memory-kind ${entry.kind}`}>{entry.kind.replaceAll('_', ' ')}</span>
                    <span className={`memory-scope ${entry.scope}`}>{entry.scope}</span>
                    <span className="memory-time">{formatRelativeTime(entry.updatedAt)}</span>
                    {entry.pinned && (
                      <span className="memory-pinned-label">
                        <Icon name="check" size={11} />
                        pinned
                      </span>
                    )}
                    <div className="memory-entry-actions">
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => void togglePin(entry)}
                        disabled={busyId === entry.id}
                        title={entry.pinned ? 'Unpin memory' : 'Pin memory'}
                        aria-label={entry.pinned ? 'Unpin memory' : 'Pin memory'}
                      >
                        <Icon name="check" size={14} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => void remove(entry)}
                        disabled={busyId === entry.id}
                        title="Delete memory"
                        aria-label="Delete memory"
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  </div>
                  <strong className="memory-entry-title">{entry.title}</strong>
                  <p className="memory-entry-preview">
                    {entry.content.replace(/\s+/g, ' ').slice(0, 320)}
                    {entry.content.length > 320 ? '...' : ''}
                  </p>
                  <details className="memory-entry-full">
                    <summary>Show full memory</summary>
                    <pre>{entry.content}</pre>
                  </details>
                  <div className="memory-entry-meta">
                    <span>{entry.agentId ?? 'shared'}</span>
                    <span>importance {entry.importance.toFixed(2)}</span>
                    {entry.sessionId && <span>session {entry.sessionId.slice(0, 8)}</span>}
                  </div>
                </article>
              ))
            )}
          </section>
        </>
      )}

      <p className="settings-note">
        Memories are stored in this project's SQLite database. Deleting a memory only hides it
        from recall and the viewer; snapshots and change history remain intact.
      </p>
    </div>
  )
}



