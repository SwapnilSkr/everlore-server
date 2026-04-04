import { coll } from '../config/mongo'
import { getGenerationQueue } from '../queues'
import { instanceService } from './instance.service'
import { parseObjectId } from '../utils/mongo-id'

export const generationService = {
  async dispatch(params: {
    instanceId: string
    playerId: string
    userMessage: string
  }) {
    const { instanceId, playerId, userMessage } = params
    const session = await instanceService.loadSession(instanceId, playerId)

    const iid = parseObjectId(instanceId)

    const recentEvents = await coll('events')
      .find({ instance_id: iid })
      .sort({ sequence: -1 })
      .limit(6)
      .toArray()
    recentEvents.reverse()

    const activeSummary = await coll('scene_summaries').findOne(
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

  async loadInstance(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const instance = await coll('world_instances').findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new Error('Instance not found')

    const template = await coll('world_templates').findOne({
      _id: instance.template_id,
    })

    const recentEvents = await coll('events')
      .find({ instance_id: iid })
      .sort({ sequence: -1 })
      .limit(20)
      .toArray()
    recentEvents.reverse()

    const memories = await coll('memories')
      .find({ instance_id: iid, is_archived: false })
      .sort({ importance: -1 })
      .limit(20)
      .toArray()

    return { instance, template, recentEvents, memories }
  },
}
