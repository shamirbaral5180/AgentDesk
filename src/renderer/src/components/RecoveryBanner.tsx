import { useState } from 'react'
import type { RecoveryReport } from '@shared/types'
import { Icon } from './Icon'

type RecoveryBannerProps = {
  report: RecoveryReport
  busy: boolean
  onResume: (meetingId: string) => void
  onMarkStopped: (meetingId: string) => void
  onDismiss: () => void
}

export function RecoveryBanner({
  report,
  busy,
  onResume,
  onMarkStopped,
  onDismiss
}: RecoveryBannerProps) {
  const [showDetails, setShowDetails] = useState(false)
  const resumable = report.items.filter((item) => item.canResume && item.meetingId)
  const chatInterrupted = report.interruptedMessages

  if (resumable.length === 0 && chatInterrupted === 0) {
    return null
  }

  return (
    <div className="recovery-banner" role="alert">
      <span className="recovery-banner-icon">
        <Icon name="alert" size={17} />
      </span>
      <div className="recovery-banner-copy">
        <strong>AgentDesk recovered from an interrupted session</strong>
        <span>
          {resumable.length > 0
            ? `${resumable.length} meeting${resumable.length === 1 ? '' : 's'} can resume from the last checkpoint.`
            : 'An assistant response was interrupted and needs a manual retry.'}{' '}
          Completed work is preserved.
        </span>
        {showDetails && (
          <div className="recovery-details">
            {report.items.map((item) => (
              <div className="recovery-detail-row" key={item.leaseId}>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.kind} / {item.phase ?? 'unknown phase'} /{' '}
                    {new Date(item.heartbeatAt).toLocaleString()}
                  </span>
                </div>
                {item.canResume && item.meetingId && (
                  <div className="recovery-detail-actions">
                    <button
                      className="btn btn-primary btn-small"
                      type="button"
                      disabled={busy}
                      onClick={() => onResume(item.meetingId as string)}
                    >
                      Resume
                    </button>
                    <button
                      className="btn btn-quiet btn-small"
                      type="button"
                      disabled={busy}
                      onClick={() => onMarkStopped(item.meetingId as string)}
                    >
                      Mark stopped
                    </button>
                  </div>
                )}
              </div>
            ))}
            {chatInterrupted > 0 && (
              <div className="recovery-detail-row">
                <div>
                  <strong>{chatInterrupted} interrupted chat response(s)</strong>
                  <span>Open the conversation and retry the message manually.</span>
                </div>
              </div>
            )}
            {report.releasedClaims > 0 && (
              <div className="recovery-detail-row">
                <div>
                  <strong>{report.releasedClaims} stale file claim(s) released</strong>
                  <span>No agent can write through an old claim.</span>
                </div>
              </div>
            )}
            {report.cancelledApprovals > 0 && (
              <div className="recovery-detail-row">
                <div>
                  <strong>{report.cancelledApprovals} stale approval(s) cancelled</strong>
                  <span>Ask the agent to retry the action.</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="recovery-banner-actions">
        <button
          className="btn btn-quiet btn-small"
          type="button"
          onClick={() => setShowDetails((value) => !value)}
        >
          {showDetails ? 'Hide details' : 'View details'}
        </button>
        {resumable[0]?.meetingId && (
          <button
            className="btn btn-primary btn-small"
            type="button"
            disabled={busy}
            onClick={() => onResume(resumable[0].meetingId as string)}
          >
            Resume
          </button>
        )}
        <button
          className="icon-button"
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss recovery notice"
          title="Dismiss"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  )
}
