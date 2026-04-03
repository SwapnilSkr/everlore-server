import { Elysia } from 'elysia'
import { authPlugin } from '../middleware/auth'
import { memoryService } from '../services/memory.service'
import { EventQueryParams, EditEventBody } from '../schemas/event.schema'
import { MemoryQueryParams, EditMemoryBody } from '../schemas/memory.schema'

export const chronicleRoutes = new Elysia({ prefix: '/chronicle' })
  .use(authPlugin)

  // Get events for an instance
  .get('/events/:instanceId', async ({ params, query, user }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.getEvents(params.instanceId, user.id, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || 50,
      type: query.type,
    })
  }, { query: EventQueryParams })

  // Get memories for an instance
  .get('/memories/:instanceId', async ({ params, query, user }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.getMemories(params.instanceId, user.id, {
      includeArchived: query.include_archived === true,
    })
  }, { query: MemoryQueryParams })

  // Edit a memory
  .put('/memory/:memoryId', async ({ params, body, user }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.editMemory(params.memoryId, user.id, body)
  }, { body: EditMemoryBody })

  // Delete a memory
  .delete('/memory/:memoryId', async ({ params, user }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.deleteMemory(params.memoryId, user.id)
  })

  // Edit an event
  .put('/event/:eventId', async ({ params, body, user }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.editEvent(params.eventId, user.id, body)
  }, { body: EditEventBody })
