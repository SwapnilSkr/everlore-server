import { Elysia, t } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { EventQueryParams, EditEventBody } from '../schemas/event.schema'
import { MemoryQueryParams, EditMemoryBody } from '../schemas/memory.schema'
import { chronicleController } from '../controllers/chronicle.controller'

export const chronicleRoutes = new Elysia({ prefix: '/chronicle' })
  .use(authPlugin)

  .get('/events/:instanceId', (ctx) => chronicleController.getEvents(ctx), {
    query: EventQueryParams,
  })

  .get('/memories/:instanceId', (ctx) => chronicleController.getMemories(ctx), {
    query: MemoryQueryParams,
  })

  .put('/memory/:memoryId', (ctx) => chronicleController.editMemory(ctx), {
    body: EditMemoryBody,
  })

  .delete('/memory/:memoryId', (ctx) => chronicleController.deleteMemory(ctx))

  .put('/event/:eventId', (ctx) => chronicleController.editEvent(ctx), {
    body: EditEventBody,
  })

  .post('/replay/:eventId', (ctx) => chronicleController.replayEvent(ctx))

  .post('/replay/select/:eventId', (ctx) => chronicleController.selectReplayVariant(ctx), {
    body: t.Object({ variant_index: t.Number({ minimum: 0 }) }),
  })

  .post('/rewind/:instanceId', (ctx) => chronicleController.rewind(ctx), {
    body: t.Object({ sequence: t.Number({ minimum: 1 }) }),
  })
