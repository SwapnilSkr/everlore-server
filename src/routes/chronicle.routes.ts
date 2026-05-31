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

  .put('/character/:characterId', (ctx) => chronicleController.editCharacter(ctx), {
    body: t.Object({
      canonical_name: t.Optional(t.String({ maxLength: 120 })),
      role: t.Optional(t.String({ maxLength: 200 })),
      appearance: t.Optional(t.String({ maxLength: 600 })),
      persona: t.Optional(t.String({ maxLength: 1000 })),
      immutable_facts: t.Optional(t.Array(t.String({ maxLength: 400 }))),
      mutable_state: t.Optional(t.Array(t.String({ maxLength: 400 }))),
      disposition_to_player: t.Optional(t.String({ maxLength: 400 })),
      hidden_thought: t.Optional(t.String({ maxLength: 400 })),
    }),
  })

  .post('/replay/:eventId', (ctx) => chronicleController.replayEvent(ctx))

  .post('/replay/select/:eventId', (ctx) => chronicleController.selectReplayVariant(ctx), {
    body: t.Object({ variant_index: t.Number({ minimum: 0 }) }),
  })

  .post('/rewind/:instanceId', (ctx) => chronicleController.rewind(ctx), {
    body: t.Object({ sequence: t.Number({ minimum: 1 }) }),
  })
