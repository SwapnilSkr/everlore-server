import { getRedisClient, getRedisSubscriber } from '../config/redis'
import { generationService } from './generation.service'
import { verifyWsToken, type AuthUser } from '../middleware/auth'
import { rateLimit } from '../middleware/rate-limit'
import { log } from '../utils/logger'

/** Underlying Bun socket — stable identity; Elysia passes a new `ElysiaWS` wrapper per event. */
type RawWs = { send: (data: string) => void }

const activeConnections = new Map<string, Set<RawWs>>()
const GENERATION_LOCK_TTL_SECONDS = 240
const REPLAY_LOCK_TTL_SECONDS = 240

/** Closes all WebSocket connections for a user (e.g. after account deletion). */
export function disconnectUserSockets(userId: string): void {
  const connections = activeConnections.get(userId)
  if (!connections) return

  for (const socket of connections) {
    try {
      socket.send(JSON.stringify({ type: 'account_deleted' }))
    } catch {
      // Socket may already be closed.
    }
  }

  activeConnections.delete(userId)
  getRedisSubscriber()
    .unsubscribe(`user:${userId}:events`)
    .catch(() => {})
}

export function setupRedisPubSub() {
  const subscriber = getRedisSubscriber()

  subscriber.on('message', (channel: string, message: string) => {
    const match = channel.match(/^user:(.+):events$/)
    if (!match) return

    const userId = match[1]
    const connections = activeConnections.get(userId)
    if (!connections) {
      // A frame was published but nobody is subscribed/tracked for this user —
      // this is exactly the "stream goes nowhere" symptom worth surfacing.
      const t = (() => { try { return JSON.parse(message).type } catch { return '?' } })()
      log.warn('ws.relay.no_connection', { userId, type: t })
      return
    }

    const parsed = JSON.parse(message)
    if (parsed?.type === 'replay_delta' || parsed?.type === 'replay_complete') {
      log.info('ws.relay', { userId, type: parsed.type, sockets: connections.size })
    }
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
  /** Bun upgrade payload; shared across all ElysiaWS wrapper instances for this connection. */
  data: WsUpgradeData
}

type WsUpgradeData = {
  query?: { token?: string }
  jwt: { verify: (t: string) => Promise<unknown> }
  _user?: AuthUser
}

function getWsData(ws: { data: WsUpgradeData }): WsUpgradeData {
  return ws.data
}

function getRawSocket(ws: PlayWs): RawWs {
  return (ws as unknown as { raw: RawWs }).raw
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

    getWsData(ws)._user = user

    if (!activeConnections.has(user.id)) {
      activeConnections.set(user.id, new Set())
    }
    const sockets = activeConnections.get(user.id)!
    const isFirstSocket = sockets.size === 0
    sockets.add(getRawSocket(ws))

    const subscriber = getRedisSubscriber()
    if (isFirstSocket) {
      await subscriber.subscribe(`user:${user.id}:events`)
    }

    ws.send(JSON.stringify({ type: 'connected', userId: user.id }))
  },

  async handleMessage(ws: PlayWs, msg: unknown) {
    const user = getWsData(ws)._user
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }))
      return
    }

    const redis = getRedisClient()
    const data = typeof msg === 'string' ? JSON.parse(msg) : msg
    const action = (data as { action?: string }).action

    if (action !== 'ping') {
      log.info('ws.message', {
        userId: user.id,
        action: action ?? '(none)',
        instanceId: (data as { instance_id?: string }).instance_id,
        eventId: (data as { event_id?: string }).event_id,
      })
    }

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
        const locked = await redis.set(lockKey, 'pending', 'EX', GENERATION_LOCK_TTL_SECONDS, 'NX')
        if (!locked) {
          ws.send(JSON.stringify({ type: 'error', code: 'GENERATION_IN_PROGRESS' }))
          return
        }

        try {
          const payload = (data as { payload?: { message?: string } }).payload
          const message = payload?.message
          if (!message || typeof message !== 'string' || message.length === 0 || message.length > 4000) {
            await redis.del(lockKey)
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }))
            return
          }

          const jobId = await generationService.dispatch({
            instanceId,
            playerId: user.id,
            userMessage: message,
          })

          await redis.set(lockKey, jobId!, 'EX', GENERATION_LOCK_TTL_SECONDS)

          ws.send(JSON.stringify({ type: 'ack', jobId }))
        } catch (err: unknown) {
          await redis.del(lockKey)
          const message = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ type: 'error', message }))
        }
        break
      }

      case 'continue': {
        const instanceId = (data as { instance_id?: string }).instance_id
        if (!instanceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing instance_id' }))
          return
        }

        const rl = await rateLimit(user.id, 'chat')
        if (!rl.allowed) {
          ws.send(
            JSON.stringify({ type: 'error', code: 'RATE_LIMITED', retryAfter: rl.retryAfter }),
          )
          return
        }

        const lockKey = `lock:gen:${user.id}:${instanceId}`
        const locked = await redis.set(lockKey, 'pending', 'EX', GENERATION_LOCK_TTL_SECONDS, 'NX')
        if (!locked) {
          ws.send(JSON.stringify({ type: 'error', code: 'GENERATION_IN_PROGRESS' }))
          return
        }

        try {
          // No player message — the world advances on its own. Optional payload
          // `advance` turns the quiet continue into a time-skip (calendar tick).
          const advanceRaw = (data as { payload?: { advance?: string } }).payload?.advance
          const timeAdvance =
            advanceRaw && ['hours', 'day', 'days', 'season'].includes(advanceRaw)
              ? advanceRaw
              : undefined
          const jobId = await generationService.dispatch({
            instanceId,
            playerId: user.id,
            userMessage: '',
            isContinuation: true,
            timeAdvance,
          })
          await redis.set(lockKey, jobId!, 'EX', GENERATION_LOCK_TTL_SECONDS)
          ws.send(JSON.stringify({ type: 'ack', jobId }))
        } catch (err: unknown) {
          await redis.del(lockKey)
          const message = err instanceof Error ? err.message : String(err)
          ws.send(JSON.stringify({ type: 'error', message }))
        }
        break
      }

      case 'replay': {
        const instanceId = (data as { instance_id?: string }).instance_id
        const eventId = (data as { event_id?: string }).event_id
        if (!instanceId || !eventId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing instance_id or event_id' }))
          return
        }

        const rl = await rateLimit(user.id, 'chat')
        if (!rl.allowed) {
          ws.send(
            JSON.stringify({ type: 'error', code: 'RATE_LIMITED', retryAfter: rl.retryAfter }),
          )
          return
        }

        const lockKey = `lock:gen:${user.id}:${instanceId}`
        const locked = await redis.set(lockKey, 'pending', 'EX', REPLAY_LOCK_TTL_SECONDS, 'NX')
        if (!locked) {
          ws.send(JSON.stringify({ type: 'error', code: 'GENERATION_IN_PROGRESS' }))
          return
        }

        try {
          const jobId = await generationService.dispatchReplay({
            instanceId,
            playerId: user.id,
            eventId,
          })
          // Replays widen retrieval and can run a touch longer than a normal turn.
          await redis.set(lockKey, jobId!, 'EX', REPLAY_LOCK_TTL_SECONDS)
          log.info('ws.replay.dispatched', { userId: user.id, instanceId, eventId, jobId })
          ws.send(JSON.stringify({ type: 'ack', jobId }))
        } catch (err: unknown) {
          await redis.del(lockKey)
          const message = err instanceof Error ? err.message : String(err)
          log.error('ws.replay.failed', { userId: user.id, instanceId, eventId, error: message })
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
        log.warn('ws.unknown_action', { userId: user.id, action: String(action) })
        ws.send(JSON.stringify({ type: 'error', message: `Unknown action: ${String(action)}` }))
      }
    }
  },

  handleClose(ws: PlayWs) {
    const user = getWsData(ws)._user
    if (user) {
      const connections = activeConnections.get(user.id)
      if (connections) {
        connections.delete(getRawSocket(ws))
        if (connections.size === 0) {
          activeConnections.delete(user.id)
          const subscriber = getRedisSubscriber()
          subscriber.unsubscribe(`user:${user.id}:events`).catch(() => {})
        }
      }
    }
  },
}
