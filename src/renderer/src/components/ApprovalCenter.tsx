import { useEffect, useState } from 'react'
import type {
  ApprovalDecisionInput,
  ApprovalEvent,
  ApprovalRequest
} from '@shared/types'
import { formatRelativeTime } from '../lib/format'
import { Icon } from './Icon'

function actionTitle(action: ApprovalRequest['actionType']): string {
  switch (action) {
    case 'write_file':
      return 'Write a file'
    case 'patch_file':
      return 'Patch a file'
    case 'delete_path':
      return 'Delete a file'
    case 'move_path':
      return 'Move a file'
    case 'run_command':
      return 'Run a command'
    case 'mcp_call':
      return 'Call an MCP tool'
    default:
      return 'Approve an action'
  }
}

function payloadValue(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (value === undefined || value === null) {
    return null
  }
  return typeof value === 'string' ? value : String(value)
}

function ApprovalPayload({ approval }: { approval: ApprovalRequest }) {
  const payload = approval.payload
  if (approval.actionType === 'mcp_call') {
    return (
      <div className="approval-payload">
        <div className="approval-payload-row">
          <span>Server</span>
          <code>{payloadValue(payload, 'serverName') ?? '?'}</code>
        </div>
        <div className="approval-payload-row">
          <span>Tool</span>
          <code>{payloadValue(payload, 'toolName') ?? '?'}</code>
        </div>
        <span>Arguments</span>
        <pre>{JSON.stringify(payload.arguments ?? {}, null, 2)}</pre>
      </div>
    )
  }

  if (approval.actionType === 'run_command') {
    return (
      <div className="approval-payload">
        <span>Command</span>
        <pre>{payloadValue(payload, 'command') ?? '(missing command)'}</pre>
        <div className="approval-payload-row">
          <span>Working directory</span>
          <code>{payloadValue(payload, 'cwd') ?? '.'}</code>
        </div>
        {payloadValue(payload, 'background') !== null && (
          <div className="approval-payload-row">
            <span>Background</span>
            <code>{String(payload.background)}</code>
          </div>
        )}
      </div>
    )
  }

  if (approval.actionType === 'patch_file') {
    if (payloadValue(payload, 'operation') === 'apply_patch') {
      return (
        <div className="approval-payload">
          <div className="approval-payload-row">
            <span>Path</span>
            <code>{payloadValue(payload, 'path') ?? '?'}</code>
          </div>
          <span>Patch</span>
          <pre>{payloadValue(payload, 'patch') ?? ''}</pre>
        </div>
      )
    }
    return (
      <div className="approval-payload">
        <div className="approval-payload-row">
          <span>Path</span>
          <code>{payloadValue(payload, 'path') ?? '?'}</code>
        </div>
        <span>Replace</span>
        <pre>{payloadValue(payload, 'oldText') ?? ''}</pre>
        <span>With</span>
        <pre>{payloadValue(payload, 'newText') ?? ''}</pre>
      </div>
    )
  }

  if (approval.actionType === 'move_path') {
    return (
      <div className="approval-payload">
        <div className="approval-payload-row">
          <span>From</span>
          <code>{payloadValue(payload, 'from') ?? '?'}</code>
        </div>
        <div className="approval-payload-row">
          <span>To</span>
          <code>{payloadValue(payload, 'to') ?? '?'}</code>
        </div>
      </div>
    )
  }

  return (
    <div className="approval-payload">
      <div className="approval-payload-row">
        <span>Path</span>
        <code>{payloadValue(payload, 'path') ?? '?'}</code>
      </div>
      {payloadValue(payload, 'bytes') && (
        <div className="approval-payload-row">
          <span>Size</span>
          <code>{Number(payload.bytes).toLocaleString()} bytes</code>
        </div>
      )}
      {payloadValue(payload, 'preview') && (
        <>
          <span>Preview</span>
          <pre>{payloadValue(payload, 'preview')}</pre>
        </>
      )}
    </div>
  )
}

export function ApprovalCenter() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    window.agentdesk
      .listApprovals()
      .then((result) => {
        if (!cancelled && result.ok) {
          setApprovals(result.data)
        }
      })
      .catch(() => undefined)
    const unsubscribe = window.agentdesk.onApprovalEvent((event: ApprovalEvent) => {
      if (event.type === 'request') {
        setApprovals((current) =>
          current.some((entry) => entry.id === event.approval.id)
            ? current
            : [...current, event.approval]
        )
        return
      }
      setApprovals((current) =>
        current.filter((entry) => entry.id !== event.approvalId)
      )
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const approval = approvals[0]

  async function decide(decision: ApprovalDecisionInput['decision']): Promise<void> {
    if (!approval) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await window.agentdesk.decideApproval({
        approvalId: approval.id,
        decision
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setApprovals((current) =>
        current.filter((entry) => entry.id !== approval.id)
      )
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : 'The approval could not be recorded.'
      )
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!approval) {
      return
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === '1') {
        void decide('once')
      } else if (event.key === '2') {
        void decide('project')
      } else if (event.key === '3' || event.key === 'Escape') {
        void decide('deny')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [approval, busy])

  if (!approval) {
    return null
  }

  return (
    <div className="modal-backdrop approval-backdrop" role="presentation">
      <div
        className="modal permission-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
      >
        <header className="permission-header">
          <div className={`permission-icon ${approval.risk}`}>
            <Icon name="shield" size={18} />
          </div>
          <div className="permission-title">
            <h2 id="approval-title">Permission required</h2>
            <p>
              {approval.agentId} wants to {actionTitle(approval.actionType).toLowerCase()}
            </p>
          </div>
          <span className={`approval-risk ${approval.risk}`}>{approval.risk} risk</span>
        </header>

        <div className="permission-body">
          <p className="approval-reason">{approval.reason}</p>
          <ApprovalPayload approval={approval} />
          {approval.actionType === 'run_command' && (
            <p className="approval-note">
              Runs with your Windows user permissions. Approval does not sandbox it.
            </p>
          )}
          {approvals.length > 1 && (
            <p className="approval-note">
              1 of {approvals.length} pending. Remaining requests appear after this one.
            </p>
          )}
          {error && (
            <div className="approval-error">
              <Icon name="alert" size={14} />
              {error}
            </div>
          )}
        </div>

        <footer className="permission-footer">
          <button
            className="permission-choice reject"
            type="button"
            onClick={() => void decide('deny')}
            disabled={busy}
          >
            <span>Reject</span>
            <kbd>3</kbd>
          </button>
          <button
            className="permission-choice"
            type="button"
            onClick={() => void decide('once')}
            disabled={busy}
          >
            <span>Allow once</span>
            <kbd>1</kbd>
          </button>
          <button
            className="permission-choice primary"
            type="button"
            onClick={() => void decide('project')}
            disabled={busy}
          >
            <span>Always allow</span>
            <kbd>2</kbd>
          </button>
        </footer>
        <div className="permission-hint">
          {formatRelativeTime(approval.createdAt)} - project scope keeps this action allowed
          until you change it.
        </div>
      </div>
    </div>
  )
}


