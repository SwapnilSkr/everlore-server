import { Elysia } from 'elysia'
import { env } from '../config/env'
import { rateLimit } from './rate-limit'
import { log } from '../utils/logger'
import {
  SESSION_COOKIE,
  constantTimeEqual,
  readCookie,
  readSession,
} from '../services/admin-session.service'

function decodeBasicAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith('Basic ')) return null
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const sep = decoded.indexOf(':')
    if (sep < 0) return null
    return {
      username: decoded.slice(0, sep),
      password: decoded.slice(sep + 1),
    }
  } catch {
    return null
  }
}

/**
 * The authenticated username, computed once per request.
 *
 * Elysia runs `derive` before `beforeHandle` and `resolve` after it, so without
 * this the work would be done twice — once to decide whether to admit the
 * request and once to tell the handler who it was. Keying on the `Request`
 * object scopes it to the request exactly, and a WeakMap lets the entry go as
 * soon as the request does.
 */
const authenticatedUser = new WeakMap<Request, string>()

/**
 * A cookie-authenticated request must carry this header.
 *
 * `SameSite=Strict` is scoped to the *site*, not the origin, and
 * `www.everloreapp.com` is the same site as `admin.everloreapp.com` — so a
 * script running on the public web origin could make requests here and the
 * browser would attach the session cookie. Requiring a header the browser will
 * not send on a cross-origin request without a successful CORS preflight closes
 * that: the preflight fails, because `CLIENT_ORIGINS` does not list any origin
 * that would need it.
 *
 * Basic-auth callers are exempt. Nothing sends an `Authorization` header by
 * ambient authority, so there is no confused deputy to protect against, and
 * requiring it would break every script and `curl` invocation that uses `-u`.
 */
const ADMIN_REQUEST_HEADER = 'x-everlore-admin'

type AuthOutcome =
  | { ok: true; username: string }
  | { ok: false; status: number; error: string; retryAfter?: number }

async function authenticate(
  headers: Record<string, string | undefined>,
  request: Request,
  server: { requestIP?: (req: Request) => { address: string } | null } | null,
): Promise<AuthOutcome> {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return { ok: false, status: 503, error: 'Admin credentials are not configured' }
  }

  // The session cookie is tried first: it is what the console uses, and it
  // costs one Redis read rather than two SHA-256 digests.
  const token = readCookie(headers.cookie, SESSION_COOKIE)
  if (token) {
    if (!headers[ADMIN_REQUEST_HEADER]) {
      return { ok: false, status: 403, error: 'Missing admin request header' }
    }
    try {
      const username = await readSession(token)
      if (username) return { ok: true, username }
    } catch (error) {
      // A Redis outage must not silently downgrade to "unauthenticated" without
      // a trace, or a broken session store looks like a wrong password.
      log.error('admin session lookup failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const caller = clientAddress(headers, request, server)

  // Peek before comparing. A caller who has already burned the budget is turned
  // away without another guess being scored, so the window cannot be held open
  // indefinitely by continuing to hammer it.
  const budget = await failureBudget(caller, { consume: false })
  if (!budget.allowed) {
    return {
      ok: false,
      status: 429,
      error: 'Too many failed sign-in attempts. Try again later.',
      retryAfter: budget.retryAfter,
    }
  }

  const credentials = decodeBasicAuth(headers.authorization)
  const valid =
    credentials &&
    constantTimeEqual(credentials.username, env.ADMIN_USERNAME) &&
    constantTimeEqual(credentials.password, env.ADMIN_PASSWORD)

  if (!valid) {
    // Only failures are charged. Basic-auth callers re-send the credential on
    // every request, so charging successes would lock out an operator who is
    // simply working.
    await failureBudget(caller, { consume: true })
    log.warn('admin auth rejected', {
      caller,
      // The username is attacker-supplied, not a secret; knowing which name is
      // being guessed is the difference between a scan and a targeted attempt.
      // The password is never logged.
      attemptedUser: credentials?.username || '(none)',
    })
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  return { ok: true, username: credentials.username }
}

/**
 * Auth gate for the whole `/admin` surface: a session cookie, or Basic auth.
 *
 * Both hooks are `as: 'scoped'` on purpose. Elysia hooks default to `'local'`,
 * which confines them to routes declared on *this* instance — and this instance
 * declares none, so an unscoped guard silently protects nothing and every admin
 * route answers unauthenticated callers. `'scoped'` propagates the guard to the
 * instance that mounts it (the admin router) without leaking it app-wide the way
 * `'global'` would.
 *
 * Note the absence of a `WWW-Authenticate` header on the 401. Sending one made
 * Chrome open its own native password dialog for the console's same-origin
 * fetches, and that dialog is a trap: what is typed into it goes to the
 * browser's credential store, never to the page, so the app stayed
 * unauthenticated and the prompt reappeared forever. Nothing needs the header —
 * `curl -u` sends Basic preemptively rather than waiting to be challenged.
 */
export const requireAdmin = new Elysia({ name: 'require-admin' })
  .onBeforeHandle({ as: 'scoped' }, async ({ headers, set, request, server }) => {
    const outcome = await authenticate(headers, request, server)
    if (outcome.ok) {
      authenticatedUser.set(request, outcome.username)
      return
    }
    set.status = outcome.status
    if (outcome.retryAfter) set.headers['Retry-After'] = String(outcome.retryAfter)
    return { error: outcome.error }
  })
  /**
   * The authenticated admin's username, for moderation audit trails. There are
   * no admin user documents, so the name on the credential or session is the
   * only attribution available. `resolve` runs after the guard, so by this point
   * the request is known to be authentic.
   */
  .resolve({ as: 'scoped' }, ({ request }) => ({
    adminUser: authenticatedUser.get(request) || 'admin',
  }))

/**
 * Best-effort client address for rate-limit keying.
 *
 * `x-forwarded-for` is caller-controlled and trivially spoofed, so this is a
 * throttle, not an identity. It raises the cost of guessing from "free" to
 * "needs to rotate a header", and the socket address is used whenever the proxy
 * did not set one.
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

/**
 * Rate-limit lookup that fails open.
 *
 * Redis backs the limiter, and an admin console that cannot be signed into
 * during a Redis outage is a worse failure than a brief window without
 * throttling — the password is still required either way.
 */
async function failureBudget(
  caller: string,
  { consume }: { consume: boolean },
): Promise<{ allowed: boolean; retryAfter?: number }> {
  try {
    return await rateLimit(caller, 'admin_auth_failure', { consume })
  } catch (error) {
    log.error('admin auth rate limit unavailable', {
      error: error instanceof Error ? error.message : String(error),
    })
    return { allowed: true }
  }
}
