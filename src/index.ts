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

async function main() {
  await connectMongo()
  await connectRedis()
  setupRedisPubSub()

  const app = new Elysia()
    .use(cors({ origin: env.CLIENT_ORIGINS }))
    .onError(({ error, set }) => {
      if (error.message === 'Unauthorized') {
        set.status = 401
        return { error: 'Unauthorized' }
      }
      if (error.message.includes('not found') || error.message.includes('Not found')) {
        set.status = 404
        return { error: error.message }
      }
      if (error.message.includes('limit') || error.message.includes('Rate')) {
        set.status = 429
        return { error: error.message }
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
