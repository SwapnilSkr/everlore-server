import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc, WorldTemplateSummaryDoc } from '../models/world-template.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { getRedisClient } from '../config/redis'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { characterCodexService } from './character-codex.service'

const TIER_LIMITS: Record<string, { max_instances: number; max_memories: number }> = {
  free: { max_instances: 3, max_memories: 100 },
  premium: { max_instances: 20, max_memories: 500 },
  creator: { max_instances: 50, max_memories: 1000 },
}

const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const characters = () => mongoColl.characters()
const events = () => mongoColl.events()

export type InstanceListRow = WorldInstanceDoc & {
  template: WorldTemplateSummaryDoc | null
}

export const instanceService = {
  async create(
    playerId: string,
    templateId: string,
    tier: string,
  ): Promise<{ instance: WorldInstanceDoc; template: WorldTemplateDoc }> {
    const playerOid = parseObjectId(playerId)
    const templateOid = parseObjectId(templateId)

    const template = await worldTemplates().findOne({
      _id: templateOid,
      is_published: true,
    })
    if (!template) throw new HttpError(404, 'Template not found or not published')

    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free
    const instanceCount = await worldInstances().countDocuments({
      player_id: playerOid,
      'meta.is_archived': { $ne: true },
    })
    if (instanceCount >= limits.max_instances) {
      throw new HttpError(403, `Instance limit reached (${limits.max_instances})`)
    }

    const worldState: Record<string, number> = {}
    for (const [key, def] of Object.entries(template.base_stats_template || {})) {
      worldState[key] = def.default
    }

    const activeFlags: Record<string, unknown> = {}
    for (const [key, def] of Object.entries(template.flag_definitions || {})) {
      activeFlags[key] = def.default
    }

    const _id = new ObjectId()
    const instance: WorldInstanceDoc = {
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
      // Characters start in first person (intimate chat feel); Worlds start in
      // third person. Either way the player can toggle POV in chat.
      narration_pov: template.kind === 'character' ? 'first' : 'third',
      tone: '',
      focus_character_id: null,
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

    await worldInstances().insertOne(instance)

    // Deterministic protagonist: for sentient templates, seed the locked main
    // persona codex card from the template so it's present + correct from turn 0
    // (rather than waiting for emergent extraction to discover it).
    if (template.is_sentient && template.protagonist?.name) {
      await characterCodexService.seedProtagonist({
        instanceId: idString(_id),
        playerId,
        name: template.protagonist.name,
        persona: template.protagonist.persona,
        appearance: template.protagonist.appearance,
        isPlayer: false,
      })
    }

    // Opening line: if the template greets the player, seed it as the first event
    // so the chat opens with the character speaking instead of a blank screen.
    if (template.opening_line && template.opening_line.trim().length > 0) {
      const greeting = template.opening_line.trim()
      await events().insertOne({
        _id: new ObjectId(),
        instance_id: _id,
        player_id: playerOid,
        sequence: 1,
        type: 'narration',
        data: {
          player_input: '',
          ai_response: greeting,
          state_mutations: {},
          flag_mutations: {},
          model_used: 'seed',
          tokens_in: 0,
          tokens_out: 0,
        },
        is_user_edited: false,
        edit_history: [],
        scene_tag: 'dialogue',
        created_at: new Date(),
      } as unknown as WorldEventDoc)
    }

    return { instance, template }
  },

  async getById(instanceId: string, playerId: string) {
    return worldInstances().findOne({
      _id: parseObjectId(instanceId),
      player_id: parseObjectId(playerId),
    })
  },

  async list(playerId: string, includeArchived: boolean = false): Promise<InstanceListRow[]> {
    const playerOid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { player_id: playerOid }
    if (!includeArchived) {
      filter['meta.is_archived'] = { $ne: true }
    }

    const instances = await worldInstances()
      .find(filter)
      .sort({ 'meta.last_active_at': -1 })
      .toArray()

    const templateIds = [...new Set(instances.map((i) => i.template_id))]
    const templates = (await worldTemplates()
      .find({ _id: { $in: templateIds } })
      .project({ _id: 1, title: 1, is_sentient: 1, description: 1, kind: 1 })
      .toArray()) as WorldTemplateSummaryDoc[]

    const templateMap = new Map(templates.map((t) => [idString(t._id), t]))

    return instances.map((inst) => ({
      ...inst,
      template: templateMap.get(idString(inst.template_id)) || null,
    }))
  },

  async archive(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const result = await worldInstances().updateOne(
      { _id: iid, player_id: pid },
      { $set: { 'meta.is_archived': true, updated_at: new Date() } },
    )
    if (result.matchedCount === 0) throw new Error('Instance not found')

    const redis = getRedisClient()
    await redis.del(`session:${idString(iid)}`)

    return { success: true }
  },

  /**
   * GM onboarding: establish the player's own character as the locked protagonist
   * of this instance (first play). No-op if a protagonist already exists.
   */
  async setPlayerProtagonist(
    instanceId: string,
    playerId: string,
    data: { name: string; identity?: string },
  ) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const card = await characterCodexService.seedProtagonist({
      instanceId,
      playerId,
      name: data.name,
      persona: data.identity,
      isPlayer: true,
    })
    return {
      protagonist: card
        ? { id: idString(card._id), canonical_name: card.canonical_name }
        : null,
    }
  },

  async loadSession(instanceId: string, playerId: string) {
    const redis = getRedisClient()
    const iidStr = instanceId.trim()

    const cached = await redis.get(`session:${iidStr}`)
    if (cached) return JSON.parse(cached)

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
    if (!template) throw new Error('Template not found')

    const session = {
      world_state: instance.world_state,
      active_flags: instance.active_flags,
      current_scene: instance.current_scene,
      narration_pov: instance.narration_pov || 'third',
      tone: instance.tone || '',
      focus_character_id: instance.focus_character_id ? idString(instance.focus_character_id) : null,
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

  /**
   * Update in-chat session settings (narration POV, tone) for an instance and
   * bust the cached session so the next turn rebuilds with the new values.
   */
  async updateSettings(
    instanceId: string,
    playerId: string,
    settings: { narration_pov?: 'first' | 'third'; tone?: string; focus_character_id?: string | null },
  ): Promise<{ narration_pov: 'first' | 'third'; tone: string; focus_character_id: string | null }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (settings.narration_pov === 'first' || settings.narration_pov === 'third') {
      update.narration_pov = settings.narration_pov
    }
    if (typeof settings.tone === 'string') {
      update.tone = settings.tone.slice(0, 100)
    }
    if (settings.focus_character_id !== undefined) {
      if (settings.focus_character_id === null || settings.focus_character_id === '') {
        update.focus_character_id = null
      } else {
        const cid = parseObjectId(settings.focus_character_id)
        const exists = await characters().findOne({ _id: cid, instance_id: iid, player_id: pid })
        if (!exists) throw new HttpError(400, 'Invalid focus_character_id')
        update.focus_character_id = cid
      }
    }

    const result = await worldInstances().findOneAndUpdate(
      { _id: iid, player_id: pid },
      { $set: update },
      { returnDocument: 'after' },
    )
    if (!result) throw new HttpError(404, 'Instance not found')

    await getRedisClient().del(`session:${idString(iid)}`)
    return {
      narration_pov: result.narration_pov || 'third',
      tone: result.tone || '',
      focus_character_id: result.focus_character_id ? idString(result.focus_character_id) : null,
    }
  },
}
