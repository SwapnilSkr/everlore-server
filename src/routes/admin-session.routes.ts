import { Elysia, t } from 'elysia'
import { env } from '../config/env'
import { rateLimit } from './../middleware/rate-limit'
import { log } from '../utils/logger'
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  constantTimeEqual,
  createSession,
  destroySession,
  isSecureRequest,
  readCookie,
  readSession,
  sessionCookie,
} from '../services/admin-session.service'

const SignInBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 200 }),
  password: t.String({ minLength: 1, maxLength: 400 }),
})

/**
 * Same keying as the Basic-auth guard, and deliberately the same rate-limit
 * bucket: this endpoint and the header are two doors into one credential, so a
 * budget spent on either has to count against the other.
 */
function clientAddress(
  headers: Record<string, string | undefined>,
  request: Request,
  server: { requestIP?: (req: Request) => { address: string } | null } | null,
): string {
  const forwarded = headers['x-forwarded-for']?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return server?.requestIP?.(request)?.address || 'unknown'
}

async function failureBudget(caller: string, consume: boolean) {
  try {
    return await rateLimit(caller, 'admin_auth_failure', { consume })
  } catch (error) {
    log.error('admin session rate limit unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { allowed: true as const }
  }
}

/**
 * Sign-in, sign-out and session probe for the admin console.
 *
 * Mounted separately from `adminRoutes` because these cannot sit behind
 * `requireAdmin` — signing in is precisely the state of not yet being signed
 * in. They share the `/admin` prefix so the console's single API base reaches
 * everything.
 */
export const adminSessionRoutes = new Elysia({ prefix: '/admin' })
  .post(
    '/session',
    async ({ body, headers, set, request, server }) => {
      if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
        set.status = 503
        return { error: 'Admin credentials are not configured' }
      }

      const caller = clientAddress(headers, request, server)
      const budget = await failureBudget(caller, false)
      if (!budget.allowed) {
        set.status = 429
        if ('retryAfter' in budget && budget.retryAfter) {
          set.headers['Retry-After'] = String(budget.retryAfter)
        }
        return { error: 'Too many failed sign-in attempts. Try again later.' }
      }

      const valid =
        constantTimeEqual(body.username, env.ADMIN_USERNAME) &&
        constantTimeEqual(body.password, env.ADMIN_PASSWORD)

      if (!valid) {
        await failureBudget(caller, true)
        log.warn('admin sign-in rejected', { caller, attemptedUser: body.username })
        set.status = 401
        return { error: 'Invalid username or password' }
      }

      const token = await createSession(body.username)
      set.headers['set-cookie'] = sessionCookie(token, isSecureRequest(headers, request))
      log.info('admin signed in', { caller, username: body.username })
      return { username: body.username }
    },
    { body: SignInBody },
  )

  /**
   * Reports whether the caller's cookie is still good. The console calls this
   * on load: the token is httpOnly, so the page genuinely cannot tell whether
   * it holds a live session without asking.
   */
  .get('/session', async ({ headers, set }) => {
    const username = await readSession(readCookie(headers.cookie, SESSION_COOKIE))
    if (!username) {
      set.status = 401
      return { error: 'No active session' }
    }
    return { username }
  })

  .delete('/session', async ({ headers, set, request }) => {
    await destroySession(readCookie(headers.cookie, SESSION_COOKIE))
    set.headers['set-cookie'] = clearedSessionCookie(isSecureRequest(headers, request))
    return { ok: true }
  })
