import { getRedisClient, getRedisSubscriber } from '../config/redis'
import { generationService } from './generation.service'
import { verifyWsToken, type AuthUser } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'

const activeConnections = new Map<string, Set<{ send: (data: string) => void }>>()

export function setupRedisPubSub() {
  const subscriber = getRedisSubscriber()

  subscriber.on('message', (channel: string, message: string) => {
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

type PlayWs = {
  send: (data: string) => void
  close: () => void
  data: unknown
}

function getWsData(ws: PlayWs): { query?: { token?: string }; jwt: { verify: (t: string) => Promise<unknown> } } {
  return ws.data as {
    query?: { token?: string }
    jwt: { verify: (t: string) => Promise<unknown> }
  }
}

export const playWsService = {
  async handleOpen(ws: PlayWs) {
    const { query, jwt } = getWsData(ws)
    const token = query?.token
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'No token provided' }))
      ws.close()
      return
    }

    const user = await verifyWsToken(jwt, token)
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }))
      ws.close()
      return
    }

    ;(ws as PlayWs & { _user?: AuthUser })._user = user

    if (!activeConnections.has(user.id)) {
      activeConnections.set(user.id, new Set())
    }
    activeConnections.get(user.id)!.add(ws)

    const subscriber = getRedisSubscriber()
    await subscriber.subscribe(`user:${user.id}:events`)

    ws.send(JSON.stringify({ type: 'connected', userId: user.id }))
  },

  async handleMessage(ws: PlayWs, msg: unknown) {
    const user = (ws as PlayWs & { _user?: AuthUser })._user
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }))
      return
    }

    const redis = getRedisClient()
    const data = typeof msg === 'string' ? JSON.parse(msg) : msg
    const action = (data as { action?: string }).action

    switch (action) {
      case 'chat': {
        const instanceId = (data as { instance_id?: string }).instance_id
        if (!instanceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing instance_id' }))
          return
        }

        const rl = await rateLimit(user.id, 'chat')
        if (!rl.allowed) {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'RATE_LIMITED',
              retryAfter: rl.retryAfter,
            }),
          )
          return
        }

        const lockKey = `lock:gen:${user.id}:${instanceId}`
        const locked = await redis.exists(lockKey)
        if (locked) {
          ws.send(JSON.stringify({ type: 'error', code: 'GENERATION_IN_PROGRESS' }))
          return
        }

        try {
          const payload = (data as { payload?: { message?: string } }).payload
          const message = payload?.message
          if (!message || typeof message !== 'string' || message.length === 0 || message.length > 4000) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }))
            return
          }

          const jobId = await generationService.dispatch({
            instanceId,
            playerId: user.id,
            userMessage: message,
          })

          await redis.set(lockKey, jobId!, 'EX', 30)

          ws.send(JSON.stringify({ type: 'ack', jobId }))
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ type: 'error', message }))
        }
        break
      }

      case 'load_instance': {
        try {
          const instanceId = (data as { instance_id?: string }).instance_id
          const state = await generationService.loadInstance(instanceId!, user.id)
          ws.send(JSON.stringify({ type: 'instance_loaded', data: state }))
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ type: 'error', message }))
        }
        break
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }))
        break
      }

      default: {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${String(action)}` }))
      }
    }
  },

  handleClose(ws: PlayWs) {
    const user = (ws as PlayWs & { _user?: AuthUser })._user
    if (user) {
      const connections = activeConnections.get(user.id)
      if (connections) {
        connections.delete(ws)
        if (connections.size === 0) {
          activeConnections.delete(user.id)
          const subscriber = getRedisSubscriber()
          subscriber.unsubscribe(`user:${user.id}:events`).catch(() => {})
        }
      }
    }
  },
}
