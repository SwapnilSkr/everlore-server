import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { CreateInstanceBody, InstanceQueryParams } from '../schemas/instance.schema'
import { instanceController } from '../controllers/instance.controller'

export const instanceRoutes = new Elysia({ prefix: '/instances' })
  .use(authPlugin)

  .get('/', (ctx) => instanceController.list(ctx), { query: InstanceQueryParams })

  .get('/play-status/:templateId', (ctx) => instanceController.playStatus(ctx))

  .get('/by-template/:templateId', (ctx) => instanceController.listByTemplate(ctx))

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
      mode: t.Optional(t.String({ maxLength: 40 })),
      message_length: t.Optional(
        t.Union([t.Literal('short'), t.Literal('medium'), t.Literal('long')]),
      ),
      focus_character_id: t.Optional(t.Nullable(t.String())),
      persona_id: t.Optional(t.Nullable(t.String())),
    }),
  })
