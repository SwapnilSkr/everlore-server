import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc, WorldTemplateSummaryDoc } from '../models/world-template.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { getRedisClient } from '../config/redis'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { characterCodexService } from './character-codex.service'
import { kinshipGraphService } from './kinship-graph.service'
import { personaService } from './persona.service'
import { timeService } from './time.service'
import { isValidMessageLength, isValidStyleKey } from '../utils/narrative-styles'
import { isValidModeKey, DEFAULT_CHAT_MODE } from '../utils/chat-modes'
import { DEFAULT_NARRATION_TONE, isValidNarrationTone } from '../utils/narration-tones'

const TIER_LIMITS: Record<string, { max_instances: number; max_memories: number }> = {
  free: { max_instances: 3, max_memories: 100 },
  premium: { max_instances: 20, max_memories: 500 },
  creator: { max_instances: 50, max_memories: 1000 },
}

const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const characters = () => mongoColl.characters()
const personas = () => mongoColl.personas()
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

    // Look the template up by id alone so we can distinguish "doesn't exist"
    // from "exists but not published" — the latter was an opaque 404 footgun.
    const template = await worldTemplates().findOne({ _id: templateOid })
    if (!template) throw new HttpError(404, 'Template not found')
    if (!template.is_published) {
      // A creator can start a playthrough on their OWN unpublished world to
      // playtest it before publishing; anyone else gets a clear reason.
      if (idString(template.creator_id) !== playerId) {
        throw new HttpError(403, 'This world has not been published yet')
      }
    }

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
    const initialTimeAnchor = await timeService.initialAnchor({
      instanceId: idString(_id),
      templateId,
      sequence: 0,
    })
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
      // Chat mode, prose tone, and length are player-chosen. The template voice
      // still supplies genre/world texture; tone only controls how it is phrased.
      mode: DEFAULT_CHAT_MODE,
      message_length: 'medium',
      narrative_style_override: null,
      narration_tone: DEFAULT_NARRATION_TONE,
      focus_character_id: null,
      current_location: null,
      current_time_anchor: initialTimeAnchor,
      active_timeline_id: initialTimeAnchor.timeline_id,
      default_calendar_id: initialTimeAnchor.story_calendar?.calendar_id,
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
      // Step 0 — seed the authored premise family as system_seed kinship (one-time,
      // off any turn). Best-effort: a failure must never block instance creation.
      await kinshipGraphService.seedPremiseKinship({ instanceId: idString(_id), playerId }).catch(() => undefined)
    }

    // Opening line: if the template greets the player, seed it as the first event
    // so the chat opens with the character speaking instead of a blank screen.
    if (template.opening_line && template.opening_line.trim().length > 0) {
      const greeting = template.opening_line.trim()
      const openingTimeAnchor = await timeService.anchorForNextEvent({
        instanceId: idString(_id),
        templateId,
        previous: initialTimeAnchor,
        sequence: 1,
        eventTimeLabel: 'Opening scene',
      })
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
        time_anchor: openingTimeAnchor,
        created_at: new Date(),
      } as unknown as WorldEventDoc)
      await worldInstances().updateOne(
        { _id },
        {
          $set: {
            current_time_anchor: openingTimeAnchor,
            active_timeline_id: openingTimeAnchor.timeline_id,
            default_calendar_id: openingTimeAnchor.story_calendar?.calendar_id,
            'meta.total_events': 1,
          },
        },
      )
      instance.current_time_anchor = openingTimeAnchor
      instance.active_timeline_id = openingTimeAnchor.timeline_id
      instance.default_calendar_id = openingTimeAnchor.story_calendar?.calendar_id
      instance.meta.total_events = 1
    }

    return { instance, template }
  },

  async getById(instanceId: string, playerId: string) {
    return worldInstances().findOne({
      _id: parseObjectId(instanceId),
      player_id: parseObjectId(playerId),
    })
  },

  /**
   * Fast check: has this player entered this world before? Used before opening
   * a template so the client can offer "continue" vs "begin anew" without
   * loading the full instance list.
   */
  async getPlayStatus(
    playerId: string,
    templateId: string,
  ): Promise<{
    has_played: boolean
    count: number
    latest_instance_id: string | null
    stories: Array<{ id: string; last_active_at: Date; total_events: number }>
  }> {
    const playerOid = parseObjectId(playerId)
    const templateOid = parseObjectId(templateId)

    const rows = await worldInstances()
      .find({
        player_id: playerOid,
        template_id: templateOid,
        'meta.is_archived': { $ne: true },
      })
      .project({
        _id: 1,
        'meta.last_active_at': 1,
        'meta.total_events': 1,
      })
      .sort({ 'meta.last_active_at': -1 })
      .limit(25)
      .toArray()

    return {
      has_played: rows.length > 0,
      count: rows.length,
      latest_instance_id: rows.length > 0 ? idString(rows[0]._id) : null,
      stories: rows.map((r) => ({
        id: idString(r._id),
        last_active_at: r.meta.last_active_at,
        total_events: r.meta.total_events,
      })),
    }
  },

  /**
   * All active playthroughs for one world, with a one-line story preview from
   * the latest turn. Used on "Your Realms" when a world has multiple stories.
   */
  async listByTemplate(
    playerId: string,
    templateId: string,
  ): Promise<{
    template: WorldTemplateSummaryDoc | null
    stories: Array<
      InstanceListRow & {
        preview: string
        story_index: number
      }
    >
  }> {
    const playerOid = parseObjectId(playerId)
    const templateOid = parseObjectId(templateId)

    const instances = (await worldInstances()
      .find({
        player_id: playerOid,
        template_id: templateOid,
        'meta.is_archived': { $ne: true },
      })
      .sort({ 'meta.last_active_at': -1 })
      .toArray()) as WorldInstanceDoc[]

    if (instances.length === 0) {
      const template = (await worldTemplates()
        .find({ _id: templateOid })
        .project({
          _id: 1,
          title: 1,
          is_sentient: 1,
          description: 1,
          kind: 1,
          image_url: 1,
        })
        .limit(1)
        .toArray()) as WorldTemplateSummaryDoc[]
      return { template: template[0] || null, stories: [] }
    }

    const instanceIds = instances.map((i) => i._id)
    const previewRows = await events()
      .aggregate<{
        _id: ObjectId
        preview: string
      }>([
        {
          $match: {
            instance_id: { $in: instanceIds },
            player_id: playerOid,
            type: { $ne: 'side_chat' },
          },
        },
        { $sort: { sequence: -1 } },
        {
          $group: {
            _id: '$instance_id',
            player_input: { $first: '$data.player_input' },
            ai_response: { $first: '$data.ai_response' },
          },
        },
        {
          $project: {
            preview: {
              $let: {
                vars: {
                  pi: { $ifNull: ['$player_input', ''] },
                  ar: { $ifNull: ['$ai_response', ''] },
                },
                in: {
                  $cond: [{ $gt: [{ $strLenCP: '$$pi' }, 0] }, '$$pi', '$$ar'],
                },
              },
            },
          },
        },
      ])
      .toArray()

    const previewMap = new Map(previewRows.map((r) => [idString(r._id), (r.preview || '').trim()]))

    const templateRows = (await worldTemplates()
      .find({ _id: templateOid })
      .project({
        _id: 1,
        title: 1,
        is_sentient: 1,
        description: 1,
        kind: 1,
        image_url: 1,
      })
      .limit(1)
      .toArray()) as WorldTemplateSummaryDoc[]
    const template = templateRows[0] || null

    const templateMap = template ? new Map([[idString(template._id), template]]) : new Map()

    const stories = instances.map((inst, idx) => {
      const tid = idString(inst.template_id)
      const summary = templateMap.get(tid) || null
      const raw = previewMap.get(idString(inst._id)) || ''
      const preview = raw.length > 160 ? `${raw.slice(0, 157)}…` : raw
      return {
        ...inst,
        template: summary,
        preview,
        story_index: instances.length - idx,
      }
    })

    return { template, stories }
  },

  async list(playerId: string, includeArchived: boolean = false): Promise<InstanceListRow[]> {
    const playerOid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { player_id: playerOid }
    if (!includeArchived) {
      filter['meta.is_archived'] = { $ne: true }
    }

    const instances = await worldInstances().find(filter).sort({ 'meta.last_active_at': -1 }).toArray()

    const templateIds = [...new Set(instances.map((i) => i.template_id))]
    const templates = (await worldTemplates()
      .find({ _id: { $in: templateIds } })
      .project({
        _id: 1,
        title: 1,
        is_sentient: 1,
        description: 1,
        kind: 1,
        image_url: 1,
      })
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
  async setPlayerProtagonist(instanceId: string, playerId: string, data: { name: string; identity?: string }) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const card = await characterCodexService.seedProtagonist({
      instanceId,
      playerId,
      name: data.name,
      persona: data.identity,
      isPlayer: true,
    })
    // Step 0 — GM worlds seed kinship at onboarding (the protagonist now exists):
    // the world premise + the player's authored persona ("my late sister"), anchored
    // to the player. One-time, off any turn; best-effort.
    await kinshipGraphService.seedPremiseKinship({ instanceId, playerId }).catch(() => undefined)
    return {
      protagonist: card ? { id: idString(card._id), canonical_name: card.canonical_name } : null,
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
      // Mode, voice, prose tone, and length are player-selected per instance.
      // A null voice override inherits the template's authored default.
      mode: instance.mode || DEFAULT_CHAT_MODE,
      message_length: instance.message_length || 'medium',
      narrative_style_override: instance.narrative_style_override ?? null,
      narration_tone: instance.narration_tone || DEFAULT_NARRATION_TONE,
      narrative_style:
        instance.narrative_style_override === null || instance.narrative_style_override === undefined
          ? template.narrative_style || ''
          : instance.narrative_style_override,
      // Creator notes tune the creator's voice. A deliberate player voice
      // override must not inherit an incompatible "follow exactly" voice rule.
      style_notes:
        instance.narrative_style_override === null || instance.narrative_style_override === undefined
          ? template.style_notes || ''
          : '',
      focus_character_id: instance.focus_character_id ? idString(instance.focus_character_id) : null,
      persona_id: instance.persona_id ? idString(instance.persona_id) : null,
      persona_snapshot: instance.persona_snapshot || null,
      current_time_anchor: instance.current_time_anchor || null,
      active_timeline_id: instance.active_timeline_id || 'main',
      default_calendar_id: instance.default_calendar_id ? idString(instance.default_calendar_id) : null,
      current_location: instance.current_location
        ? {
            ...instance.current_location,
            entity_id: idString(instance.current_location.entity_id),
          }
        : null,
      seed_prompt: template.seed_prompt,
      global_lore: template.global_lore,
      is_sentient: template.is_sentient,
      protagonist: template.protagonist?.name
        ? {
            name: template.protagonist.name,
            persona: template.protagonist.persona,
            appearance: template.protagonist.appearance,
          }
        : null,
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
   * Update in-chat session settings (narration POV, mode, voice, prose tone, reply
   * length, focus) for an instance and bust the cached session. The tone applies
   * from the next generated turn; it does not rewrite existing narration.
   */
  async updateSettings(
    instanceId: string,
    playerId: string,
    settings: {
      narration_pov?: 'first' | 'third'
      mode?: string
      message_length?: 'short' | 'medium' | 'long'
      narrative_style_override?: string | null
      narration_tone?: string
      focus_character_id?: string | null
      persona_id?: string | null
    },
  ): Promise<{
    narration_pov: 'first' | 'third'
    mode: string
    message_length: 'short' | 'medium' | 'long'
    narrative_style_override: string | null
    narration_tone: string
    focus_character_id: string | null
    persona_id: string | null
  }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (settings.narration_pov === 'first' || settings.narration_pov === 'third') {
      update.narration_pov = settings.narration_pov
    }
    if (typeof settings.mode === 'string') {
      if (!isValidModeKey(settings.mode)) {
        throw new HttpError(400, 'Invalid mode')
      }
      update.mode = settings.mode
    }
    if (typeof settings.message_length === 'string') {
      if (!isValidMessageLength(settings.message_length)) {
        throw new HttpError(400, 'Invalid message_length')
      }
      update.message_length = settings.message_length
    }
    if (settings.narrative_style_override !== undefined) {
      if (
        settings.narrative_style_override !== null &&
        !isValidStyleKey(settings.narrative_style_override)
      ) {
        throw new HttpError(400, 'Invalid narrative_style_override')
      }
      update.narrative_style_override = settings.narrative_style_override
    }
    if (typeof settings.narration_tone === 'string') {
      if (!isValidNarrationTone(settings.narration_tone)) {
        throw new HttpError(400, 'Invalid narration_tone')
      }
      update.narration_tone = settings.narration_tone
    }
    if (settings.focus_character_id !== undefined) {
      if (settings.focus_character_id === null || settings.focus_character_id === '') {
        update.focus_character_id = null
      } else {
        const cid = parseObjectId(settings.focus_character_id)
        const exists = await characters().findOne({
          _id: cid,
          instance_id: iid,
          player_id: pid,
        })
        if (!exists) throw new HttpError(400, 'Invalid focus_character_id')
        update.focus_character_id = cid
      }
    }
    let selectedPersona: any | null = null
    if (settings.persona_id !== undefined) {
      if (settings.persona_id === null || settings.persona_id === '') {
        update.persona_id = null
        update.persona_snapshot = null
      } else {
        const personaOid = parseObjectId(settings.persona_id)
        selectedPersona = await personas().findOne({
          _id: personaOid,
          player_id: pid,
        })
        if (!selectedPersona) throw new HttpError(400, 'Invalid persona_id')
        update.persona_id = personaOid
        update.persona_snapshot = personaService.snapshotFromPersona(selectedPersona)
      }
    }

    const result = await worldInstances().findOneAndUpdate(
      { _id: iid, player_id: pid },
      { $set: update },
      { returnDocument: 'after' },
    )
    if (!result) throw new HttpError(404, 'Instance not found')

    // In GM worlds the player protagonist is canonical. If a persona is selected
    // before the player created one, seed the protagonist from the persona once.
    // If one already exists, it remains the higher-precedence canon.
    if (selectedPersona) {
      const template = await worldTemplates().findOne({
        _id: result.template_id,
      })
      if (template && !template.is_sentient) {
        const existingProtagonist = await characters().findOne({
          instance_id: iid,
          player_id: pid,
          is_protagonist: true,
        })
        if (!existingProtagonist) {
          await characterCodexService.seedProtagonist({
            instanceId,
            playerId,
            name: selectedPersona.name,
            persona: [selectedPersona.description, selectedPersona.other_info].filter(Boolean).join(' '),
            isPlayer: true,
          })
        }
      }
    }

    await getRedisClient().del(`session:${idString(iid)}`)
    return {
      narration_pov: result.narration_pov || 'third',
      mode: result.mode || DEFAULT_CHAT_MODE,
      message_length: result.message_length || 'medium',
      narrative_style_override: result.narrative_style_override ?? null,
      narration_tone: result.narration_tone || DEFAULT_NARRATION_TONE,
      focus_character_id: result.focus_character_id ? idString(result.focus_character_id) : null,
      persona_id: result.persona_id ? idString(result.persona_id) : null,
    }
  },
}
