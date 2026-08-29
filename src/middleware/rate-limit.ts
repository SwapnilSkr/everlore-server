import { env } from '../config/env'
import { getRedisClient } from '../config/redis'

const OTP_ACTIONS = new Set(['otp_send', 'otp_verify'])

const LIMITS: Record<string, { max: number; windowSeconds: number }> = {
  // chat + template_create caps are env-tunable so a parallel QA fleet can crank
  // them without weakening the committed defaults (see AUTOCHAT_PLAYBOOK.md).
  chat: { max: env.CHAT_RATE_MAX, windowSeconds: 60 },
  memory_edit: { max: 30, windowSeconds: 3600 },
  template_create: { max: env.TEMPLATE_CREATE_RATE_MAX, windowSeconds: 86400 },
  image_generate: { max: 40, windowSeconds: 3600 },
  image_upload: { max: 40, windowSeconds: 3600 },
  autofill: { max: 30, windowSeconds: 3600 },
  // A moderation queue is only useful if it cannot be flooded. Generous enough
  // that a player cleaning up a bad browse session never hits it.
  content_report: { max: 20, windowSeconds: 3600 },
  auth_attempt: { max: 10, windowSeconds: 300 },
  otp_send: { max: 5, windowSeconds: 600 },
  otp_verify: { max: 10, windowSeconds: 600 },
}

export async function rateLimit(
  userId: string,
  action: string,
  opts: { consume?: boolean } = {},
): Promise<{ allowed: boolean; remaining: number; retryAfter?: number }> {
  const { consume = true } = opts
  const limit = LIMITS[action]
  if (!limit) return { allowed: true, remaining: Infinity }

  if (env.DISABLE_OTP_RATE_LIMIT && OTP_ACTIONS.has(action)) {
    return { allowed: true, remaining: limit.max }
  }

  const redis = getRedisClient()
  const key = `rl:${action}:${userId}`

  // Peek mode: report status without spending a slot. Lets a caller reject an
  // over-budget request BEFORE doing expensive work, and only consume the slot
  // once the work actually succeeds (see template create).
  if (!consume) {
    const used = Number((await redis.get(key)) || 0)
    if (used >= limit.max) {
      const ttl = await redis.ttl(key)
      return { allowed: false, remaining: 0, retryAfter: ttl > 0 ? ttl : limit.windowSeconds }
    }
    return { allowed: true, remaining: limit.max - used }
  }

  const current = await redis.incr(key)

  if (current === 1) {
    await redis.expire(key, limit.windowSeconds)
  }

  if (current > limit.max) {
    const ttl = await redis.ttl(key)
    return { allowed: false, remaining: 0, retryAfter: ttl > 0 ? ttl : limit.windowSeconds }
  }

  return { allowed: true, remaining: limit.max - current }
}
