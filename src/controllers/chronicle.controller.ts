import type { AuthUser } from '../middleware/auth'
import { memoryService } from '../services/memory.service'
import { characterCodexService } from '../services/character-codex.service'
import { memorySupersessionService } from '../services/memory-supersession.service'
import { timeService } from '../services/time.service'
import { locationService } from '../services/location.service'
import type { Static } from '@sinclair/typebox'
import type { EditEventBody } from '../schemas/event.schema'
import type { EditMemoryBody } from '../schemas/memory.schema'
import { idString } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { EVENT_WINDOWS } from '../utils/event-window'

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
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.getEvents(params.instanceId, user.id, {
      page: Number(query.page) || 1,
      limit: Number(query.limit) || EVENT_WINDOWS.chroniclePageSize,
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
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.getMemories(params.instanceId, user.id, {
      includeArchived: query.include_archived === true,
    })
  },

  getCalendar: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.listCalendar(params.instanceId, user.id)
  },

  getRelationships: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return characterCodexService.listRelationships(params.instanceId, user.id)
  },

  getCharacterMemories: async ({
    params,
    user,
  }: {
    params: { instanceId: string; characterId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return characterCodexService.characterMemories(
      params.instanceId,
      user.id,
      params.characterId,
    )
  },

  getLocations: async ({
    params,
    user,
  }: {
    params: { instanceId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return locationService.listLocations(params.instanceId, user.id)
  },

  getLocationJournal: async ({
    params,
    user,
  }: {
    params: { instanceId: string; locationEntityId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return locationService.getLocationJournal(
      params.instanceId,
      user.id,
      params.locationEntityId,
    )
  },

  forkTimeline: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { name: string; timeline_id?: string; parent_timeline_id?: string; make_active?: boolean }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.forkTimeline({
      instanceId: params.instanceId,
      playerId: user.id,
      name: body.name,
      timelineId: body.timeline_id,
      parentTimelineId: body.parent_timeline_id,
      makeActive: body.make_active,
    })
  },

  setActiveTimeline: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { timeline_id: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.setActiveTimeline(params.instanceId, user.id, body.timeline_id)
  },

  updateEventTimeAnchor: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: {
      story_calendar?: { year?: number; month?: number; day?: number; era?: string; label?: string }
      event_time_label?: string
      timeline_id?: string
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return timeService.updateEventTimeAnchor({
      eventId: params.eventId,
      playerId: user.id,
      storyCalendar: body.story_calendar,
      eventTimeLabel: body.event_time_label,
      timelineId: body.timeline_id,
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
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.editMemory(params.memoryId, user.id, body)
  },

  deleteMemory: async ({ params, user }: { params: { memoryId: string }; user: AuthUser | null }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
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
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.editEvent(params.eventId, user.id, body)
  },

  editCharacter: async ({
    params,
    body,
    user,
  }: {
    params: { characterId: string }
    body: {
      canonical_name?: string
      role?: string
      appearance?: string
      persona?: string
      immutable_facts?: string[]
      mutable_state?: string[]
      disposition_to_player?: string
      hidden_thought?: string
    }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    const result = await characterCodexService.editCharacter({
      playerId: user.id,
      characterId: params.characterId,
      updates: body,
    })
    // Facts this edit removed → evict matching memory vectors so RAG can't
    // resurface them and contradict the player's edit.
    if (result.retiredFacts.length > 0) {
      memorySupersessionService
        .supersedeMemories({ instanceId: result.instanceId, retiredFacts: result.retiredFacts })
        .catch(() => {})
    }
    const c = result.character
    return {
      character: {
        id: idString(c._id),
        canonical_name: c.canonical_name,
        aliases: c.aliases,
        role: c.role,
        appearance: c.appearance,
        persona: c.persona,
        immutable_facts: c.immutable_facts,
        mutable_state: c.mutable_state,
        disposition_to_player: c.disposition_to_player,
        hidden_thought: c.hidden_thought,
        mention_count: c.mention_count,
        is_protagonist: c.is_protagonist === true,
      },
    }
  },

  rewind: async ({
    params,
    body,
    user,
  }: {
    params: { instanceId: string }
    body: { sequence: number }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.rewindToSequence(params.instanceId, user.id, body.sequence)
  },

  replayEvent: async ({
    params,
    user,
  }: {
    params: { eventId: string }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.replayEvent(params.eventId, user.id)
  },

  selectReplayVariant: async ({
    params,
    body,
    user,
  }: {
    params: { eventId: string }
    body: { variant_index: number }
    user: AuthUser | null
  }) => {
    if (!user) throw new HttpError(401, 'Unauthorized')
    return memoryService.selectReplayVariant(params.eventId, user.id, Number(body.variant_index))
  },
}
