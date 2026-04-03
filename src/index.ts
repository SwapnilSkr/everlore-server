import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { connectMongo } from './config/mongo'
import { connectRedis } from './config/redis'
import { env } from './config/env'
import { authRoutes } from './routes/auth.routes'
import { templateRoutes } from './routes/template.routes'
import { instanceRoutes } from './routes/instance.routes'
import { chronicleRoutes } from './routes/chronicle.routes'
import { wsRoutes, setupRedisPubSub } from './routes/ws.routes'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(error)
}

async function main() {
  await connectMongo()
  await connectRedis()
  setupRedisPubSub()

  const app = new Elysia()
    .use(cors({ origin: env.CLIENT_ORIGINS }))
    .onError(({ error, set }) => {
      const msg = errorMessage(error)
      if (msg === 'Unauthorized') {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (msg.includes('not found') || msg.includes('Not found')) {
        set.status = 404
        return { error: msg }
      }
      if (msg.includes('limit') || msg.includes('Rate')) {
        set.status = 429
        return { error: msg }
      }
      console.error('Unhandled error:', error)
      set.status = 500
      return { error: 'Internal server error' }
    })
    .get('/', () => 'Everlore API')
    .get('/health', () => ({ ok: true, timestamp: new Date().toISOString() }))
    .use(authRoutes)
    .use(templateRoutes)
    .use(instanceRoutes)
    .use(chronicleRoutes)
    .use(wsRoutes)
    .listen(env.PORT)

  console.log(`Everlore API running on port ${env.PORT}`)
}

main().catch((err) => {
  console.error('Server startup failed:', err)
  process.exit(1)
})
