export class HttpError extends Error {
  readonly statusCode: number
  /** Extra fields merged into the JSON error response (e.g. retryAfter, remaining). */
  readonly details?: Record<string, unknown>

  constructor(statusCode: number, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.details = details
  }
}
