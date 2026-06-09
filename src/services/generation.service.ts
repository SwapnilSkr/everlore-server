import { mongoColl } from '../config/mongo'
import type { MemoryDoc } from '../models/memory.model'
import type { CharacterProfileDoc } from '../models/character-profile.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { getGenerationQueue, QUEUE_RETENTION } from '../queues'
import { instanceService } from './instance.service'
import { rankCodexForInjection } from './character-codex.service'
import { parseObjectId } from '../utils/mongo-id'
import { EVENT_WINDOWS, buildEventWindow } from '../utils/event-window'

const users = () => mongoColl.users()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const events = () => mongoColl.events()
const sceneSummaries = () => mongoColl.sceneSummaries()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()

export const generationService = {
  async dispatch(params: {
    instanceId: string
    playerId: string
    userMessage: string
    isContinuation?: boolean
  }) {
    const { instanceId, playerId, userMessage, isContinuation = false } = params
    const session = await instanceService.loadSession(instanceId, playerId)

    // Per-user NSFW consent is read fresh (not from the cached session) so a
    // user toggling the preference takes effect on their very next turn.
    const player = await users().findOne(
      { _id: parseObjectId(playerId) },
      { projection: { 'preferences.nsfw_enabled': 1 } },
    )
    const userNsfwEnabled = player?.preferences?.nsfw_enabled === true

    const iid = parseObjectId(instanceId)

    const recentEvents = await events()
      .find({ instance_id: iid })
      .sort({ sequence: -1 })
      .limit(EVENT_WINDOWS.promptRecentEvents)
      .toArray()
    recentEvents.reverse()

    const activeSummary = await sceneSummaries().findOne(
      {
        instance_id: iid,
        'event_range.end_sequence': {
          $lt: recentEvents[0]?.sequence || 0,
        },
      },
      { sort: { 'event_range.end_sequence': -1 } },
    )

    const queue = getGenerationQueue()
    // Pull a candidate pool, then rank by recency-weighted importance so the
    // injected top-16 tracks the CURRENT cast (dormant characters decay out)
    // rather than lifetime mention frequency.
    const codexPool = await characters()
      .find({ instance_id: iid })
      .sort({ is_protagonist: -1, mention_count: -1, updated_at: -1 })
      .limit(40)
      .toArray()
    const currentSequence = recentEvents.length
      ? recentEvents[recentEvents.length - 1].sequence
      : 0
    const characterCodex = rankCodexForInjection(codexPool, currentSequence, 16)
    const protagonistName = session.protagonist?.name
    if (
      session.is_sentient &&
      protagonistName &&
      !characterCodex.some((c: any) => c.is_protagonist || c.canonical_name === protagonistName)
    ) {
      characterCodex.unshift({
        canonical_name: protagonistName,
        persona: session.protagonist?.persona,
        appearance: session.protagonist?.appearance,
        immutable_facts: [],
        mutable_state: [],
        mention_count: 0,
        last_seen_sequence: currentSequence,
        is_protagonist: true,
      } as any)
    }

    const job = await queue.add(
      'generate',
      {
        instanceId,
        playerId,
        userMessage,
        isContinuation,
        session,
        userNsfwEnabled,
        recentEvents,
        activeSummary: activeSummary?.summary_text || null,
        characterCodex,
      },
      {
        priority: 1,
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: QUEUE_RETENTION.generation.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.generation.removeOnFail,
      },
    )

    return job.id
  },

  /** Enqueue a streaming replay (alternative response) for an existing event. */
  async dispatchReplay(params: { instanceId: string; playerId: string; eventId: string }) {
    const { instanceId, playerId, eventId } = params
    const queue = getGenerationQueue()
    const job = await queue.add(
      'replay',
      { mode: 'replay', instanceId, playerId, eventId },
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

    return {
      instance,
      template,
      recentEvents,
      memories: mems,
      characters: codex,
      eventWindow: buildEventWindow(totalEvents, recentEvents.length),
    }
  },
}
