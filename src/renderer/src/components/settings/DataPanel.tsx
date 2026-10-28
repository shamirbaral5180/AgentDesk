import { useEffect, useState } from 'react'
import type {
  AppSettings,
  AgentConfig,
  DataStats,
  MeetingSummary,
  ProjectInfo,
  ResetScope,
  UsageSummary
} from '@shared/types'
import { Icon } from '../Icon'

type DataPanelProps = {
  project: ProjectInfo | null
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}

function bytes(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

export function DataPanel({ project, settings, onSettingsChanged }: DataPanelProps) {
  const [stats, setStats] = useState<DataStats | null>(null)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retention, setRetention] = useState(settings.retention)
  const [cost, setCost] = useState(settings.costControl)
  const [exportScope, setExportScope] = useState<'project' | 'meeting'>('project')
  const [exportMeeting, setExportMeeting] = useState('')
  const [includeAttachments, setIncludeAttachments] = useState(false)
  const [resetScope, setResetScope] = useState<ResetScope>('personal_memory')
  const [resetAgent, setResetAgent] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [diagnostics, setDiagnostics] = useState('')

  useEffect(() => {
    setRetention(settings.retention)
    setCost(settings.costControl)
  }, [settings])

  useEffect(() => {
    if (!project) {
      setStats(null)
      setUsage(null)
      setMeetings([])
      return
    }
    void refresh()
    void window.agentdesk
      .listMeetings()
      .then((result) => setMeetings(unwrap(result)))
      .catch(() => undefined)
    void window.agentdesk
      .getTeam()
      .then((result) => setAgents(unwrap(result)?.agents ?? []))
      .catch(() => undefined)
  }, [project?.id])

  async function refresh(): Promise<void> {
    if (!project) {
      return
    }
    try {
      const [statsResult, usageResult] = await Promise.all([
        window.agentdesk.getDataStats(),
        window.agentdesk.getUsageSummary()
      ])
      setStats(unwrap(statsResult))
      setUsage(unwrap(usageResult))
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    }
  }

  async function run(label: string, task: () => Promise<string>): Promise<void> {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      setNotice(await task())
      await refresh()
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : String(taskError))
    } finally {
      setBusy(null)
    }
  }

  async function savePreferences(): Promise<void> {
    await run('save', async () => {
      const result = await window.agentdesk.updateSettingsPreferences({
        retention,
        costControl: cost
      })
      onSettingsChanged(unwrap(result))
      return 'Retention and cost settings saved.'
    })
  }

  function backup(): Promise<void> {
    return run('backup', async () => {
      const result = unwrap(await window.agentdesk.backupData())
      return `Backup created: ${result.backupPath ?? 'unknown'}`
    })
  }

  function prune(): Promise<void> {
    return run('prune', async () => {
      const result = unwrap(await window.agentdesk.pruneData())
      const entries = Object.entries(result.pruned)
        .filter(([, value]) => value > 0)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
      return entries ? `Pruned ${entries}.` : 'Nothing was old enough to prune.'
    })
  }

  function vacuum(): Promise<void> {
    return run('vacuum', async () => {
      const result = unwrap(await window.agentdesk.vacuumData())
      return `Vacuum complete: ${bytes(result.bytesBefore)} -> ${bytes(result.bytesAfter)}.`
    })
  }

  function restore(): Promise<void> {
    if (!window.confirm('Restore the newest database backup? Current project data will be replaced.')) {
      return Promise.resolve()
    }
    return run('restore', async () => {
      const result = unwrap(await window.agentdesk.restoreData())
      return `Restored ${result.backupPath ?? 'backup'}. Reopen the project if any view looks stale.`
    })
  }

  function exportData(): Promise<void> {
    return run('export', async () => {
      const result = unwrap(
        await window.agentdesk.exportData({
          scope: exportScope,
          meetingId: exportScope === 'meeting' ? exportMeeting : undefined,
          includeAttachments
        })
      )
      if (!result) {
        return 'Export cancelled.'
      }
      return `Exported ${result.files.length} file(s) to ${result.directory}`
    })
  }

  function reset(): Promise<void> {
    if (resetConfirm !== 'RESET') {
      setError('Type RESET exactly to confirm.')
      return Promise.resolve()
    }
    return run('reset', async () => {
      const result = unwrap(
        await window.agentdesk.resetData({
          scope: resetScope,
          agentId: resetScope === 'personal_memory' && resetAgent ? resetAgent : undefined,
          confirm: resetConfirm
        })
      )
      setResetConfirm('')
      return `Removed ${result.removed} item(s). ${result.notes.join(' ')}`
    })
  }

  function loadDiagnostics(): Promise<void> {
    return run('diagnostics', async () => {
      const bundle = unwrap(await window.agentdesk.getDiagnostics())
      setDiagnostics(bundle.text)
      return 'Diagnostics generated. Secret values are never included.'
    })
  }

  function exportDiagnostics(): Promise<void> {
    return run('diagnostics-export', async () => {
      const result = unwrap(await window.agentdesk.exportDiagnostics())
      return result ? `Diagnostics saved to ${result.files[0]}` : 'Export cancelled.'
    })
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnostics)
      setNotice('Diagnostics copied to the clipboard.')
    } catch {
      setError('The clipboard is unavailable. Export diagnostics to a file instead.')
    }
  }

  if (!project) {
    return (
      <div className="settings-stack">
        <p className="empty-settings">
          Open a project to inspect database health, retention, exports, and recovery.
        </p>
      </div>
    )
  }

  return (
    <div className="settings-stack">
      {notice && <div className="inline-notice success">{notice}</div>}
      {error && <div className="inline-notice error">{error}</div>}

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Database health</h3>
          <span className={stats?.integrity === 'ok' ? 'soft-chip success' : 'soft-chip error'}>
            {stats?.integrity === 'ok' ? 'Healthy' : 'Check failed'}
          </span>
        </div>
        <div className="data-grid">
          <div>
            <span>Database</span>
            <strong>{stats ? bytes(stats.dbBytes + stats.walBytes) : '...'}</strong>
          </div>
          <div>
            <span>Workspace</span>
            <strong>{stats ? bytes(stats.projectBytes) : '...'}</strong>
          </div>
          <div>
            <span>Backups</span>
            <strong>{stats?.backups.length ?? 0}</strong>
          </div>
          <div>
            <span>Last backup</span>
            <strong>
              {stats?.lastBackupAt ? new Date(stats.lastBackupAt).toLocaleString() : 'None'}
            </strong>
          </div>
        </div>
        <p className="field-hint">SQLite quick check: {stats?.quickCheck ?? 'not run'}</p>
        <div className="field-actions">
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void backup()} disabled={Boolean(busy)}>
            Backup now
          </button>
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void prune()} disabled={Boolean(busy)}>
            Prune old data
          </button>
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void vacuum()} disabled={Boolean(busy)}>
            Vacuum
          </button>
          <button className="btn btn-danger btn-small" type="button" onClick={() => void restore()} disabled={Boolean(busy)}>
            Restore newest
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Retention</h3>
          <span className="soft-chip">Days</span>
        </div>
        <div className="retention-grid">
          {(
            [
              ['sessionDays', 'Chat sessions'],
              ['meetingDays', 'Meetings'],
              ['usageDays', 'Usage records'],
              ['mcpAuditDays', 'MCP audit'],
              ['toolCallDays', 'Tool calls'],
              ['commandLogDays', 'Command logs'],
              ['snapshotDays', 'Snapshots'],
              ['databaseBackups', 'DB backups kept']
            ] as const
          ).map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              <input
                type="number"
                min={1}
                max={key === 'databaseBackups' ? 50 : 3650}
                value={retention[key]}
                onChange={(event) =>
                  setRetention((current) => ({
                    ...current,
                    [key]: Number(event.target.value)
                  }))
                }
              />
            </label>
          ))}
        </div>
        <p className="field-hint">
          Active meetings, running runs, and pinned memory are never pruned.
        </p>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Monthly cost guard</h3>
          <span className="soft-chip">{usage ? `$${usage.monthCostUsd.toFixed(2)} this month` : '...'}</span>
        </div>
        <div className="retention-grid">
          <label className="field">
            <span>Cap (USD)</span>
            <input
              type="number"
              min={0}
              step="1"
              value={cost.monthlyCapUsd}
              onChange={(event) =>
                setCost((current) => ({ ...current, monthlyCapUsd: Number(event.target.value) }))
              }
            />
          </label>
          <label className="field">
            <span>Warn at %</span>
            <input
              type="number"
              min={1}
              max={100}
              value={cost.warnPercent}
              onChange={(event) =>
                setCost((current) => ({ ...current, warnPercent: Number(event.target.value) }))
              }
            />
          </label>
          <label className="inline-checkbox">
            <input
              type="checkbox"
              checked={cost.hardStop}
              onChange={(event) => setCost((current) => ({ ...current, hardStop: event.target.checked }))}
            />
            <span>Hard stop at the cap</span>
          </label>
        </div>
        <div className="field-actions">
          <button className="btn btn-primary btn-small" type="button" onClick={() => void savePreferences()} disabled={Boolean(busy)}>
            Save retention and cost
          </button>
        </div>
        {usage && (
          <div className="usage-list">
            {usage.byProvider.length === 0 ? (
              <p className="empty-settings">No usage has been recorded yet.</p>
            ) : (
              usage.byProvider.slice(0, 5).map((group) => (
                <div className="usage-row" key={group.label}>
                  <span>{group.label}</span>
                  <strong>${group.costUsd.toFixed(3)}</strong>
                  <span>{group.records} calls</span>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Export</h3>
          <span className="soft-chip">No secrets</span>
        </div>
        <div className="retention-grid">
          <label className="field">
            <span>Scope</span>
            <select value={exportScope} onChange={(event) => setExportScope(event.target.value as 'project' | 'meeting')}>
              <option value="project">Whole project</option>
              <option value="meeting">One meeting</option>
            </select>
          </label>
          {exportScope === 'meeting' && (
            <label className="field">
              <span>Meeting</span>
              <select value={exportMeeting} onChange={(event) => setExportMeeting(event.target.value)}>
                <option value="">Choose a meeting</option>
                {meetings.map((meeting) => (
                  <option value={meeting.id} key={meeting.id}>
                    {meeting.mode}: {meeting.goal.slice(0, 48)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="inline-checkbox">
            <input
              type="checkbox"
              checked={includeAttachments}
              onChange={(event) => setIncludeAttachments(event.target.checked)}
            />
            <span>Include attachments</span>
          </label>
        </div>
        <div className="field-actions">
          <button
            className="btn btn-primary btn-small"
            type="button"
            onClick={() => void exportData()}
            disabled={Boolean(busy) || (exportScope === 'meeting' && !exportMeeting)}
          >
            <Icon name="arrow-down" size={13} />
            Export JSON + Markdown + CSV
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Reset</h3>
          <span className="soft-chip error">Destructive</span>
        </div>
        <div className="retention-grid">
          <label className="field">
            <span>Scope</span>
            <select value={resetScope} onChange={(event) => setResetScope(event.target.value as ResetScope)}>
              <option value="personal_memory">Personal memory</option>
              <option value="shared_memory">Shared project memory</option>
              <option value="session_memory">Session memory</option>
              <option value="logs_cache">Logs and cache</option>
            </select>
          </label>
          {resetScope === 'personal_memory' && (
            <label className="field">
              <span>Agent (optional)</span>
              <select value={resetAgent} onChange={(event) => setResetAgent(event.target.value)}>
                <option value="">All agents</option>
                {agents.map((agent) => (
                  <option value={agent.id} key={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>Type RESET to confirm</span>
            <input
              value={resetConfirm}
              onChange={(event) => setResetConfirm(event.target.value)}
              placeholder="RESET"
            />
          </label>
        </div>
        <p className="field-hint">
          {resetScope === 'personal_memory'
            ? resetAgent
              ? `Removes personal memory for ${agents.find((agent) => agent.id === resetAgent)?.name ?? resetAgent} only. Shared memory is kept.`
              : 'Removes personal memory for every agent. Shared memory is kept.'
            : resetScope === 'shared_memory'
              ? 'Removes shared project memory. Personal memory is kept.'
              : resetScope === 'session_memory'
                ? 'Removes session summaries. Meetings and chat messages are kept.'
                : 'Removes project logs and temporary files. Database and memory are kept.'}
        </p>
        <div className="field-actions">
          <button className="btn btn-danger btn-small" type="button" onClick={() => void reset()} disabled={Boolean(busy)}>
            Reset selected data
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <h3>Diagnostics</h3>
          <span className="soft-chip">Redacted</span>
        </div>
        <div className="field-actions">
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void loadDiagnostics()} disabled={Boolean(busy)}>
            Generate
          </button>
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void copyDiagnostics()} disabled={!diagnostics}>
            Copy
          </button>
          <button className="btn btn-quiet btn-small" type="button" onClick={() => void exportDiagnostics()} disabled={Boolean(busy)}>
            Export file
          </button>
        </div>
        {diagnostics && <pre className="diagnostics-output">{diagnostics.slice(0, 4_000)}</pre>}
      </section>
    </div>
  )
}
