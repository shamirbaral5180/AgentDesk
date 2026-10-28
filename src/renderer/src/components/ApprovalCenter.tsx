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

  if (approvals.length === 0) {
    return null
  }

  const approval = approvals[0]

  async function decide(decision: ApprovalDecisionInput['decision']): Promise<void> {
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

  return (
    <div className="modal-backdrop approval-backdrop" role="presentation">
      <div
        className="modal approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
      >
        <header className="modal-header">
          <div className="modal-title-group">
            <span className={`approval-risk-icon ${approval.risk}`}>
              <Icon name="shield" size={19} />
            </span>
            <div>
              <h2 id="approval-title">Boss approval required</h2>
              <p>
                {actionTitle(approval.actionType)}  -  {formatRelativeTime(approval.createdAt)}
                {approvals.length > 1 ? `  -  1 of ${approvals.length} pending` : ''}
              </p>
            </div>
          </div>
          <span className={`approval-risk ${approval.risk}`}>{approval.risk} risk</span>
        </header>

        <div className="modal-body approval-body">
          <p className="approval-reason">{approval.reason}</p>
          <ApprovalPayload approval={approval} />
          {approval.actionType === 'run_command' && (
            <p className="approval-note">
              The command will run with your Windows user permissions. Approval does not
              sandbox it.
            </p>
          )}
          {error && (
            <div className="approval-error">
              <Icon name="alert" size={14} />
              {error}
            </div>
          )}
        </div>

        <footer className="modal-footer approval-footer">
          <button
            className="btn btn-ghost btn-small"
            type="button"
            onClick={() => void decide('deny')}
            disabled={busy}
          >
            Deny
          </button>
          <div className="approval-actions">
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => void decide('once')}
              disabled={busy}
            >
              Allow once
            </button>
            <button
              className="btn btn-quiet btn-small"
              type="button"
              onClick={() => void decide('session')}
              disabled={busy}
            >
              Allow this session
            </button>
            <button
              className="btn btn-primary btn-small"
              type="button"
              onClick={() => void decide('project')}
              disabled={busy}
            >
              Allow for project
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}


