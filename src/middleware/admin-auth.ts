import { createHash, timingSafeEqual } from 'crypto'
import { Elysia } from 'elysia'
import { env } from '../config/env'
import { rateLimit } from './rate-limit'
import { log } from '../utils/logger'

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = digest(a)
  const right = digest(b)
  return timingSafeEqual(left, right)
}

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
 * Basic-auth gate for the whole `/admin` surface.
 *
 * Both hooks are `as: 'scoped'` on purpose. Elysia hooks default to `'local'`,
 * which confines them to routes declared on *this* instance — and this instance
 * declares none, so an unscoped guard silently protects nothing and every admin
 * route answers unauthenticated callers. `'scoped'` propagates the guard to the
 * instance that mounts it (the admin router) without leaking it app-wide the way
 * `'global'` would.
 */
export const requireAdmin = new Elysia({ name: 'require-admin' })
  /**
   * The authenticated admin's username, for moderation audit trails. There are
   * no admin user documents — Basic auth is the whole identity — so the name on
   * the credential is the only attribution available.
   */
  .derive({ as: 'scoped' }, ({ headers }) => ({
    adminUser: decodeBasicAuth(headers.authorization)?.username || 'admin',
  }))
  .onBeforeHandle({ as: 'scoped' }, async ({ headers, set, request, server }) => {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
      set.status = 503
      return { error: 'Admin credentials are not configured' }
    }

    const caller = clientAddress(headers, request, server)

    // Peek before comparing. A caller who has already burned the budget is
    // turned away without another guess being scored, so the window cannot be
    // held open indefinitely by continuing to hammer it.
    const budget = await failureBudget(caller, { consume: false })
    if (!budget.allowed) {
      set.status = 429
      if (budget.retryAfter) set.headers['Retry-After'] = String(budget.retryAfter)
      return { error: 'Too many failed sign-in attempts. Try again later.' }
    }

    const credentials = decodeBasicAuth(headers.authorization)
    const valid =
      credentials &&
      constantTimeEqual(credentials.username, env.ADMIN_USERNAME) &&
      constantTimeEqual(credentials.password, env.ADMIN_PASSWORD)

    if (!valid) {
      // Only failures are charged. The console re-sends Basic auth on every
      // request, so charging successes would lock out an operator who is
      // simply working.
      await failureBudget(caller, { consume: true })
      log.warn('admin auth rejected', {
        caller,
        // The username is attacker-supplied, not a secret; knowing which name
        // is being guessed is the difference between a scan and a targeted
        // attempt. The password is never logged.
        attemptedUser: credentials?.username || '(none)',
      })
      set.status = 401
      set.headers['WWW-Authenticate'] = 'Basic realm="Everlore Admin"'
      return { error: 'Unauthorized' }
    }
  })

/**
 * Best-effort client address for rate-limit keying.
 *
 * `x-forwarded-for` is caller-controlled and trivially spoofed, so this is a
 * throttle, not an identity. It raises the cost of guessing from "free" to
 * "needs to rotate a header", and the socket address is used whenever the
 * proxy did not set one.
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
