import { Elysia } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { getDb } from '../config/mongo'

export interface AuthUser {
  id: string
  email: string
  username: string
  tier: string
}

export const authPlugin = new Elysia({ name: 'auth-plugin' })
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .derive(async ({ jwt, headers }) => {
    const auth = headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return { user: null as AuthUser | null }
    }

    const token = auth.slice(7)
    const payload = await jwt.verify(token) as any
    if (!payload || !payload.id) {
      return { user: null as AuthUser | null }
    }

    return {
      user: {
        id: payload.id,
        email: payload.email,
        username: payload.username,
        tier: payload.tier,
      } as AuthUser,
    }
  })

export const requireAuth = new Elysia({ name: 'require-auth' })
  .use(authPlugin)
  .onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401
      return { error: 'Unauthorized' }
    }
  })

export async function verifyWsToken(jwtInstance: any, token: string): Promise<AuthUser | null> {
  try {
    const payload = await jwtInstance.verify(token) as any
    if (!payload || !payload.id) return null
    return {
      id: payload.id,
      email: payload.email,
      username: payload.username,
      tier: payload.tier,
    }
  } catch {
    return null
  }
}
