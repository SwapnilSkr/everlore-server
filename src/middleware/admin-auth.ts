import { createHash, timingSafeEqual } from 'crypto'
import { Elysia } from 'elysia'
import { env } from '../config/env'

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
  .onBeforeHandle({ as: 'scoped' }, ({ headers, set }) => {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
      set.status = 503
      return { error: 'Admin credentials are not configured' }
    }

    const credentials = decodeBasicAuth(headers.authorization)
    const valid =
      credentials &&
      constantTimeEqual(credentials.username, env.ADMIN_USERNAME) &&
      constantTimeEqual(credentials.password, env.ADMIN_PASSWORD)

    if (!valid) {
      set.status = 401
      set.headers['WWW-Authenticate'] = 'Basic realm="Everlore Admin"'
      return { error: 'Unauthorized' }
    }
  })
