import { getRedisClient } from '../config/redis'

const LIMITS: Record<string, { max: number; windowSeconds: number }> = {
  chat: { max: 10, windowSeconds: 60 },
  memory_edit: { max: 30, windowSeconds: 3600 },
  template_create: { max: 5, windowSeconds: 86400 },
  auth_attempt: { max: 10, windowSeconds: 300 },
}

export async function rateLimit(
  userId: string,
  action: string,
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  const limit = LIMITS[action]
  if (!limit) return { allowed: true, remaining: Infinity }

  const redis = getRedisClient()
  const key = `rl:${action}:${userId}`
  const current = await redis.incr(key)

  if (current === 1) {
    await redis.expire(key, limit.windowSeconds)
  }

  if (current > limit.max) {
    const ttl = await redis.ttl(key)
    return { allowed: false, remaining: 0, retryAfter: ttl }
  }

  return { allowed: true, remaining: limit.max - current }
}
