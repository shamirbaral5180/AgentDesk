import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Brand } from './Brand'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      message: ''
    }
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'The interface hit an unexpected error.'
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="boot-error">
          <div className="boot-error-card">
            <Brand />
            <h1>The interface stopped</h1>
            <p>{this.state.message}</p>
            <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
              Reload AgentDesk
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
