import { HttpError } from './http-error'
import { log } from './logger'

/** What a socket client is allowed to be told about a failure. */
export type ClientError = { code: string; message: string }

/**
 * Codes the play socket can emit for an authored failure, derived from the
 * status the service threw. Anything not listed is not something the player can
 * act on, so it collapses to INTERNAL.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  402: 'INSUFFICIENT_INK',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
}

const GENERIC: ClientError = {
  code: 'INTERNAL',
  message: 'Something went wrong on our side. Please try again.',
}

/**
 * Turn an arbitrary thrown value into something safe to put on the wire.
 *
 * Every `catch` in the play socket used to forward `err.message` verbatim. For
 * the one error the client actually reads out loud — a spent Ink reserve —
 * that happened to be authored copy. For everything else it was whatever the
 * driver, the model SDK or a bug produced, and on the replay path the client
 * renders that string directly into the story surface. A dropped Mongo
 * connection reached the player as `connect ECONNREFUSED 127.0.0.1:27017`.
 *
 * `HttpError` is copy somebody wrote for a player to read, so it passes
 * through with a code the client can branch on. Anything else is logged in
 * full server-side and replaced with one generic line.
 */
export function toClientError(err: unknown, context: Record<string, unknown> = {}): ClientError {
  if (err instanceof HttpError) {
    const code = CODE_BY_STATUS[err.statusCode]
    if (code) return { code, message: err.message }
  }
  log.error('ws.error.internal', {
    ...context,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  return GENERIC
}
