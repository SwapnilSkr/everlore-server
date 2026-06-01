import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { CreateInstanceBody, InstanceQueryParams } from '../schemas/instance.schema'
import { instanceController } from '../controllers/instance.controller'

export const instanceRoutes = new Elysia({ prefix: '/instances' })
  .use(authPlugin)

  .get('/', (ctx) => instanceController.list(ctx), { query: InstanceQueryParams })

  .get('/:id', (ctx) => instanceController.getById(ctx))

  .post('/', (ctx) => instanceController.create(ctx), { body: CreateInstanceBody })

  .post('/:id/archive', (ctx) => instanceController.archive(ctx))

  .post('/:id/protagonist', (ctx) => instanceController.setProtagonist(ctx), {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 120 }),
      identity: t.Optional(t.String({ maxLength: 400 })),
    }),
  })

  .post('/:id/reset', (ctx) => instanceController.reset(ctx))

  .delete('/:id', (ctx) => instanceController.delete(ctx))

  .patch('/:id/settings', (ctx) => instanceController.updateSettings(ctx), {
    body: t.Object({
      narration_pov: t.Optional(
        t.Union([t.Literal('first'), t.Literal('third')]),
      ),
      tone: t.Optional(t.String({ maxLength: 100 })),
      focus_character_id: t.Optional(t.Nullable(t.String())),
    }),
  })
