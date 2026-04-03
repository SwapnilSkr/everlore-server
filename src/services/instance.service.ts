import { getDb } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { generateId } from '../utils/id'

const TIER_LIMITS: Record<string, { max_instances: number; max_memories: number }> = {
  free: { max_instances: 3, max_memories: 100 },
  premium: { max_instances: 20, max_memories: 500 },
  creator: { max_instances: 50, max_memories: 1000 },
}

export const instanceService = {
  async create(playerId: string, templateId: string, tier: string) {
    const db = getDb()

    // Check template exists and is published
    const template = await db.collection('world_templates').findOne({
      _id: templateId,
      is_published: true,
    })
    if (!template) throw new Error('Template not found or not published')

    // Check instance limit
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free
    const instanceCount = await db.collection('world_instances').countDocuments({
      player_id: playerId,
      'meta.is_archived': { $ne: true },
    })
    if (instanceCount >= limits.max_instances) {
      throw new Error(`Instance limit reached (${limits.max_instances})`)
    }

    // Initialize world_state from template defaults
    const worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template as Record<string, any>)) {
      worldState[key] = def.default
    }

    // Initialize flags from template defaults
    const activeFlags: Record<string, any> = {}
    for (const [key, def] of Object.entries((template.flag_definitions || {}) as Record<string, any>)) {
      activeFlags[key] = def.default
    }

    const id = generateId('inst')
    const instance = {
      _id: id,
      template_id: templateId,
      template_version: template.version,
      player_id: playerId,
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

    await db.collection('world_instances').insertOne(instance)
    return { instance, template }
  },

  async getById(instanceId: string, playerId: string) {
    const db = getDb()
    return db.collection('world_instances').findOne({
      _id: instanceId,
      player_id: playerId,
    })
  },

  async list(playerId: string, includeArchived: boolean = false) {
    const db = getDb()
    const filter: any = { player_id: playerId }
    if (!includeArchived) {
      filter['meta.is_archived'] = { $ne: true }
    }

    const instances = await db
      .collection('world_instances')
      .find(filter)
      .sort({ 'meta.last_active_at': -1 })
      .toArray()

    // Enrich with template titles
    const templateIds = [...new Set(instances.map((i) => i.template_id))]
    const templates = await db
      .collection('world_templates')
      .find({ _id: { $in: templateIds } })
      .project({ _id: 1, title: 1, is_sentient: 1, description: 1 })
      .toArray()
    const templateMap = new Map(templates.map((t) => [t._id, t]))

    return instances.map((inst) => ({
      ...inst,
      template: templateMap.get(inst.template_id) || null,
    }))
  },

  async archive(instanceId: string, playerId: string) {
    const db = getDb()
    const result = await db.collection('world_instances').updateOne(
      { _id: instanceId, player_id: playerId },
      { $set: { 'meta.is_archived': true, updated_at: new Date() } },
    )
    if (result.matchedCount === 0) throw new Error('Instance not found')

    // Clear Redis session
    const redis = getRedisClient()
    await redis.del(`session:${instanceId}`)

    return { success: true }
  },

  async loadSession(instanceId: string, playerId: string) {
    const redis = getRedisClient()
    const db = getDb()

    // Try Redis first
    const cached = await redis.get(`session:${instanceId}`)
    if (cached) return JSON.parse(cached)

    // Load from Mongo
    const instance = await db.collection('world_instances').findOne({
      _id: instanceId,
      player_id: playerId,
    })
    if (!instance) throw new Error('Instance not found')

    const template = await db.collection('world_templates').findOne({
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
      template_id: template._id,
    }

    await redis.set(`session:${instanceId}`, JSON.stringify(session), 'EX', 3600)
    return session
  },
}
