import { useEffect, useState } from 'react'
import type {
  McpCallAudit,
  McpProjectConfig,
  McpServerView,
  McpToolPolicy,
  McpTransport,
  ProjectInfo,
  TeamConfig
} from '@shared/types'
import { formatRelativeTime } from '../../lib/format'
import { Icon } from '../Icon'

type McpPanelProps = {
  project: ProjectInfo | null
  onProjectChanged: (project: ProjectInfo | null) => void
}

type McpForm = {
  name: string
  transport: McpTransport
  command: string
  args: string
  cwd: string
  url: string
  env: string
  headers: string
  enabled: boolean
}

function emptyForm(): McpForm {
  return {
    name: '',
    transport: 'stdio',
    command: 'node',
    args: '',
    cwd: '',
    url: '',
    env: '',
    headers: '',
    enabled: true
  }
}

function parseLines(value: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const index = trimmed.indexOf(separator)
    if (index <= 0) {
      continue
    }
    const key = trimmed.slice(0, index).trim()
    const rawValue = trimmed.slice(index + 1).trim()
    if (key) {
      result[key] = rawValue
    }
  }
  return result
}

function policyLabel(policy: McpToolPolicy): string {
  if (policy === 'allow') return 'Allow'
  if (policy === 'deny') return 'Deny'
  return 'Ask'
}

function statusClass(state: string): string {
  return `mcp-status status-${state}`
}

export function McpPanel({ project, onProjectChanged }: McpPanelProps) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [team, setTeam] = useState<TeamConfig | null>(null)
  const [form, setForm] = useState<McpForm>(emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [logsId, setLogsId] = useState<string | null>(null)
  const [logs, setLogs] = useState('')
  const [calls, setCalls] = useState<McpCallAudit[]>([])

  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [serverResult, teamResult, callResult] = await Promise.all([
        window.agentdesk.listMcpServers(),
        window.agentdesk.getTeam(),
        window.agentdesk.listMcpCalls()
      ])
      if (!serverResult.ok) {
        setError(serverResult.error.message)
        return
      }
      setServers(serverResult.data)
      if (teamResult.ok) {
        setTeam(teamResult.data)
      }
      if (callResult.ok) {
        setCalls(callResult.data)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load MCP servers.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [project?.id])

  const projectConfig: McpProjectConfig = team?.mcp ?? {
    enabledServerIds: [],
    toolPolicies: {}
  }

  function serverEnabled(serverId: string): boolean {
    return projectConfig.enabledServerIds.includes(serverId)
  }

  function openAdd(): void {
    setEditingId(null)
    setForm(emptyForm())
    setFormOpen(true)
    setError('')
  }

  function openEdit(server: McpServerView): void {
    setEditingId(server.server.id)
    setForm({
      name: server.server.name,
      transport: server.server.transport,
      command: server.server.command,
      args: server.server.args.join('\n'),
      cwd: server.server.cwd,
      url: server.server.url,
      env: server.envKeys.map((key) => `${key}=`).join('\n'),
      headers: server.headerNames.map((key) => `${key}=`).join('\n'),
      enabled: server.server.enabled
    })
    setFormOpen(true)
    setError('')
  }

  async function saveForm(): Promise<void> {
    if (!form.name.trim()) {
      setError('Give the MCP server a name.')
      return
    }
    setBusyId(editingId ?? 'new')
    setError('')
    try {
      const payload = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.command.trim(),
        args: form.args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        cwd: form.cwd.trim(),
        url: form.url.trim(),
        env: parseLines(form.env, '='),
        headers: parseLines(form.headers, '='),
        enabled: form.enabled
      }
      const result = editingId
        ? await window.agentdesk.updateMcpServer({ id: editingId, ...payload })
        : await window.agentdesk.addMcpServer(payload)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      await load()
      setFormOpen(false)
      setEditingId(null)
      setForm(emptyForm())
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the MCP server.')
    } finally {
      setBusyId(null)
    }
  }

  async function action(id: string, kind: 'test' | 'discover' | 'restart'): Promise<void> {
    setBusyId(id)
    setError('')
    try {
      const result =
        kind === 'test'
          ? await window.agentdesk.testMcpServer(id)
          : kind === 'discover'
            ? await window.agentdesk.discoverMcpTools(id)
            : await window.agentdesk.restartMcpServer(id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setServers((current) =>
        current.map((entry) => (entry.server.id === id ? result.data : entry))
      )
    } finally {
      setBusyId(null)
    }
  }

  async function removeServer(server: McpServerView): Promise<void> {
    if (!window.confirm(`Delete "${server.server.name}" from the global MCP catalog?`)) {
      return
    }
    setBusyId(server.server.id)
    try {
      const result = await window.agentdesk.deleteMcpServer(server.server.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setServers(result.data.servers)
      if (logsId === server.server.id) {
        setLogsId(null)
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function showLogs(server: McpServerView): Promise<void> {
    setLogsId(server.server.id)
    const [logResult, callResult] = await Promise.all([
      window.agentdesk.getMcpLogs(server.server.id),
      window.agentdesk.listMcpCalls(server.server.id)
    ])
    setLogs(logResult.ok ? logResult.data : 'Could not load logs.')
    if (callResult.ok) {
      setCalls(callResult.data)
    }
  }

  async function saveProjectConfig(next: McpProjectConfig): Promise<void> {
    setError('')
    try {
      const result = await window.agentdesk.setMcpProjectConfig(next)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setTeam(result.data.team)
      onProjectChanged(result.data.project)
      await load()
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'Could not update project MCP settings.'
      )
    }
  }

  async function toggleProject(server: McpServerView): Promise<void> {
    const enabled = serverEnabled(server.server.id)
    await saveProjectConfig({
      enabledServerIds: enabled
        ? projectConfig.enabledServerIds.filter((id) => id !== server.server.id)
        : [...projectConfig.enabledServerIds, server.server.id],
      toolPolicies: projectConfig.toolPolicies
    })
  }

  async function setPolicy(toolName: string, policy: McpToolPolicy): Promise<void> {
    await saveProjectConfig({
      enabledServerIds: projectConfig.enabledServerIds,
      toolPolicies: {
        ...projectConfig.toolPolicies,
        [toolName]: policy
      }
    })
  }

  return (
    <div className="mcp-panel">
      <div className="team-panel-toolbar">
        <div>
          <span className="eyebrow">External tools</span>
          <h3>MCP servers</h3>
          <p>
            Add a server once in the app catalog. Projects enable it and store only server IDs and
            tool policies. Credentials stay in the app's encrypted store.
          </p>
        </div>
        <button className="btn btn-primary btn-small" type="button" onClick={openAdd}>
          <Icon name="plus" size={14} />
          Add MCP server
        </button>
      </div>

      {error && <p className="form-notice error">{error}</p>}

      {formOpen && (
        <div className="mcp-form">
          <div className="mcp-form-grid">
            <label className="field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                maxLength={120}
                placeholder="Filesystem tools"
              />
            </label>
            <label className="field">
              <span>Transport</span>
              <select
                className="model-select"
                value={form.transport}
                onChange={(event) =>
                  setForm({ ...form, transport: event.target.value as McpTransport })
                }
              >
                <option value="stdio">stdio</option>
                <option value="http">Streamable HTTP</option>
                <option value="sse">Legacy SSE</option>
              </select>
            </label>
            <label className="field mcp-enabled-field">
              <span>Global</span>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
            </label>
          </div>

          {form.transport === 'stdio' ? (
            <>
              <div className="mcp-form-grid">
                <label className="field">
                  <span>Command</span>
                  <input
                    value={form.command}
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                    placeholder="node"
                  />
                </label>
                <label className="field">
                  <span>Working directory (optional)</span>
                  <input
                    value={form.cwd}
                    onChange={(event) => setForm({ ...form, cwd: event.target.value })}
                    placeholder="Project or absolute path"
                  />
                </label>
              </div>
              <label className="field">
                <span>Arguments (one per line)</span>
                <textarea
                  value={form.args}
                  onChange={(event) => setForm({ ...form, args: event.target.value })}
                  rows={3}
                  placeholder="path/to/server.js"
                />
              </label>
              <p className="mcp-form-hint">
                Use <code>node</code> to run through the bundled Electron Node runtime. npm/npx
                package caches are kept under the app MCP folder.
              </p>
            </>
          ) : (
            <label className="field">
              <span>URL</span>
              <input
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                placeholder="http://127.0.0.1:3000/mcp"
              />
            </label>
          )}

          <div className="mcp-form-grid">
            <label className="field">
              <span>Environment secrets (KEY=value)</span>
              <textarea
                value={form.env}
                onChange={(event) => setForm({ ...form, env: event.target.value })}
                rows={3}
                placeholder="API_TOKEN="
              />
            </label>
            <label className="field">
              <span>HTTP header secrets (Name=value)</span>
              <textarea
                value={form.headers}
                onChange={(event) => setForm({ ...form, headers: event.target.value })}
                rows={3}
                placeholder="Authorization="
              />
            </label>
          </div>
          <p className="mcp-form-hint">
            Leave a secret value blank while editing to keep the stored value. Secrets are never
            written to the project, team.json, or the MCP catalog.
          </p>
          <div className="form-actions">
            <button
              className="btn btn-primary btn-small"
              type="button"
              onClick={() => void saveForm()}
              disabled={busyId === (editingId ?? 'new')}
            >
              {busyId === (editingId ?? 'new')
                ? 'Connecting...'
                : editingId
                  ? 'Save server'
                  : 'Add and test'}
            </button>
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="settings-loading">
          <span />
          <span />
          <span />
        </div>
      ) : servers.length === 0 ? (
        <div className="settings-empty-state">
          <span className="settings-empty-icon">
            <Icon name="terminal" size={23} />
          </span>
          <h3>No MCP servers yet</h3>
          <p>Add a stdio, Streamable HTTP, or legacy SSE server to the global catalog.</p>
        </div>
      ) : (
        <div className="mcp-server-list">
          {servers.map((server) => {
            const enabled = serverEnabled(server.server.id)
            const busy = busyId === server.server.id
            return (
              <section className={enabled ? 'mcp-server-card enabled' : 'mcp-server-card'} key={server.server.id}>
                <div className="mcp-server-head">
                  <div className="mcp-server-identity">
                    <span className="mcp-server-mark">
                      <Icon name={server.server.transport === 'stdio' ? 'terminal' : 'external'} size={16} />
                    </span>
                    <div>
                      <div className="mcp-server-name-row">
                        <strong>{server.server.name}</strong>
                        <span className="soft-chip">{server.server.transport}</span>
                        <span className={statusClass(server.status.state)}>
                          {server.status.state}
                        </span>
                        {!server.server.enabled && <span className="soft-chip warning">Globally off</span>}
                      </div>
                      <span className="mcp-server-detail">
                        {server.server.transport === 'stdio'
                          ? `${server.server.command} ${server.server.args.join(' ')}`.trim()
                          : server.server.url}
                      </span>
                    </div>
                  </div>
                  <div className="mcp-server-actions">
                    <label className="mcp-enable-toggle" title="Enable for this project">
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => void toggleProject(server)}
                        disabled={!project || busy}
                      />
                      <span>Project</span>
                    </label>
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => void action(server.server.id, 'test')} disabled={busy}>
                      Test
                    </button>
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => void action(server.server.id, 'discover')} disabled={busy}>
                      Discover
                    </button>
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => void action(server.server.id, 'restart')} disabled={busy}>
                      Restart
                    </button>
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => void showLogs(server)} disabled={busy}>
                      Logs
                    </button>
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => openEdit(server)} disabled={busy}>
                      Edit
                    </button>
                    <button className="btn btn-quiet btn-small danger-text" type="button" onClick={() => void removeServer(server)} disabled={busy}>
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mcp-server-meta">
                  <span>{server.status.toolCount} tools</span>
                  <span>{server.envKeys.length} env secrets</span>
                  <span>{server.headerNames.length} headers</span>
                  {server.status.lastError && <span className="mcp-error">{server.status.lastError}</span>}
                  {server.status.pid && <span>pid {server.status.pid}</span>}
                </div>

                {server.tools.length > 0 && (
                  <div className="mcp-tool-list">
                    {server.tools.map((tool) => (
                      <div className="mcp-tool-row" key={tool.namespacedName}>
                        <div className="mcp-tool-copy">
                          <div className="mcp-tool-name">
                            <code>{tool.namespacedName}</code>
                            {tool.readOnly && <span className="soft-chip success">read-only</span>}
                            {tool.destructive && <span className="soft-chip warning">destructive</span>}
                          </div>
                          <span>{tool.description}</span>
                        </div>
                        <select
                          className="model-select mcp-policy-select"
                          value={tool.policy}
                          onChange={(event) =>
                            void setPolicy(tool.namespacedName, event.target.value as McpToolPolicy)
                          }
                          disabled={!enabled}
                          aria-label={`Policy for ${tool.namespacedName}`}
                        >
                          <option value="allow">{policyLabel('allow')}</option>
                          <option value="ask">{policyLabel('ask')}</option>
                          <option value="deny">{policyLabel('deny')}</option>
                        </select>
                      </div>
                    ))}
                  </div>
                )}

                {!enabled && project && (
                  <p className="mcp-hint">Enable this server for the current project to offer its tools to agents.</p>
                )}
              </section>
            )
          })}
        </div>
      )}

      {logsId && (
        <section className="mcp-logs-panel">
          <div className="mcp-logs-head">
            <div>
              <span className="eyebrow">Server logs</span>
              <strong>{servers.find((server) => server.server.id === logsId)?.server.name}</strong>
            </div>
            <button className="icon-button" type="button" onClick={() => setLogsId(null)} aria-label="Close logs">
              <Icon name="close" size={15} />
            </button>
          </div>
          <pre className="mcp-logs">{logs || 'No logs yet.'}</pre>
          <div className="mcp-audit">
            <span className="eyebrow">Recent audited calls</span>
            {calls.length === 0 ? (
              <p className="meeting-side-empty">No MCP calls recorded in this project yet.</p>
            ) : (
              calls.slice(0, 8).map((call) => (
                <div className="mcp-audit-row" key={call.id}>
                  <code>{call.toolName}</code>
                  <span className={call.status === 'ok' ? 'mcp-audit-ok' : 'mcp-audit-error'}>
                    {call.status}
                  </span>
                  <span>{formatRelativeTime(call.createdAt)}</span>
                </div>
              ))
            )}
          </div>
        </section>
      )}

      <p className="settings-note">
        Global catalog: {servers.length} servers. Project: {projectConfig.enabledServerIds.length}{' '}
        enabled, {Object.values(projectConfig.toolPolicies).filter((policy) => policy === 'ask').length}{' '}
        tools gated by approval.
      </p>
    </div>
  )
}
