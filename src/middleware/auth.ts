import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { authService } from '../services/auth.service'

export interface AuthUser {
  id: string
  email: string
  username: string
  tier: string
}

function payloadToUser(payload: unknown): AuthUser | null {
  if (payload === false || !payload || typeof payload !== 'object') return null
  const rec = payload as Record<string, unknown>
  const id = rec.id
  if (typeof id !== 'string') return null
  return {
    id,
    email: typeof rec.email === 'string' ? rec.email : '',
    username: typeof rec.username === 'string' ? rec.username : '',
    tier: typeof rec.tier === 'string' ? rec.tier : 'free',
  }
}

export const authPlugin = new Elysia({ name: 'auth-plugin' })
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .derive({ as: 'global' }, async ({ jwt, headers }) => {
    const auth = headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return { user: null as AuthUser | null }
    }

    const token = auth.slice(7)
    const payload = await jwt.verify(token)
    const user = payloadToUser(payload)
    if (!user) return { user: null as AuthUser | null }

    // Tier is stored on the user doc; JWT may still say `free` until re-login.
    const tier = await authService.getLiveTier(user.id)
    return { user: { ...user, tier } }
  })

/** Chain after `authPlugin` to reject unauthenticated requests (optional helper). */
export const requireAuth = new Elysia({ name: 'require-auth' })
  .use(authPlugin)
  .onBeforeHandle((ctx) => {
    const user = (ctx as typeof ctx & { user: AuthUser | null }).user
    if (!user) {
      ctx.set.status = 401
      return { error: 'Unauthorized' }
    }
  })

export async function verifyWsToken(
  jwtApi: { verify: (jwt: string) => Promise<unknown> },
  token: string,
): Promise<AuthUser | null> {
  try {
    const raw = await jwtApi.verify(token)
    return payloadToUser(raw)
  } catch {
    return null
  }
}
