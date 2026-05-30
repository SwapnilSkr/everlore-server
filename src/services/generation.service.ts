import { mongoColl } from '../config/mongo'
import type { MemoryDoc } from '../models/memory.model'
import type { WorldEventDoc } from '../models/world-event.model'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc } from '../models/world-template.model'
import { getGenerationQueue } from '../queues'
import { instanceService } from './instance.service'
import { parseObjectId } from '../utils/mongo-id'

const users = () => mongoColl.users()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const events = () => mongoColl.events()
const sceneSummaries = () => mongoColl.sceneSummaries()
const memories = () => mongoColl.memories()

export const generationService = {
  async dispatch(params: {
    instanceId: string
    playerId: string
    userMessage: string
  }) {
    const { instanceId, playerId, userMessage } = params
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
      .limit(6)
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
    const job = await queue.add(
      'generate',
      {
        instanceId,
        playerId,
        userMessage,
        session,
        userNsfwEnabled,
        recentEvents,
        activeSummary: activeSummary?.summary_text || null,
      },
      {
        priority: 1,
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
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
      .limit(20)
      .toArray()
    recentEvents.reverse()

    const mems = await memories()
      .find({ instance_id: iid, is_archived: false })
      .sort({ importance: -1 })
      .limit(20)
      .toArray()

    return { instance, template, recentEvents, memories: mems }
  },
}
