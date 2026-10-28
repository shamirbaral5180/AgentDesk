import { useState } from 'react'
import type {
  AppSettings,
  ModelRecord,
  ProjectInfo,
  ProviderConfig,
  ProviderType
} from '@shared/types'
import { Icon } from '../Icon'
import { ModelTestDialog } from './ModelTestDialog'
import { ProviderCard } from './ProviderCard'

type ProvidersPanelProps = {
  settings: AppSettings
  onSettingsChanged: (settings: AppSettings) => void
  onProjectChanged: (project: ProjectInfo | null) => void
}

type ProviderForm = {
  type: ProviderType
  name: string
  baseUrl: string
  apiKey: string
}

const PROVIDER_DEFAULTS: Record<ProviderType, { name: string; baseUrl: string }> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  },
  google: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434'
  },
  custom: {
    name: 'Custom provider',
    baseUrl: ''
  }
}

const PROVIDER_HINTS: Record<ProviderType, string> = {
  openai: 'Official OpenAI key. Models are discovered from the /v1/models endpoint.',
  google: 'Google AI Studio key for Gemini models.',
  ollama: 'Local Ollama server. No API key is required.',
  custom: 'Any OpenAI-compatible endpoint. Use the base URL that ends with /v1.'
}

function emptyForm(type: ProviderType = 'openai'): ProviderForm {
  return {
    type,
    name: PROVIDER_DEFAULTS[type].name,
    baseUrl: PROVIDER_DEFAULTS[type].baseUrl,
    apiKey: ''
  }
}

export function ProvidersPanel({
  settings,
  onSettingsChanged,
  onProjectChanged
}: ProvidersPanelProps) {
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState<ProviderForm>(emptyForm())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [testTarget, setTestTarget] = useState<{
    provider: ProviderConfig
    model: ModelRecord
  } | null>(null)

  function setType(type: ProviderType): void {
    setForm({
      type,
      name: PROVIDER_DEFAULTS[type].name,
      baseUrl: PROVIDER_DEFAULTS[type].baseUrl,
      apiKey: ''
    })
    setError('')
  }

  async function createProvider(): Promise<void> {
    if (!form.name.trim()) {
      setError('Give this provider a name.')
      return
    }
    if (form.type === 'custom' && !form.baseUrl.trim()) {
      setError('A custom provider needs a base URL.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await window.agentdesk.createProvider({
        type: form.type,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim() || undefined,
        apiKey: form.apiKey.trim() || undefined
      })
      if (!result.ok) {
        setError(
          result.error.details
            ? `${result.error.message} ${result.error.details}`
            : result.error.message
        )
        return
      }
      onSettingsChanged(result.data.settings)
      setForm(emptyForm())
      setAddOpen(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not add the provider.')
    } finally {
      setBusy(false)
    }
  }

  const providerCount = settings.providers.length
  const modelCount = settings.models.length

  return (
    <div className="providers-panel">
      <div className="providers-toolbar">
        <div>
          <span className="eyebrow">Model gateway</span>
          <h3>Providers & models</h3>
          <p>
            {providerCount} providers, {modelCount} models. Keys are encrypted in the app folder
            and are only read by the main process.
          </p>
        </div>
        <button
          className="btn btn-primary btn-small"
          type="button"
          onClick={() => {
            setAddOpen((value) => !value)
            setError('')
          }}
        >
          <Icon name={addOpen ? 'close' : 'plus'} size={14} />
          {addOpen ? 'Cancel' : 'Add provider'}
        </button>
      </div>

      {addOpen && (
        <form
          className="provider-form"
          onSubmit={(event) => {
            event.preventDefault()
            void createProvider()
          }}
        >
          <div className="provider-form-heading">
            <span className="provider-form-icon">
              <Icon name="sparkles" size={16} />
            </span>
            <div>
              <strong>Connect a provider</strong>
              <span>Add one endpoint now. You can add more later.</span>
            </div>
          </div>

          <div className="provider-type-grid" role="radiogroup" aria-label="Provider type">
            {(Object.keys(PROVIDER_DEFAULTS) as ProviderType[]).map((type) => (
              <button
                className={form.type === type ? 'provider-type-option active' : 'provider-type-option'}
                type="button"
                key={type}
                onClick={() => setType(type)}
              >
                <span className={`provider-mark type-${type}`}>
                  {type === 'openai' ? 'OA' : type === 'google' ? 'GG' : type === 'ollama' ? 'OL' : 'CX'}
                </span>
                <span>
                  <strong>
                    {type === 'openai'
                      ? 'OpenAI'
                      : type === 'google'
                        ? 'Gemini'
                        : type === 'ollama'
                          ? 'Ollama'
                          : 'Custom'}
                  </strong>
                  <small>{type === 'custom' ? 'OpenAI-compatible' : type === 'google' ? 'Google AI' : type === 'ollama' ? 'Local' : 'Official'}</small>
                </span>
              </button>
            ))}
          </div>

          <p className="provider-hint">{PROVIDER_HINTS[form.type]}</p>

          <div className="form-grid">
            <label className="form-field">
              <span>Provider name</span>
              <input
                value={form.name}
                maxLength={80}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="My provider"
                required
              />
            </label>
            <label className="form-field">
              <span>Base URL</span>
              <input
                value={form.baseUrl}
                maxLength={2048}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                placeholder={
                  form.type === 'custom' ? 'http://localhost:1234/v1' : 'Provider endpoint'
                }
                required={form.type === 'custom'}
              />
            </label>
          </div>

          {form.type !== 'ollama' && (
            <label className="form-field">
              <span>API key {form.type === 'custom' ? '(optional for local endpoints)' : ''}</span>
              <input
                type="password"
                value={form.apiKey}
                maxLength={8192}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                placeholder="Stored encrypted in the app folder"
                autoComplete="off"
              />
            </label>
          )}

          {error && <p className="form-notice error">{error}</p>}

          <div className="form-footer">
            <span className="form-footnote">
              <Icon name="lock" size={13} />
              Encrypted at rest. Used only by the main process.
            </span>
            <div className="form-actions">
              <button className="btn btn-quiet btn-small" type="button" onClick={() => setAddOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-small" type="submit" disabled={busy}>
                {busy ? 'Adding...' : 'Add provider'}
              </button>
            </div>
          </div>
        </form>
      )}

      {settings.providers.length === 0 ? (
        <div className="providers-empty">
          <span className="providers-empty-icon">
            <Icon name="sparkles" size={24} />
          </span>
          <h3>Connect your model gateway</h3>
          <p>
            Add OpenAI, Google Gemini, Ollama, or any OpenAI-compatible endpoint. Discover models
            once, then assign them to your agents.
          </p>
          <button className="btn btn-ghost btn-small" type="button" onClick={() => setAddOpen(true)}>
            <Icon name="plus" size={14} />
            Add your first provider
          </button>
        </div>
      ) : (
        <div className="provider-list">
          {settings.providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              settings={settings}
              onSettingsChanged={onSettingsChanged}
              onProjectChanged={onProjectChanged}
              onTestModel={(targetProvider, model) =>
                setTestTarget({ provider: targetProvider, model })
              }
            />
          ))}
        </div>
      )}

      {testTarget && (
        <ModelTestDialog
          provider={testTarget.provider}
          model={testTarget.model}
          onClose={() => setTestTarget(null)}
        />
      )}
    </div>
  )
}
