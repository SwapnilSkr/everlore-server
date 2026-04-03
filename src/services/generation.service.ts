import { getRedisClient } from '../config/redis'
import { coll } from '../config/mongo'
import { getGenerationQueue } from '../queues'
import { instanceService } from './instance.service'

export const generationService = {
  async dispatch(params: {
    instanceId: string
    playerId: string
    userMessage: string
  }) {
    const { instanceId, playerId, userMessage } = params
    // Load session (from Redis cache or MongoDB)
    const session = await instanceService.loadSession(instanceId, playerId)

    // Fetch recent events for immediate context (last 6 turns)
    const recentEvents = await coll('events')
      .find({ instance_id: instanceId })
      .sort({ sequence: -1 })
      .limit(6)
      .toArray()
    recentEvents.reverse()

    // Fetch active scene summary
    const activeSummary = await coll('scene_summaries').findOne(
      {
        instance_id: instanceId,
        'event_range.end_sequence': {
          $lt: recentEvents[0]?.sequence || 0,
        },
      },
      { sort: { 'event_range.end_sequence': -1 } },
    )

    // Enqueue the generation job
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
    const instance = await coll('world_instances').findOne({
      _id: instanceId,
      player_id: playerId,
    })
    if (!instance) throw new Error('Instance not found')

    const template = await coll('world_templates').findOne({
      _id: instance.template_id,
    })

    const recentEvents = await coll('events')
      .find({ instance_id: instanceId })
      .sort({ sequence: -1 })
      .limit(20)
      .toArray()
    recentEvents.reverse()

    const memories = await coll('memories')
      .find({ instance_id: instanceId, is_archived: false })
      .sort({ importance: -1 })
      .limit(20)
      .toArray()

    return { instance, template, recentEvents, memories }
  },
}
