import { ObjectId } from 'mongodb'
import { coll } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'

const TIER_LIMITS: Record<string, { max_instances: number; max_memories: number }> = {
  free: { max_instances: 3, max_memories: 100 },
  premium: { max_instances: 20, max_memories: 500 },
  creator: { max_instances: 50, max_memories: 1000 },
}

export const instanceService = {
  async create(playerId: string, templateId: string, tier: string) {
    const playerOid = parseObjectId(playerId)
    const templateOid = parseObjectId(templateId)

    const template = await coll('world_templates').findOne({
      _id: templateOid,
      is_published: true,
    })
    if (!template) throw new HttpError(404, 'Template not found or not published')

    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free
    const instanceCount = await coll('world_instances').countDocuments({
      player_id: playerOid,
      'meta.is_archived': { $ne: true },
    })
    if (instanceCount >= limits.max_instances) {
      throw new HttpError(403, `Instance limit reached (${limits.max_instances})`)
    }

    const worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template as Record<string, any>)) {
      worldState[key] = def.default
    }

    const activeFlags: Record<string, any> = {}
    for (const [key, def] of Object.entries((template.flag_definitions || {}) as Record<string, any>)) {
      activeFlags[key] = def.default
    }

    const _id = new ObjectId()
    const instance = {
      _id,
      template_id: templateOid,
      template_version: template.version,
      player_id: playerOid,
      world_state: worldState,
      active_flags: activeFlags,
      current_scene: {
        tag: 'dialogue',
        turn_count: 0,
        summary_pending: false,
      },
      meta: {
        total_events: 0,
        total_memories: 0,
        total_tokens_consumed: 0,
        last_active_at: new Date(),
        is_archived: false,
      },
      created_at: new Date(),
      updated_at: new Date(),
    }

    await coll('world_instances').insertOne(instance)
    return { instance, template }
  },

  async getById(instanceId: string, playerId: string) {
    return coll('world_instances').findOne({
      _id: parseObjectId(instanceId),
      player_id: parseObjectId(playerId),
    })
  },

  async list(playerId: string, includeArchived: boolean = false) {
    const playerOid = parseObjectId(playerId)
    const filter: any = { player_id: playerOid }
    if (!includeArchived) {
      filter['meta.is_archived'] = { $ne: true }
    }

    const instances = await coll('world_instances')
      .find(filter)
      .sort({ 'meta.last_active_at': -1 })
      .toArray()

    const templateIds = [...new Set(instances.map((i) => i.template_id))]
    const templates = await coll('world_templates')
      .find({ _id: { $in: templateIds } })
      .project({ _id: 1, title: 1, is_sentient: 1, description: 1 })
      .toArray()
    const templateMap = new Map(templates.map((t) => [idString(t._id), t]))

    return instances.map((inst) => ({
      ...inst,
      template: templateMap.get(idString(inst.template_id)) || null,
    }))
  },

  async archive(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const result = await coll('world_instances').updateOne(
      { _id: iid, player_id: pid },
      { $set: { 'meta.is_archived': true, updated_at: new Date() } },
    )
    if (result.matchedCount === 0) throw new Error('Instance not found')

    const redis = getRedisClient()
    await redis.del(`session:${idString(iid)}`)

    return { success: true }
  },

  async loadSession(instanceId: string, playerId: string) {
    const redis = getRedisClient()
    const iidStr = instanceId.trim()

    const cached = await redis.get(`session:${iidStr}`)
    if (cached) return JSON.parse(cached)

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
    if (!template) throw new Error('Template not found')

    const session = {
      world_state: instance.world_state,
      active_flags: instance.active_flags,
      current_scene: instance.current_scene,
      seed_prompt: template.seed_prompt,
      global_lore: template.global_lore,
      is_sentient: template.is_sentient,
      is_nsfw_capable: template.is_nsfw_capable,
      model_preferences: template.model_preferences,
      max_context_memories: template.max_context_memories,
      max_lore_results: template.max_lore_results,
      template_id: idString(template._id),
    }

    await redis.set(`session:${iidStr}`, JSON.stringify(session), 'EX', 3600)
    return session
  },
}
