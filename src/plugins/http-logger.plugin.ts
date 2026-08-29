import { Elysia } from 'elysia'
import { log, publicRequestMeta } from '../utils/logger'

function statusForLog(set: { status?: unknown }, hadError: boolean): number | string {
  const s = set.status
  if (s !== undefined && s !== null) {
    if (typeof s === 'number') return s
    return String(s)
  }
  return hadError ? 500 : 200
}

/**
 * Query keys whose value is a credential rather than a parameter.
 *
 * A browser cannot set headers on a WebSocket handshake, so the play socket
 * passes the session JWT as `/ws/play?token=...`. TLS covers that on the wire,
 * but this logger runs after the upgrade and wrote the whole query object to
 * the log sink — so a live session token was recorded in plaintext on every
 * connect, and again on every reconnect after a network flap.
 *
 * `publicRequestMeta` already reduces the same credential to `Bearer …` when it
 * arrives as a header. This keeps the two paths honest with each other.
 */
const SECRET_QUERY_KEYS = /token|secret|password|passwd|api[-_]?key|otp|code|signature|sig/i

function redactQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(query)) {
    out[key] = SECRET_QUERY_KEYS.test(key) ? '[redacted]' : value
  }
  return out
}

/**
 * Logs one line per HTTP request after the response is finished (status, timing, route).
 * Uses Elysia trace `onAfterResponse` so WebSocket upgrades and normal routes are covered.
 */
export const httpLoggerPlugin = new Elysia({ name: 'http-logger' }).trace(
  { as: 'global' },
  ({ onAfterResponse, context, id }) => {
    onAfterResponse(({ onStop }) => {
      onStop(({ elapsed, error }) => {
        if (process.env.REQUEST_LOG === '0') return

        const { request, path, route } = context
        let query: Record<string, unknown> | undefined
        const q = context.query as Record<string, unknown> | undefined
        if (q && typeof q === 'object' && Object.keys(q).length > 0) query = redactQuery(q)

        const url = new URL(request.url)
        const meta = publicRequestMeta(request)

        log.info('http.request', {
          requestId: id,
          method: request.method,
          path,
          pathname: url.pathname,
          route: route ?? path,
          query,
          status: statusForLog(context.set, error != null),
          durationMs: Math.round(elapsed * 100) / 100,
          error: error ? (error instanceof Error ? error.message : String(error)) : undefined,
          ...meta,
        })
      })
    })
  },
)
