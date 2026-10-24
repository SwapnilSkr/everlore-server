import Redis from 'ioredis'
import { env } from './env'

let client: Redis | null = null
let subscriber: Redis | null = null
let queueClient: Redis | null = null

// Object identity also fences a disconnect/reconnect to the SAME Redis process.
export type RedisProcess = Readonly<{ runId: string }>
const processes = new WeakMap<object, RedisProcess>()
const processReady = new Set<() => void>()

export function getRedisProcess(connection: object = getRedisClient()): RedisProcess | undefined {
  return processes.get(connection)
}

export function onRedisProcessReady(listener: () => void): () => void {
  processReady.add(listener)
  return () => { processReady.delete(listener) }
}

export function cacheRedisProcess(connection: Pick<Redis, 'on' | 'info'>, ready: () => void) {
  let generation = 0
  const clear = () => { generation++; processes.delete(connection) }
  for (const event of ['close', 'end', 'reconnecting']) connection.on(event, clear)
  connection.on('ready', () => {
    clear()
    const current = generation
    // INFO is outside turn validation. A slow/failed read simply leaves no proof.
    void (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const info = await Promise.race([connection.info('server'), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Redis process identity deadline')), 250)
        })])
        const runId = /^run_id:([0-9a-f]{40})\r?$/m.exec(info)?.[1]
        if (!runId) throw new Error('Missing or malformed Redis run_id')
        if (current !== generation) return
        processes.set(connection, { runId })
        ready()
      } catch { console.warn('Redis process identity unavailable') }
      finally { if (timer) clearTimeout(timer) }
    })()
  })
}

export async function connectRedis() {
  client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  queueClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  cacheRedisProcess(client, () => { for (const listener of processReady) listener() })

  client.on('error', (err) => console.error('Redis client error:', err.message))
  subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message))
  queueClient.on('error', (err) => console.error('Redis queue error:', err.message))

  await client.ping()
  console.log('Redis connected')
  return subscriber
}

export function getRedisClient(): Redis {
  if (!client) throw new Error('Redis not connected. Call connectRedis() first.')
  return client
}

export function getRedisSubscriber(): Redis {
  if (!subscriber) throw new Error('Redis subscriber not connected.')
  return subscriber
}

export function getQueueRedisClient(): Redis {
  if (!queueClient) throw new Error('Redis queue client not connected.')
  return queueClient
}
