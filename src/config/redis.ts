import Redis from 'ioredis'
import { env } from './env'

let client: Redis | null = null
let subscriber: Redis | null = null
let queueClient: Redis | null = null

export async function connectRedis() {
  client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  queueClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })

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
