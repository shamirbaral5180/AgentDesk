type BrandProps = {
  version?: string
  compact?: boolean
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand-mark brand-mark-compact' : 'brand-mark'} aria-hidden="true">
      <span className="brand-mark-a">A</span>
      <span className="brand-mark-d">D</span>
    </div>
  )
}

export function Brand({ version, compact = false }: BrandProps) {
  return (
    <div className={compact ? 'brand brand-compact' : 'brand'}>
      <BrandMark compact={compact} />
      <div className="brand-copy">
        <span className="brand-name">AgentDesk</span>
        {!compact && <span className="brand-subtitle">Multi-agent software studio</span>}
      </div>
      {version && <span className="version-chip">v{version}</span>}
    </div>
  )
}
