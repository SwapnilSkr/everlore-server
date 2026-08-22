import { mongoColl } from '../config/mongo'
import type { MemoryDoc } from '../models/memory.model'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { getGenerationQueue, QUEUE_RETENTION } from '../queues'
import { instanceService } from './instance.service'
import { parseObjectId } from '../utils/mongo-id'
import { EVENT_WINDOWS, buildEventWindow } from '../utils/event-window'
import type { PlayerWorldAction } from '../utils/world-action'
import { getRedisClient } from '../config/redis'
import { generationLockKey } from '../utils/generation-lock'

const users = () => mongoColl.users()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()

export const generationService = {
  async dispatch(params: {
    instanceId: string
    playerId: string
    userMessage: string
    isContinuation?: boolean
    /** 'hours' | 'day' | 'days' | 'season' — turns a continue into a calendar tick. */
    timeAdvance?: string
    /** A structured, player-confirmed action such as travel or a relationship fact. */
    worldAction?: PlayerWorldAction
    billingReservationId?: string | null
  }) {
    const { instanceId, playerId, userMessage, isContinuation = false, timeAdvance, worldAction, billingReservationId } = params
    const requestedAt = Date.now()
    const session = await instanceService.loadSession(instanceId, playerId)

    // Per-user NSFW consent is read fresh (not from the cached session) so a
    // user toggling the preference takes effect on their very next turn.
    const player = await users().findOne(
      { _id: parseObjectId(playerId) },
      { projection: { 'preferences.nsfw_enabled': 1 } },
    )
    const userNsfwEnabled = player?.preferences?.nsfw_enabled === true

    // Context assembly (recent turns, summary, retrieval, codex selection +
    // pinning) happens in the WORKER via the context-packet builder, AFTER
    // retrieval — so retrieved memories can shape which codex cards inject.
    // Dispatch stays thin: identity, session, consent, enqueue.
    const queue = getGenerationQueue()
    const job = await queue.add(
      'generate',
      {
        instanceId,
        playerId,
        userMessage,
        isContinuation,
        timeAdvance,
        worldAction,
        requestedAt,
        session,
        userNsfwEnabled,
        billingReservationId,
      },
      {
        priority: 1,
        // A turn is a visible interaction, not a background task. Retrying a
        // failed generation can replace the scene the player just started
        // reading, so a failed turn is surfaced as a failure and the player
        // decides whether to try again.
        attempts: 1,
        removeOnComplete: QUEUE_RETENTION.generation.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.generation.removeOnFail,
      },
    )

    return job.id
  },


  /** Enqueue a streaming replay (alternative response) for an existing event. */
  async dispatchReplay(params: { instanceId: string; playerId: string; eventId: string; billingReservationId?: string | null }) {
    const { instanceId, playerId, eventId, billingReservationId } = params
    const queue = getGenerationQueue()
    const job = await queue.add(
      'replay',
      { mode: 'replay', instanceId, playerId, eventId, billingReservationId },
      {
        priority: 1,
        attempts: 1,
        removeOnComplete: QUEUE_RETENTION.generation.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.generation.removeOnFail,
      },
    )
    return job.id
  },

  async loadInstance(
    instanceId: string,
    playerId: string,
  ): Promise<{
    instance: WorldInstanceDoc
    template: WorldTemplateDoc | null
    recentEvents: WorldEventDoc[]
    memories: MemoryDoc[]
    characters: CharacterProfileDoc[]
    operation: { kind: 'generation' | 'rewind' } | null
    eventWindow: {
      limit: number
      total: number
      hasOlder: boolean
    }
  }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new Error('Instance not found')

    const template = await worldTemplates().findOne({
      _id: instance.template_id,
    })

    const recentEvents = await events()
      .find({ instance_id: iid })
      .sort({ sequence: -1 })
      .limit(EVENT_WINDOWS.loadInstanceRecentEvents)
      .toArray()
    recentEvents.reverse()

    const mems = await memories()
      .find({ instance_id: iid, is_archived: false })
      .sort({ importance: -1 })
      .limit(20)
      .toArray()

    const codex = await characters()
      .find({ instance_id: iid })
      .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
      .limit(30)
      .toArray()

    const totalEvents =
      typeof instance.meta?.total_events === 'number'
        ? instance.meta.total_events
        : await events().countDocuments({ instance_id: iid })

    const activeLock = await getRedisClient()
      .get(generationLockKey(playerId, instanceId))
      .catch(() => null)

    return {
      instance,
      template,
      recentEvents,
      memories: mems,
      characters: codex,
      operation: activeLock
        ? { kind: activeLock.startsWith('rewind:') ? 'rewind' : 'generation' }
        : null,
      eventWindow: buildEventWindow(totalEvents, recentEvents.length),
    }
  },
}
