import { Elysia, t } from 'elysia'
import { jwt } from '@elysiajs/jwt'
import { env } from '../config/env'
import { getRedisClient, getRedisSubscriber } from '../config/redis'
import { generationService } from '../services/generation.service'
import { verifyWsToken, type AuthUser } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'

// Store active WebSocket connections keyed by user ID
const activeConnections = new Map<string, Set<any>>()

export function setupRedisPubSub() {
  const subscriber = getRedisSubscriber()

  subscriber.on('message', (channel: string, message: string) => {
    // Channel format: user:{userId}:events
    const match = channel.match(/^user:(.+):events$/)
    if (!match) return

    const userId = match[1]
    const connections = activeConnections.get(userId)
    if (!connections) return

    const parsed = JSON.parse(message)
    for (const ws of connections) {
      try {
        ws.send(JSON.stringify(parsed))
      } catch {
        // Connection likely closed
      }
    }
  })
}

export const wsRoutes = new Elysia()
  .use(jwt({ name: 'jwt', secret: env.JWT_SECRET }))
  .ws('/ws/play', {
    body: t.Object({
      action: t.String(),
      instance_id: t.Optional(t.String()),
      payload: t.Optional(t.Any()),
    }),

    async open(ws) {
      const token = (ws.data as any).query?.token
      if (!token) {
        ws.send(JSON.stringify({ type: 'error', message: 'No token provided' }))
        ws.close()
        return
      }

      const user = await verifyWsToken((ws.data as any).jwt, token)
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }))
        ws.close()
        return
      }

      ;(ws as any)._user = user

      // Track connection
      if (!activeConnections.has(user.id)) {
        activeConnections.set(user.id, new Set())
      }
      activeConnections.get(user.id)!.add(ws)

      // Subscribe to user's Redis channel
      const subscriber = getRedisSubscriber()
      await subscriber.subscribe(`user:${user.id}:events`)

      ws.send(JSON.stringify({ type: 'connected', userId: user.id }))
    },

    async message(ws, msg) {
      const user = (ws as any)._user as AuthUser | undefined
      if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }))
        return
      }

      const redis = getRedisClient()
      const data = typeof msg === 'string' ? JSON.parse(msg) : msg

      switch (data.action) {
        case 'chat': {
          const instanceId = data.instance_id
          if (!instanceId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing instance_id' }))
            return
          }

          // Rate limit
          const rl = await rateLimit(user.id, 'chat')
          if (!rl.allowed) {
            ws.send(JSON.stringify({ type: 'error', code: 'RATE_LIMITED', retryAfter: rl.retryAfter }))
            return
          }

          // Check generation lock
          const lockKey = `lock:gen:${user.id}:${instanceId}`
          const locked = await redis.exists(lockKey)
          if (locked) {
            ws.send(JSON.stringify({ type: 'error', code: 'GENERATION_IN_PROGRESS' }))
            return
          }

          try {
            const message = data.payload?.message
            if (!message || typeof message !== 'string' || message.length === 0 || message.length > 4000) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }))
              return
            }

            const jobId = await generationService.dispatch({
              instanceId,
              playerId: user.id,
              userMessage: message,
            })

            // Set lock
            await redis.set(lockKey, jobId!, 'EX', 30)

            ws.send(JSON.stringify({ type: 'ack', jobId }))
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
          }
          break
        }

        case 'load_instance': {
          try {
            const state = await generationService.loadInstance(data.instance_id, user.id)
            ws.send(JSON.stringify({ type: 'instance_loaded', data: state }))
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
          }
          break
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }))
          break
        }

        default: {
          ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${data.action}` }))
        }
      }
    },

    close(ws) {
      const user = (ws as any)._user as AuthUser | undefined
      if (user) {
        const connections = activeConnections.get(user.id)
        if (connections) {
          connections.delete(ws)
          if (connections.size === 0) {
            activeConnections.delete(user.id)
            // Unsubscribe from Redis channel
            const subscriber = getRedisSubscriber()
            subscriber.unsubscribe(`user:${user.id}:events`).catch(() => {})
          }
        }
      }
    },
  })
