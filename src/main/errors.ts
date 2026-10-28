import type { IpcErrorPayload } from '@shared/types'

export class AppError extends Error {
  readonly code: string
  readonly details?: string

  constructor(code: string, message: string, details?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export function toIpcError(error: unknown): IpcErrorPayload {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details
    }
  }
  if (error instanceof Error) {
    return {
      code: 'UNEXPECTED_ERROR',
      message: error.message,
      details: error.stack
    }
  }
  return {
    code: 'UNEXPECTED_ERROR',
    message: 'An unexpected error occurred.'
  }
}
