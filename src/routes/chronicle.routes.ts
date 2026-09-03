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

  .get('/calendar/:instanceId', (ctx) => chronicleController.getCalendar(ctx))

  .get('/recap/:instanceId', (ctx) => chronicleController.getRecap(ctx))

  .get('/threads/:instanceId', (ctx) => chronicleController.getThreads(ctx))

  .get('/relationships/:instanceId', (ctx) => chronicleController.getRelationships(ctx))

  .get('/kinship/:instanceId', (ctx) => chronicleController.getConfirmedKinship(ctx))
  .post('/kinship/:instanceId', (ctx) => chronicleController.setKinship(ctx), {
    body: t.Object({ character: t.String({ minLength: 2, maxLength: 80 }), relation: t.String({ minLength: 2, maxLength: 40 }), correction: t.Optional(t.Boolean()), replaces_relation: t.Optional(t.String({ maxLength: 40 })) }),
  })

  .get('/relation-candidates/:instanceId', (ctx) => chronicleController.getRelationCandidates(ctx))

  .post('/relation-candidate/:candidateId/resolve', (ctx) => chronicleController.resolveRelationCandidate(ctx), {
    body: t.Object({
      action: t.Union([t.Literal('accept'), t.Literal('reject'), t.Literal('defer')]),
      relation: t.Optional(t.String({ maxLength: 40 })),
    }),
  })

  .get(
    '/relationships/:instanceId/:characterId/memories',
    (ctx) => chronicleController.getCharacterMemories(ctx),
  )

  .get('/locations/:instanceId', (ctx) => chronicleController.getLocations(ctx))

  .get(
    '/locations/:instanceId/:locationEntityId',
    (ctx) => chronicleController.getLocationJournal(ctx),
  )

  .post('/calendar/:instanceId/timeline', (ctx) => chronicleController.forkTimeline(ctx), {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 120 }),
      timeline_id: t.Optional(t.String({ maxLength: 80 })),
      parent_timeline_id: t.Optional(t.String({ maxLength: 80 })),
      make_active: t.Optional(t.Boolean()),
    }),
  })

  .put('/calendar/:instanceId/timeline/active', (ctx) => chronicleController.setActiveTimeline(ctx), {
    body: t.Object({
      timeline_id: t.String({ minLength: 1, maxLength: 80 }),
    }),
  })

  .put('/calendar/event/:eventId/time-anchor', (ctx) => chronicleController.updateEventTimeAnchor(ctx), {
    body: t.Object({
      story_calendar: t.Optional(t.Object({
        year: t.Optional(t.Number()),
        month: t.Optional(t.Number({ minimum: 1 })),
        day: t.Optional(t.Number({ minimum: 1 })),
        era: t.Optional(t.String({ maxLength: 80 })),
        label: t.Optional(t.String({ maxLength: 160 })),
      })),
      event_time_label: t.Optional(t.String({ maxLength: 160 })),
      timeline_id: t.Optional(t.String({ maxLength: 80 })),
    }),
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
      life_state: t.Optional(t.Union([t.Literal('alive'), t.Literal('deceased')])),
    }),
  })

  .post('/replay/:eventId', (ctx) => chronicleController.replayEvent(ctx))

  .post('/replay/select/:eventId', (ctx) => chronicleController.selectReplayVariant(ctx), {
    body: t.Object({ variant_index: t.Number({ minimum: 0 }) }),
  })

  .post('/rewind/:instanceId', (ctx) => chronicleController.rewind(ctx), {
    body: t.Object({ sequence: t.Number({ minimum: 1 }) }),
  })

  .post('/track/:instanceId', (ctx) => chronicleController.trackEntity(ctx), {
    body: t.Object({
      name: t.String({ minLength: 1, maxLength: 120 }),
      role: t.Optional(t.String({ maxLength: 200 })),
      appearance: t.Optional(t.String({ maxLength: 600 })),
      persona: t.Optional(t.String({ maxLength: 1000 })),
      relation_kind: t.Optional(
        t.String({
          enum: [
            'parent_of', 'child_of', 'sibling_of', 'partner_of', 'progenitor_of',
            'descendant_of', 'superior_of', 'subordinate_of', 'kin_of', 'bonded_of',
          ],
        }),
      ),
      relation_label: t.Optional(t.String({ maxLength: 60 })),
      relation_to: t.Optional(t.String({ maxLength: 120 })),
    }),
  })
