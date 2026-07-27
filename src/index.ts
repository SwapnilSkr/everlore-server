import { Elysia, ValidationError, ParseError, NotFoundError } from 'elysia'
import { cors } from '@elysiajs/cors'
import { connectMongo } from './config/mongo'
import { connectRedis } from './config/redis'
import { env } from './config/env'
import { authRoutes } from './routes/auth.routes'
import { templateRoutes } from './routes/template.routes'
import { instanceRoutes } from './routes/instance.routes'
import { personaRoutes } from './routes/persona.routes'
import { chronicleRoutes } from './routes/chronicle.routes'
import { adminRoutes } from './routes/admin.routes'
import { wsRoutes } from './routes/ws.routes'
import { billingRoutes } from './routes/billing.routes'
import { setupRedisPubSub } from './services/play-ws.service'
import { HttpError } from './utils/http-error'
import { httpLoggerPlugin } from './plugins/http-logger.plugin'

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
    .use(httpLoggerPlugin)
    .onError(({ error, code, set }) => {
      if (error instanceof HttpError) {
        set.status = error.statusCode
        return { error: error.message, ...(error.details || {}) }
      }

      if (error instanceof ValidationError) {
        set.status = error.status
        return { error: error.message }
      }

      if (code === 'VALIDATION') {
        set.status = 422
        return { error: errorMessage(error) }
      }

      if (error instanceof ParseError) {
        set.status = 400
        return { error: 'Invalid request body' }
      }

      if (code === 'PARSE') {
        set.status = 400
        return { error: 'Invalid request body' }
      }

      if (error instanceof NotFoundError) {
        set.status = 404
        return { error: error.message }
      }

      if (code === 'NOT_FOUND') {
        set.status = 404
        return { error: errorMessage(error) }
      }

      const msg = errorMessage(error)
      if (msg === 'Unauthorized') {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      if (msg.includes('Invalid credentials')) {
        set.status = 401
        return { error: msg }
      }

      if (msg.includes('not found') || msg.includes('Not found')) {
        set.status = 404
        return { error: msg }
      }

      if (
        msg.includes('Creator or premium tier required') ||
        msg.includes('do not have access') ||
        msg.includes('Instance limit reached')
      ) {
        set.status = 403
        return { error: msg }
      }

      if (msg.includes('already registered') || msg.includes('Username taken')) {
        set.status = 409
        return { error: msg }
      }

      if (msg.includes('limit') || msg.includes('Rate') || msg.includes('Too many')) {
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
    .use(adminRoutes)
    .use(templateRoutes)
    .use(instanceRoutes)
    .use(personaRoutes)
    .use(chronicleRoutes)
    .use(billingRoutes)
    .use(wsRoutes)
    .listen(env.PORT)

  console.log(`Everlore API running on port ${env.PORT}`)
}

main().catch((err) => {
  console.error('Server startup failed:', err)
  process.exit(1)
})
