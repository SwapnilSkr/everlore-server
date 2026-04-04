import type { AuthUser } from '../middleware/auth'
import { memoryService } from '../services/memory.service'
import type { Static } from '@sinclair/typebox'
import type { EditEventBody } from '../schemas/event.schema'
import type { EditMemoryBody } from '../schemas/memory.schema'

type EditEvent = Static<typeof EditEventBody>
type EditMemory = Static<typeof EditMemoryBody>

export const chronicleController = {
  getEvents: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string }
    query: { page?: number; limit?: number; type?: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.getEvents(params.instanceId, user.id, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || 50,
      type: query.type,
    })
  },

  getMemories: async ({
    params,
    query,
    user,
  }: {
    params: { instanceId: string }
    query: { include_archived?: boolean }
    user: AuthUser | null
  }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.getMemories(params.instanceId, user.id, {
      includeArchived: query.include_archived === true,
    })
  },

  editMemory: async ({
    params,
    body,
    user,
  }: {
    params: { memoryId: string }
    body: EditMemory
    user: AuthUser | null
  }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.editMemory(params.memoryId, user.id, body)
  },

  deleteMemory: async ({ params, user }: { params: { memoryId: string }; user: AuthUser | null }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.deleteMemory(params.memoryId, user.id)
  },

  editEvent: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: EditEvent
    user: AuthUser | null
  }) => {
    if (!user) throw new Error('Unauthorized')
    return memoryService.editEvent(params.eventId, user.id, body)
  },
}
