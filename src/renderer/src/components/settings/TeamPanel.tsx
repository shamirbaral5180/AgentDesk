import { useEffect, useState } from 'react'
import type {
  AgentConfig,
  AgentPermissions,
  AppSettings,
  ModelRecord,
  ProjectInfo,
  TeamConfig
} from '@shared/types'
import { Icon } from '../Icon'

type TeamPanelProps = {
  project: ProjectInfo | null
  settings: AppSettings
  onProjectChanged: (project: ProjectInfo | null) => void
  onGoToProviders: () => void
}

type AgentDraft = {
  id: string
  name: string
  roleKey: string
  tagline: string
  color: string
  enabled: boolean
  promptAppend: string
  tools: string[]
  writeGlobs: string
  denyGlobs: string
  modelId: string
  temperature: string
}

const TOOL_OPTIONS: Array<{ id: string; label: string; note: string }> = [
  { id: 'read', label: 'Read', note: 'list and read files' },
  { id: 'search', label: 'Search', note: 'text search' },
  { id: 'write', label: 'Write', note: 'create, delete, move' },
  { id: 'patch', label: 'Patch', note: 'focused edits' },
  { id: 'run_command', label: 'Commands', note: 'shell in Build' },
  { id: 'memory', label: 'Memory', note: 'recall and record' }
]

function assignedModel(
  settings: AppSettings,
  agent: AgentConfig
): ModelRecord | null {
  if (!agent.model) {
    return null
  }
  return (
    settings.models.find(
      (model) =>
        model.providerId === agent.model?.providerConfigId &&
        model.modelId === agent.model?.modelId
    ) ?? null
  )
}

function draftFromAgent(
  agent: AgentConfig,
  settings: AppSettings
): AgentDraft {
  return {
    id: agent.id,
    name: agent.name,
    roleKey: agent.roleKey,
    tagline: agent.tagline,
    color: agent.color,
    enabled: agent.enabled,
    promptAppend: agent.promptAppend,
    tools: [...agent.permissions.tools],
    writeGlobs: agent.permissions.writeGlobs.join('\n'),
    denyGlobs: agent.permissions.denyGlobs.join('\n'),
    modelId: assignedModel(settings, agent)?.id ?? '',
    temperature: String(agent.model?.temperature ?? 0.2)
  }
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function permissionsFromDraft(draft: AgentDraft): AgentPermissions {
  const visibleTools = new Set(TOOL_OPTIONS.map((tool) => tool.id))
  const preservedTools = draft.tools.filter((tool) => !visibleTools.has(tool))
  return {
    tools: [
      ...new Set([
        ...preservedTools,
        ...TOOL_OPTIONS.filter((tool) => draft.tools.includes(tool.id)).map((tool) => tool.id)
      ])
    ],
    writeGlobs: lines(draft.writeGlobs),
    denyGlobs: lines(draft.denyGlobs)
  }
}

export function TeamPanel({
  project,
  settings,
  onProjectChanged,
  onGoToProviders
}: TeamPanelProps) {
  const [team, setTeam] = useState<TeamConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newTagline, setNewTagline] = useState('')
  const [newColor, setNewColor] = useState('#8ab7ff')

  useEffect(() => {
    let cancelled = false
    if (!project) {
      setTeam(null)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    window.agentdesk
      .getTeam()
      .then((result) => {
        if (cancelled) {
          return
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setTeam(result.data)
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load the team.')
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
  }, [project?.id, settings.updatedAt])

  useEffect(() => {
    if (!team || !expandedId) {
      return
    }
    const agent = team.agents.find((entry) => entry.id === expandedId)
    if (agent) {
      setDraft(draftFromAgent(agent, settings))
    }
  }, [expandedId, team?.agents, settings.models, settings.updatedAt])

  function applyResult(result: {
    team: TeamConfig
    project: ProjectInfo
  }): void {
    setTeam(result.team)
    onProjectChanged(result.project)
  }

  function openEditor(agent: AgentConfig): void {
    if (expandedId === agent.id) {
      setExpandedId(null)
      setDraft(null)
      return
    }
    setExpandedId(agent.id)
    setDraft(draftFromAgent(agent, settings))
    setError('')
  }

  async function saveDraft(): Promise<void> {
    if (!draft || saving) {
      return
    }
    if (!draft.name.trim()) {
      setError('Agent name is required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await window.agentdesk.updateAgent({
        id: draft.id,
        name: draft.name.trim(),
        roleKey: draft.roleKey.trim() || draft.id,
        tagline: draft.tagline.trim(),
        color: draft.color,
        enabled: draft.enabled,
        promptAppend: draft.promptAppend,
        permissions: permissionsFromDraft(draft)
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      applyResult(result.data)
      const modelResult = await window.agentdesk.setAgentModel({
        agentId: draft.id,
        modelRecordId: draft.modelId || null,
        temperature: Number(draft.temperature)
      })
      if (!modelResult.ok) {
        setError(modelResult.error.message)
        return
      }
      applyResult(modelResult.data)
      setExpandedId(null)
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled(agent: AgentConfig): Promise<void> {
    if (saving) {
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await window.agentdesk.updateAgent({
        id: agent.id,
        enabled: !agent.enabled
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      applyResult(result.data)
    } finally {
      setSaving(false)
    }
  }

  async function addAgent(): Promise<void> {
    if (saving) {
      return
    }
    if (!newName.trim()) {
      setError('Give the new agent a name.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await window.agentdesk.addAgent({
        name: newName.trim(),
        roleKey: newRole.trim() || undefined,
        tagline: newTagline.trim() || undefined,
        color: newColor
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      applyResult(result.data)
      setAdding(false)
      setNewName('')
      setNewRole('')
      setNewTagline('')
      setNewColor('#8ab7ff')
    } finally {
      setSaving(false)
    }
  }

  async function deleteAgent(agent: AgentConfig): Promise<void> {
    if (saving || !agent.id.startsWith('custom-')) {
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await window.agentdesk.deleteAgent(agent.id)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      applyResult(result.data)
      setExpandedId(null)
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  if (!project) {
    return (
      <div className="team-panel">
        <div className="settings-empty-state">
          <span className="settings-empty-icon">
            <Icon name="users" size={23} />
          </span>
          <h3>No project is open</h3>
          <p>
            The team lives inside each project. When you open a folder, AgentDesk creates a
            default six-agent roster automatically and gives every agent a predefined role and
            system prompt. Open a project to view or edit the team.
          </p>
        </div>
      </div>
    )
  }

  if (loading && !team) {
    return (
      <div className="team-panel">
        <div className="settings-loading">
          <span />
          <span />
          <span />
        </div>
      </div>
    )
  }

  const modelsByProvider = settings.providers
    .map((provider) => ({
      provider,
      models: settings.models.filter((model) => model.providerId === provider.id)
    }))
    .filter((group) => group.models.length > 0)

  return (
    <div className="team-panel">
      <div className="team-panel-toolbar">
        <div>
          <span className="eyebrow">Team roster</span>
          <h3>Six specialists, one Boss</h3>
          <p>
            Tune each role, model, tools, and write scope. Plan room meetings are always read-only;
            Build mode enforces scopes and approvals later. Changes live in this project's
            team.json.
          </p>
        </div>
        <div className="team-toolbar-actions">
          <button
            className="btn btn-quiet btn-small"
            type="button"
            onClick={onGoToProviders}
          >
            <Icon name="sparkles" size={14} />
            Manage providers
          </button>
          <button
            className="btn btn-ghost btn-small"
            type="button"
            onClick={() => setAdding((value) => !value)}
            disabled={saving}
          >
            <Icon name="plus" size={14} />
            Add agent
          </button>
        </div>
      </div>

      {error && <p className="form-notice error">{error}</p>}

      {adding && (
        <div className="team-add-form">
          <div className="team-add-grid">
            <label className="field">
              <span>Name</span>
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                maxLength={120}
                placeholder="Accessibility reviewer"
              />
            </label>
            <label className="field">
              <span>Role key</span>
              <input
                value={newRole}
                onChange={(event) => setNewRole(event.target.value)}
                maxLength={80}
                placeholder="accessibility"
              />
            </label>
            <label className="field">
              <span>Color</span>
              <input
                className="color-input"
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Tagline</span>
            <input
              value={newTagline}
              onChange={(event) => setNewTagline(event.target.value)}
              maxLength={300}
              placeholder="Checks interaction semantics, focus, and contrast."
            />
          </label>
          <div className="team-add-actions">
            <button
              className="btn btn-primary btn-small"
              type="button"
              onClick={() => void addAgent()}
              disabled={saving}
            >
              Add agent
            </button>
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => setAdding(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <span className="assignment-note">Assign a model after adding the agent.</span>
          </div>
        </div>
      )}

      {settings.models.length === 0 ? (
        <div className="settings-empty-state">
          <span className="settings-empty-icon">
            <Icon name="sparkles" size={23} />
          </span>
          <h3>No models in the catalog</h3>
          <p>Add a provider and discover or add a model first. Then come back to assign roles.</p>
          <button className="btn btn-ghost btn-small" type="button" onClick={onGoToProviders}>
            <Icon name="plus" size={14} />
            Open providers
          </button>
        </div>
      ) : (
        <div className="team-settings-list">
          {team?.agents.map((agent) => {
            const model = assignedModel(settings, agent)
            const provider = model
              ? settings.providers.find((entry) => entry.id === model.providerId)
              : null
            const providerNeedsKey =
              provider &&
              (provider.type === 'openai' || provider.type === 'google') &&
              !provider.hasKey
            const expanded = expandedId === agent.id
            return (
              <div className={expanded ? 'team-setting-block expanded' : 'team-setting-block'} key={agent.id}>
                <div className="team-setting-row">
                  <button
                    className="team-setting-avatar as-button"
                    style={{ backgroundColor: agent.color }}
                    type="button"
                    onClick={() => openEditor(agent)}
                    aria-label={`Edit ${agent.name}`}
                  >
                    {agent.name
                      .split(' ')
                      .filter((part) => part !== '&')
                      .slice(0, 2)
                      .map((part) => part[0])
                      .join('')}
                  </button>
                  <div className="team-setting-copy">
                    <div className="team-setting-name-row">
                      <strong>{agent.name}</strong>
                      <span className={agent.enabled ? 'agent-state on' : 'agent-state off'}>
                        {agent.enabled ? 'On' : 'Off'}
                      </span>
                      {agent.id.startsWith('custom-') && <span className="soft-chip">Custom</span>}
                    </div>
                    <span>{agent.tagline}</span>
                    {agent.model && !model && (
                      <em>Assigned model is no longer in the catalog.</em>
                    )}
                    {providerNeedsKey && <em>Provider API key is missing.</em>}
                  </div>
                  <div className="team-model-summary">
                    <span className="team-model-name">
                      {model ? `${provider?.name ?? agent.model?.providerType} / ${model.displayName}` : 'No model assigned'}
                    </span>
                    <span className="team-tool-summary">
                      {agent.permissions.tools.slice(0, 5).join(', ')}
                    </span>
                  </div>
                  <div className="team-row-actions">
                    <button
                      className="btn btn-quiet btn-small"
                      type="button"
                      onClick={() => void toggleEnabled(agent)}
                      disabled={saving}
                    >
                      {agent.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      className="btn btn-ghost btn-small"
                      type="button"
                      onClick={() => openEditor(agent)}
                    >
                      <Icon name="settings" size={13} />
                      {expanded ? 'Close' : 'Configure'}
                    </button>
                  </div>
                </div>

                {expanded && draft && (
                  <div className="team-editor">
                    <div className="team-editor-grid">
                      <label className="field">
                        <span>Name</span>
                        <input
                          value={draft.name}
                          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                          maxLength={120}
                        />
                      </label>
                      <label className="field">
                        <span>Role key</span>
                        <input
                          value={draft.roleKey}
                          onChange={(event) => setDraft({ ...draft, roleKey: event.target.value })}
                          maxLength={80}
                        />
                      </label>
                      <label className="field team-color-field">
                        <span>Color</span>
                        <input
                          className="color-input"
                          type="color"
                          value={draft.color}
                          onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                        />
                      </label>
                    </div>

                    <label className="field">
                      <span>Tagline</span>
                      <input
                        value={draft.tagline}
                        onChange={(event) => setDraft({ ...draft, tagline: event.target.value })}
                        maxLength={300}
                      />
                    </label>

                    <label className="field">
                      <span>Role prompt append</span>
                      <textarea
                        value={draft.promptAppend}
                        onChange={(event) => setDraft({ ...draft, promptAppend: event.target.value })}
                        rows={4}
                        maxLength={20_000}
                        placeholder="Extra instructions added to this agent's role prompt."
                      />
                    </label>

                    <div className="field">
                      <span>Assigned skills</span>
                      <p className="field-hint">
                        {agent && (agent.skills ?? []).length > 0
                          ? agent.skills.join(', ')
                          : 'No specialist skills assigned.'}
                      </p>
                    </div>

                    <div className="team-editor-split">
                      <div className="team-editor-panel">
                        <span className="team-editor-label">Model</span>
                        <select
                          className="model-select"
                          value={draft.modelId}
                          onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                        >
                          <option value="">No model assigned</option>
                          {modelsByProvider.map((group) => (
                            <optgroup key={group.provider.id} label={group.provider.name}>
                              {group.models.map((entry) => (
                                <option key={entry.id} value={entry.id}>
                                  {entry.displayName}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <label className="temp-wrap team-temp">
                          <span>Temperature</span>
                          <input
                            className="temp-input"
                            type="number"
                            min="0"
                            max="2"
                            step="0.1"
                            value={draft.temperature}
                            onChange={(event) =>
                              setDraft({ ...draft, temperature: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      <div className="team-editor-panel">
                        <span className="team-editor-label">Tools</span>
                        <div className="team-tool-grid">
                          {TOOL_OPTIONS.map((tool) => (
                            <label className="team-tool-option" key={tool.id}>
                              <input
                                type="checkbox"
                                checked={draft.tools.includes(tool.id)}
                                onChange={(event) =>
                                  setDraft({
                                    ...draft,
                                    tools: event.target.checked
                                      ? [...draft.tools, tool.id]
                                      : draft.tools.filter((entry) => entry !== tool.id)
                                  })
                                }
                              />
                              <span>
                                <strong>{tool.label}</strong>
                                <em>{tool.note}</em>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="team-editor-split">
                      <label className="field">
                        <span>Write scopes (one glob per line)</span>
                        <textarea
                          value={draft.writeGlobs}
                          onChange={(event) => setDraft({ ...draft, writeGlobs: event.target.value })}
                          rows={4}
                          placeholder="src/renderer/**"
                        />
                      </label>
                      <label className="field">
                        <span>Deny scopes (one glob per line)</span>
                        <textarea
                          value={draft.denyGlobs}
                          onChange={(event) => setDraft({ ...draft, denyGlobs: event.target.value })}
                          rows={4}
                          placeholder=".agentdesk/**"
                        />
                      </label>
                    </div>

                    <div className="team-editor-actions">
                      <button
                        className="btn btn-primary btn-small"
                        type="button"
                        onClick={() => void saveDraft()}
                        disabled={saving}
                      >
                        {saving ? 'Saving...' : 'Save agent'}
                      </button>
                      <button
                        className="btn btn-quiet btn-small"
                        type="button"
                        onClick={() => {
                          setExpandedId(null)
                          setDraft(null)
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      {agent.id.startsWith('custom-') && (
                        <button
                          className="btn btn-quiet btn-small danger-text"
                          type="button"
                          onClick={() => void deleteAgent(agent)}
                          disabled={saving}
                        >
                          Delete custom agent
                        </button>
                      )}
                      <span className="assignment-note">
                        Plan meetings ignore write and command tools. Build enforces them later.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <p className="settings-note">
        Phase 6: the roster feeds a read-only Plan room. Selected agents submit intake cards,
        discuss the work, and hand the Coordinator's plan to the Boss for approval.
      </p>
    </div>
  )
}
