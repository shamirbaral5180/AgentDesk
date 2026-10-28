import { useState } from 'react'
import type {
  AppSettings,
  ModelRecord,
  ProjectInfo,
  ProviderConfig,
  ProviderType
} from '@shared/types'
import { Icon } from '../Icon'

type ProviderCardProps = {
  provider: ProviderConfig
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
  onProjectChanged: (project: ProjectInfo | null) => void
  onTestModel: (provider: ProviderConfig, model: ModelRecord) => void
}

type Notice = {
  kind: 'success' | 'error'
  text: string
}

type ModelFormValues = {
  modelId: string
  displayName: string
  contextWindow: string
  maxOutputTokens: string
  supportsTools: boolean
  supportsVision: boolean
  inputPricePerMillion: string
  outputPricePerMillion: string
}

const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI',
  google: 'Google Gemini',
  ollama: 'Ollama',
  custom: 'OpenAI-compatible'
}

const PROVIDER_MARKS: Record<ProviderType, string> = {
  openai: 'OA',
  google: 'GG',
  ollama: 'OL',
  custom: 'CX'
}

function emptyModelForm(): ModelFormValues {
  return {
    modelId: '',
    displayName: '',
    contextWindow: '',
    maxOutputTokens: '',
    supportsTools: false,
    supportsVision: false,
    inputPricePerMillion: '',
    outputPricePerMillion: ''
  }
}

function modelToForm(model: ModelRecord): ModelFormValues {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    contextWindow: model.contextWindow ? String(model.contextWindow) : '',
    maxOutputTokens: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    inputPricePerMillion:
      model.inputPricePerMillion === undefined
        ? ''
        : String(model.inputPricePerMillion),
    outputPricePerMillion:
      model.outputPricePerMillion === undefined
        ? ''
        : String(model.outputPricePerMillion)
  }
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function nonNegativeNumber(value: string): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function formatContext(window: number | undefined): string | null {
  if (!window) {
    return null
  }
  if (window >= 1_000_000) {
    return `${(window / 1_000_000).toFixed(1)}M ctx`
  }
  return `${Math.round(window / 1000)}k ctx`
}

function resultMessage(error: { message: string; details?: string }): string {
  const details = error.details?.trim()
  return details ? `${error.message} ${details}` : error.message
}

export function ProviderCard({
  provider,
  settings,
  onSettingsChanged,
  onProjectChanged,
  onTestModel
}: ProviderCardProps) {
  const models = settings.models.filter((model) => model.providerId === provider.id)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [providerEditing, setProviderEditing] = useState(false)
  const [providerName, setProviderName] = useState(provider.name)
  const [providerBaseUrl, setProviderBaseUrl] = useState(provider.baseUrl)
  const [providerEnabled, setProviderEnabled] = useState(provider.enabled)
  const [modelFormOpen, setModelFormOpen] = useState(false)
  const [modelForm, setModelForm] = useState<ModelFormValues>(emptyModelForm())
  const [editingModelId, setEditingModelId] = useState<string | null>(null)
  const [modelEditForm, setModelEditForm] = useState<ModelFormValues>(emptyModelForm())

  const requiresKey = provider.type === 'openai' || provider.type === 'google'
  const canConnect = provider.type === 'ollama' || provider.type === 'custom' || provider.hasKey
  const keyLabel =
    provider.type === 'ollama'
      ? 'No key required'
      : provider.hasKey
        ? 'Key saved'
        : provider.type === 'custom'
          ? 'Key optional'
          : 'Key missing'

  async function discoverModels(): Promise<void> {
    setBusy('discover')
    setNotice(null)
    try {
      const result = await window.agentdesk.discoverProviderModels(provider.id)
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setNotice({
        kind: 'success',
        text:
          result.data.discovered === 0
            ? 'Connected, but this provider returned no chat models.'
            : `Connected. ${result.data.discovered} models found, ${result.data.added} added, ${result.data.updated} refreshed.`
      })
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Model discovery failed.'
      })
    } finally {
      setBusy(null)
    }
  }

  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) {
      setNotice({ kind: 'error', text: 'Paste an API key first.' })
      return
    }
    setBusy('key')
    setNotice(null)
    try {
      const result = await window.agentdesk.setProviderKey({
        id: provider.id,
        apiKey: keyInput.trim()
      })
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setKeyInput('')
      setNotice({ kind: 'success', text: 'API key stored in the encrypted app vault.' })
    } finally {
      setBusy(null)
    }
  }

  async function clearKey(): Promise<void> {
    setBusy('key')
    setNotice(null)
    try {
      const result = await window.agentdesk.clearProviderKey(provider.id)
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setNotice({ kind: 'success', text: 'API key removed.' })
    } finally {
      setBusy(null)
    }
  }

  async function saveProvider(): Promise<void> {
    setBusy('provider')
    setNotice(null)
    try {
      const result = await window.agentdesk.updateProvider({
        id: provider.id,
        name: providerName,
        baseUrl: providerBaseUrl,
        enabled: providerEnabled
      })
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setProviderEditing(false)
      setNotice({ kind: 'success', text: 'Provider updated.' })
    } finally {
      setBusy(null)
    }
  }

  async function removeProvider(): Promise<void> {
    if (
      !window.confirm(
        `Remove ${provider.name}? Its models will be deleted and any agent assignments will be cleared.`
      )
    ) {
      return
    }
    setBusy('provider')
    setNotice(null)
    try {
      const result = await window.agentdesk.deleteProvider(provider.id)
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      onProjectChanged(result.data.project)
    } finally {
      setBusy(null)
    }
  }

  function openModelForm(): void {
    setModelForm(emptyModelForm())
    setModelFormOpen(true)
    setEditingModelId(null)
  }

  async function addManualModel(): Promise<void> {
    setBusy('model')
    setNotice(null)
    try {
      const result = await window.agentdesk.addModel({
        providerId: provider.id,
        modelId: modelForm.modelId.trim(),
        displayName: modelForm.displayName.trim() || undefined,
        contextWindow: positiveNumber(modelForm.contextWindow),
        maxOutputTokens: positiveNumber(modelForm.maxOutputTokens),
        supportsTools: modelForm.supportsTools,
        supportsVision: modelForm.supportsVision,
        inputPricePerMillion: nonNegativeNumber(modelForm.inputPricePerMillion),
        outputPricePerMillion: nonNegativeNumber(modelForm.outputPricePerMillion)
      })
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setModelFormOpen(false)
      setModelForm(emptyModelForm())
      setNotice({ kind: 'success', text: 'Model added to the catalog.' })
    } finally {
      setBusy(null)
    }
  }

  function openModelEdit(model: ModelRecord): void {
    setEditingModelId(model.id)
    setModelEditForm(modelToForm(model))
    setModelFormOpen(false)
  }

  async function saveModel(model: ModelRecord): Promise<void> {
    setBusy('model')
    setNotice(null)
    try {
      const result = await window.agentdesk.updateModel({
        id: model.id,
        displayName: modelEditForm.displayName.trim() || model.modelId,
        contextWindow: positiveNumber(modelEditForm.contextWindow),
        maxOutputTokens: positiveNumber(modelEditForm.maxOutputTokens),
        supportsTools: modelEditForm.supportsTools,
        supportsVision: modelEditForm.supportsVision,
        inputPricePerMillion: nonNegativeNumber(modelEditForm.inputPricePerMillion),
        outputPricePerMillion: nonNegativeNumber(modelEditForm.outputPricePerMillion)
      })
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      setEditingModelId(null)
      setNotice({ kind: 'success', text: 'Model settings saved.' })
    } finally {
      setBusy(null)
    }
  }

  async function removeModel(model: ModelRecord): Promise<void> {
    if (!window.confirm(`Remove ${model.displayName} from the model catalog?`)) {
      return
    }
    setBusy('model')
    setNotice(null)
    try {
      const result = await window.agentdesk.deleteModel(model.id)
      if (!result.ok) {
        setNotice({ kind: 'error', text: resultMessage(result.error) })
        return
      }
      onSettingsChanged(result.data.settings)
      onProjectChanged(result.data.project)
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className={`provider-card ${provider.enabled ? '' : 'disabled'}`}>
      <header className="provider-header">
        <div className="provider-identity">
          <span className={`provider-mark type-${provider.type}`}>
            {PROVIDER_MARKS[provider.type]}
          </span>
          <div className="provider-title">
            <div>
              <h3>{provider.name}</h3>
              <span>{PROVIDER_LABELS[provider.type]}</span>
            </div>
            <code title={provider.baseUrl}>{provider.baseUrl}</code>
          </div>
        </div>
        <div className="provider-status-group">
          <span className={`key-status ${provider.hasKey || provider.type === 'ollama' ? 'configured' : requiresKey ? 'missing' : 'optional'}`}>
            {keyLabel}
          </span>
          <span className="soft-chip">{models.length} models</span>
          {!provider.enabled && <span className="soft-chip warning">Disabled</span>}
        </div>
      </header>

      <div className="provider-actions">
        <button
          className="btn btn-ghost btn-small"
          type="button"
          onClick={() => void discoverModels()}
          disabled={busy !== null || !canConnect}
          title={!canConnect ? 'Add an API key first' : 'Connect and refresh the model catalog'}
        >
          <Icon name="sparkles" size={14} />
          {busy === 'discover' ? 'Discovering...' : 'Test & discover models'}
        </button>
        <button
          className="btn btn-quiet btn-small"
          type="button"
          onClick={() => {
            setProviderEditing((value) => !value)
            setProviderName(provider.name)
            setProviderBaseUrl(provider.baseUrl)
            setProviderEnabled(provider.enabled)
          }}
          disabled={busy !== null}
        >
          <Icon name="settings" size={14} />
          Edit
        </button>
        <button
          className="btn btn-quiet btn-small danger-text"
          type="button"
          onClick={() => void removeProvider()}
          disabled={busy !== null}
        >
          <Icon name="close" size={14} />
          Remove
        </button>
      </div>

      {providerEditing && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveProvider()
          }}
        >
          <div className="form-grid">
            <label className="form-field">
              <span>Display name</span>
              <input
                value={providerName}
                maxLength={80}
                onChange={(event) => setProviderName(event.target.value)}
              />
            </label>
            <label className="form-field">
              <span>Base URL</span>
              <input
                value={providerBaseUrl}
                maxLength={2048}
                onChange={(event) => setProviderBaseUrl(event.target.value)}
              />
            </label>
          </div>
          <div className="form-footer">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={providerEnabled}
                onChange={(event) => setProviderEnabled(event.target.checked)}
              />
              Provider enabled
            </label>
            <div className="form-actions">
              <button className="btn btn-quiet btn-small" type="button" onClick={() => setProviderEditing(false)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-small" type="submit" disabled={busy !== null}>
                {busy === 'provider' ? 'Saving...' : 'Save provider'}
              </button>
            </div>
          </div>
        </form>
      )}

      {provider.type !== 'ollama' && (
        <div className="key-row">
          <span className={`key-status ${provider.hasKey ? 'configured' : requiresKey ? 'missing' : 'optional'}`}>
            <Icon name={provider.hasKey ? 'check' : 'lock'} size={13} />
            {keyLabel}
          </span>
          <div className="key-controls">
            <input
              type="password"
              value={keyInput}
              placeholder={provider.hasKey ? 'Replace stored key' : 'Paste API key'}
              onChange={(event) => setKeyInput(event.target.value)}
              autoComplete="off"
            />
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => void saveKey()}
              disabled={busy !== null || !keyInput.trim()}
            >
              Save key
            </button>
            {provider.hasKey && (
              <button
                className="btn btn-quiet btn-small danger-text"
                type="button"
                onClick={() => void clearKey()}
                disabled={busy !== null}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {notice && <p className={`form-notice ${notice.kind}`}>{notice.text}</p>}

      <div className="provider-models">
        <div className="model-list-heading">
          <span>Model catalog</span>
          <button className="btn btn-quiet btn-small" type="button" onClick={openModelForm} disabled={busy !== null}>
            <Icon name="plus" size={14} />
            Add model
          </button>
        </div>

        {models.length === 0 ? (
          <p className="muted-note">
            No models yet. Test & discover this provider, or add a model ID manually.
          </p>
        ) : (
          <div className="model-list">
            {models.map((model) => (
              <div className="model-item" key={model.id}>
                <div className="model-row">
                  <div className="model-main">
                    <div className="model-title">
                      <strong>{model.displayName}</strong>
                      <code>{model.modelId}</code>
                    </div>
                    <div className="model-chips">
                      <span className={model.supportsTools ? 'cap-chip on' : 'cap-chip'}>
                        <Icon name="terminal" size={12} />
                        Tools
                      </span>
                      <span className={model.supportsVision ? 'cap-chip on' : 'cap-chip'}>
                        <Icon name="sparkles" size={12} />
                        Vision
                      </span>
                      {formatContext(model.contextWindow) && (
                        <span className="cap-chip">{formatContext(model.contextWindow)}</span>
                      )}
                      <span className="source-chip">{model.source}</span>
                    </div>
                  </div>
                  <div className="model-actions">
                    <button
                      className="btn btn-quiet btn-small"
                      type="button"
                      onClick={() => onTestModel(provider, model)}
                      disabled={busy !== null || !canConnect}
                    >
                      <Icon name="terminal" size={13} />
                      Test
                    </button>
                    <button
                      className="btn btn-quiet btn-small"
                      type="button"
                      onClick={() => openModelEdit(model)}
                      disabled={busy !== null}
                    >
                      Edit
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => void removeModel(model)}
                      disabled={busy !== null}
                      aria-label={`Remove ${model.displayName}`}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </div>

                {editingModelId === model.id && (
                  <ModelDetailsForm
                    values={modelEditForm}
                    onChange={setModelEditForm}
                    onSubmit={() => void saveModel(model)}
                    onCancel={() => setEditingModelId(null)}
                    submitLabel={busy === 'model' ? 'Saving...' : 'Save model'}
                    disabled={busy !== null}
                    lockModelId
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {modelFormOpen && (
          <ModelDetailsForm
            values={modelForm}
            onChange={setModelForm}
            onSubmit={() => void addManualModel()}
            onCancel={() => {
              setModelFormOpen(false)
              setModelForm(emptyModelForm())
            }}
            submitLabel={busy === 'model' ? 'Adding...' : 'Add model'}
            disabled={busy !== null}
          />
        )}
      </div>
    </article>
  )
}

type ModelDetailsFormProps = {
  values: ModelFormValues
  onChange: (values: ModelFormValues) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
  disabled: boolean
  lockModelId?: boolean
}

function ModelDetailsForm({
  values,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  disabled,
  lockModelId = false
}: ModelDetailsFormProps) {
  function update(patch: Partial<ModelFormValues>): void {
    onChange({ ...values, ...patch })
  }

  return (
    <form
      className="model-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="form-grid">
        <label className="form-field">
          <span>Model ID</span>
          <input
            value={values.modelId}
            onChange={(event) => update({ modelId: event.target.value })}
            readOnly={lockModelId}
            placeholder="gpt-4.1-mini"
            required
          />
        </label>
        <label className="form-field">
          <span>Display name</span>
          <input
            value={values.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
            placeholder="Optional label"
          />
        </label>
        <label className="form-field">
          <span>Context window</span>
          <input
            type="number"
            min="1"
            value={values.contextWindow}
            onChange={(event) => update({ contextWindow: event.target.value })}
            placeholder="128000"
          />
        </label>
        <label className="form-field">
          <span>Max output tokens</span>
          <input
            type="number"
            min="1"
            value={values.maxOutputTokens}
            onChange={(event) => update({ maxOutputTokens: event.target.value })}
            placeholder="8192"
          />
        </label>
        <label className="form-field">
          <span>Input $ / 1M tokens</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={values.inputPricePerMillion}
            onChange={(event) => update({ inputPricePerMillion: event.target.value })}
            placeholder="Optional"
          />
        </label>
        <label className="form-field">
          <span>Output $ / 1M tokens</span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={values.outputPricePerMillion}
            onChange={(event) => update({ outputPricePerMillion: event.target.value })}
            placeholder="Optional"
          />
        </label>
      </div>
      <div className="form-footer">
        <div className="form-checks">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.supportsTools}
              onChange={(event) => update({ supportsTools: event.target.checked })}
            />
            Supports tool calling
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={values.supportsVision}
              onChange={(event) => update({ supportsVision: event.target.checked })}
            />
            Supports images
          </label>
        </div>
        <div className="form-actions">
          <button className="btn btn-quiet btn-small" type="button" onClick={onCancel} disabled={disabled}>
            Cancel
          </button>
          <button className="btn btn-primary btn-small" type="submit" disabled={disabled || !values.modelId.trim()}>
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  )
}
