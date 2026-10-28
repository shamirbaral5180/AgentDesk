import { Brand } from './Brand'

export function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-orbit" aria-hidden="true">
        <div className="loading-orbit-ring" />
        <div className="loading-orbit-core">
          <Brand compact />
        </div>
      </div>
      <p className="loading-title">Preparing the studio</p>
      <p className="loading-copy">Loading portable settings and project state.</p>
      <div className="loading-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}
