import { Elysia, t } from 'elysia'
import { requireAdmin } from '../middleware/admin-auth'
import { adminStoryEngineController as controller } from '../controllers/admin-story-engine.controller'

const Id = t.String({ pattern: '^[a-fA-F0-9]{24}$' })
export const adminStoryEngineRoutes = new Elysia({ prefix: '/story-engine' })
  .use(requireAdmin)
  .get('/turns', ({ query }) => controller.turns(query), {
    query: t.Object({
      page: t.Optional(t.Numeric({ minimum: 1, multipleOf: 1, maximum: 1000000 })),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      instance_id: t.Optional(Id), world_id: t.Optional(Id), model: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
      slow: t.Optional(t.Union([t.Literal('first_word'), t.Literal('after_reply')])),
      failed: t.Optional(t.Union([t.Literal('true'), t.Literal('false')])),
      min_cost_usd: t.Optional(t.Numeric({ minimum: 0 })),
      from: t.Optional(t.String({ format: 'date-time' })), to: t.Optional(t.String({ format: 'date-time' })),
    }),
  })
  .get('/turns/:logId', async ({ params, set }) => {
    const result = await controller.turn(params.logId)
    if (result) return result
    set.status = 404
    return { error: 'Turn not found.' }
  }, { params: t.Object({ logId: Id }) })
  .get('/calls/:callId/body', async ({ params, set }) => {
    const result = await controller.body(params.callId)
    if (result) return result
    set.status = 404
    return { error: 'This text is no longer kept (bodies are kept 7 days).' }
  }, { params: t.Object({ callId: Id }) })
  .get('/summary', ({ query }) => controller.summary(query.days ?? 7), {
    query: t.Object({ days: t.Optional(t.Numeric({ minimum: 1, maximum: 90, multipleOf: 1 })) }),
  })
