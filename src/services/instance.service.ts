import { groupThreadFilter } from './group-chat/memory'
import { requireIdentity } from './guest-policy'
import { seedGroupOpening } from './group-chat/instance'
import { publicGroupData } from './group-chat/public'
import { detectSpokenLines } from './media/detection'
import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { COLLECTIONS } from '../models/collections'
import type { WorldInstanceDoc } from '../models/world-instance.model'
import type { WorldTemplateDoc, WorldTemplateSummaryDoc } from '../models/world-template.model'
import type { WorldEventDoc } from '../models/world-event.model'
import { effectivePlayerGender } from '../models/player-gender'
import { getRedisClient } from '../config/redis'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { characterCodexService } from './character-codex.service'
import { extractOpeningPlace } from './opening-place.service'
import { kinshipGraphService } from './kinship-graph.service'
import { personaService } from './persona.service'
import { timeService } from './time.service'
import { isValidMessageLength, isValidStyleKey } from '../utils/narrative-styles'
import { isValidModeKey, DEFAULT_CHAT_MODE } from '../utils/chat-modes'
import { DEFAULT_NARRATION_TONE, isValidNarrationTone } from '../utils/narration-tones'
import { materializeTemplateCast } from './template-cast.service'
import { isWorldListed } from '../utils/world-review'
import { generationLockKey } from '../utils/generation-lock'
import { publishSpokenLines } from './media/events'
import { purgeMedia } from './media/deletion'
import {
  effectiveReplyLanguage,
  enabledReplyLanguages,
  isReplyLanguageSetting,
  liveFrameLanguage,
  startingLanguage,
} from '../utils/reply-language'

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
    personaId?: string,
  ): Promise<{ instance: WorldInstanceDoc; template: WorldTemplateDoc }> {
    const playerOid = parseObjectId(playerId)
    const templateOid = parseObjectId(templateId)

    const template = await worldTemplates().findOne({ _id: templateOid })
    if (!template) throw new HttpError(404, 'Template not found')
    // Creators can playtest drafts and worlds in review; existing saves are
    // read through their own routes and remain usable after delisting. A
    // retired group is not listed either, but a player who already has a chat
    // in it still opens that chat: the group block below decides.
    if (
      idString(template.creator_id) !== playerId &&
      !isWorldListed(template) &&
      !(template.kind === 'group' && template.retired_at)
    ) {
      throw new HttpError(404, 'That world could not be found.')
    }

    if (template.kind === 'group') {
      await requireIdentity(playerId)
      const existing = await worldInstances().findOne({ template_id: templateOid, player_id: playerOid })
      if (existing) {
        if (!existing.group_state) {
          await materializeTemplateCast({ template: { ...template, seed_cast: existing.seed_cast_snapshot || template.seed_cast }, instanceId: idString(existing._id), playerId, sequence: 0 })
          const player = await mongoColl.users().findOne({ _id: playerOid }, { projection: { 'preferences.player_name': 1 } })
          await seedGroupOpening(existing, template, player?.preferences?.player_name || 'Player')
        }
        return { instance: existing, template }
      }
      // Nobody starts a new chat in a retired group, the owner included.
      if (template.retired_at) throw new HttpError(404, 'That group could not be found.')
    }

    if (template.kind !== 'group') {
      const limits = TIER_LIMITS[tier] || TIER_LIMITS.free
      const instanceCount = await worldInstances().countDocuments({
        player_id: playerOid,
        'meta.is_archived': { $ne: true },
        // Written with the save itself, before group_state is seeded.
        group_template_id: { $exists: false },
      })
      if (instanceCount >= limits.max_instances) {
        throw new HttpError(403, 'You are already keeping as many worlds as this membership allows.')
      }
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
    // The opening place reads only the authored opening line, so it can be
    // derived while the calendar derivation (inside initialAnchor) is still
    // running: on a cold cache the two model calls overlap instead of queueing.
    // It never throws, so starting it here cannot leave an unhandled rejection;
    // the result is awaited below where the opening event needs it.
    const openingLine = template.kind !== 'group' && template.opening_line?.trim() ? template.opening_line.trim() : null
    const openingPlacePromise = openingLine
      ? extractOpeningPlace({ openingLine, instanceId: idString(_id) })
      : null
    const initialTimeAnchor = await timeService.initialAnchor({
      instanceId: idString(_id),
      templateId: template.kind === 'group' ? undefined : templateId,
      sequence: 0,
    })
    let personaIdForInstance: ObjectId | null = null
    let personaSnapshot: ReturnType<typeof personaService.snapshotFromPersona> | null = null
    if (personaId) {
      if (!template.is_sentient) {
        throw new HttpError(400, 'Global personas can only be used in sentient worlds')
      }
      const selectedPersona = await personas().findOne({
        _id: parseObjectId(personaId),
        player_id: playerOid,
      })
      if (!selectedPersona) throw new HttpError(400, 'Invalid persona_id')
      personaIdForInstance = selectedPersona._id
      personaSnapshot = personaService.snapshotFromPersona(selectedPersona)
    }

    // Start language: the player's explicit setting, else the language a save of
    // theirs last settled in by writing, else English. The phone's language is
    // never read. English is never stored, so the fields are only present for a
    // non-English save. With no languages enabled nothing is read or stored.
    let startLanguage: string | undefined
    let startSource: 'player' | 'writing' | undefined
    if (enabledReplyLanguages().length > 0) {
      const playerLanguage = await mongoColl.users().findOne(
        { _id: playerOid },
        { projection: { 'preferences.reply_language': 1, 'preferences.reply_language_written': 1 } },
      )
      const preference = playerLanguage?.preferences?.reply_language
      const written = playerLanguage?.preferences?.reply_language_written
      const preferredCode =
        typeof preference === 'string' && preference.trim() ? preference.trim() : undefined
      const writtenCode =
        typeof written === 'string' && written.trim() ? written.trim() : undefined
      startLanguage = startingLanguage({
        preference: preferredCode,
        written: writtenCode,
      })
      if (startLanguage) startSource = preferredCode ? 'player' : 'writing'
    }

    const instance: WorldInstanceDoc = {
      _id,
      template_id: templateOid,
      ...(template.kind === 'group' ? { group_template_id: templateOid } : {}),
      template_version: template.version,
      seed_cast_snapshot: (template.seed_cast || []).map((character) => ({ ...character })),
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
      ...(startLanguage && startSource
        ? { reply_language: startLanguage, reply_language_source: startSource }
        : {}),
      // Chat mode, prose tone, and length are player-chosen. The template voice
      // still supplies genre/world texture; tone only controls how it is phrased.
      mode: DEFAULT_CHAT_MODE,
      message_length: 'medium',
      narrative_style_override: null,
      narration_tone: DEFAULT_NARRATION_TONE,
      focus_character_id: null,
      persona_id: personaIdForInstance,
      persona_snapshot: personaSnapshot,
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

    try {
      await worldInstances().insertOne(instance)
    } catch (error) {
      if (template.kind === 'group' && (error as { code?: number }).code === 11000) {
        throw new HttpError(409, 'This chat is opening. Try again in a moment.')
      }
      throw error
    }

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

    // Every instance gets independent copies of the template's authored cast.
    // GM worlds receive this before the player defines their protagonist;
    // sentient worlds receive it alongside their locked main character.
    await materializeTemplateCast({
      template,
      instanceId: idString(_id),
      playerId,
      sequence: 0,
    }).catch((error: unknown) => { if (template.kind === 'group') throw error })

    if (template.kind === 'group') {
      const player = await mongoColl.users().findOne({ _id: playerOid }, { projection: { 'preferences.player_name': 1 } })
      await seedGroupOpening(instance, template, player?.preferences?.player_name || 'Player')
    }

    // Opening line: if the template greets the player, seed it as the first event
    // so the chat opens with the character speaking instead of a blank screen.
    if (template.kind !== 'group' && template.opening_line && template.opening_line.trim().length > 0) {
      const greeting = template.opening_line.trim()
      // The authored opening says where the player is standing. Read it, so the
      // FIRST generated turn arbitrates against a real cursor instead of taking
      // the loose first-anchor branch and adopting whatever the witness names.
      // See opening-place.service for the live case this fixes. The read was
      // started above, alongside the calendar.
      //
      // The save's language starts BESIDE them, never after: on a cold cache its
      // translation runs while the calendar, the place and the time anchor do,
      // so a create waits for the longest of the four, not their sum. A cached
      // translation is a single read and adds no call. An English save starts no
      // translation at all.
      const languageEntry = effectiveReplyLanguage(instance.reply_language)
      // Loaded only for a non-English save: an English one never reaches it.
      const openingLanguagePromise = languageEntry
        ? import('./opening-language.service').then(({ authoredOpening }) => authoredOpening({
            entry: languageEntry,
            opening: greeting,
            protagonistName: template.protagonist?.name ?? null,
            seedCast: template.seed_cast ?? null,
            personaName: instance.persona_snapshot?.name ?? null,
            // The opening place runs against the authored words, so it is not
            // known here. A world's authored title is not the place; the place
            // name joins the glossary when a later re-translation knows it.
            placeName: null,
          }))
        : null
      const [openingTimeAnchor, openingPlace, openingFields] = await Promise.all([
        timeService.anchorForNextEvent({
          instanceId: idString(_id),
          templateId,
          previous: initialTimeAnchor,
          sequence: 1,
          eventTimeLabel: 'Opening scene',
        }),
        openingPlacePromise ?? extractOpeningPlace({ openingLine: greeting, instanceId: idString(_id) }),
        openingLanguagePromise,
      ])
      await events().insertOne({
        _id: new ObjectId(),
        instance_id: _id,
        player_id: playerOid,
        sequence: 1,
        type: 'narration',
        data: {
          player_input: '',
          ...(openingFields ?? { ai_response: greeting, spoken_lines: detectSpokenLines(greeting) }),
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
        ...(openingPlace ? { location_anchor: openingPlace } : {}),
        created_at: new Date(),
      } as unknown as WorldEventDoc)
      await worldInstances().updateOne(
        { _id },
        {
          $set: {
            current_time_anchor: openingTimeAnchor,
            ...(openingPlace ? { current_location: openingPlace } : {}),
            active_timeline_id: openingTimeAnchor.timeline_id,
            default_calendar_id: openingTimeAnchor.story_calendar?.calendar_id,
            'meta.total_events': 1,
          },
        },
      )
      instance.current_time_anchor = openingTimeAnchor
      if (openingPlace) (instance as any).current_location = openingPlace
      instance.active_timeline_id = openingTimeAnchor.timeline_id
      instance.default_calendar_id = openingTimeAnchor.story_calendar?.calendar_id
      instance.meta.total_events = 1
    }

    return { instance, template }
  },

  async getById(instanceId: string, playerId: string) {
    const instance = await worldInstances().findOne({
      _id: parseObjectId(instanceId),
      player_id: parseObjectId(playerId),
    }, { projection: { media_voice_cast: 0 } })
    if (!instance) return instance
    if (instance.group_state) return publicGroupData(instance)
    return { ...instance, ...liveFrameLanguage(instance) }
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
      const template = await worldTemplates().findOne({ _id: templateOid })
      if (!template || (idString(template.creator_id) !== playerId && !isWorldListed(template))) {
        return { template: null, stories: [] }
      }
      const { _id, title, is_sentient, description, kind, image_url } = template
      return { template: { _id, title, is_sentient, description, kind, image_url }, stories: [] }
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
            ...(instances.some(instance => instance.group_state) ? groupThreadFilter() : {}),
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
        ...(inst.group_state ? publicGroupData(inst) : inst),
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
      ...(inst.group_state ? publicGroupData(inst) : inst),
      template: templateMap.get(idString(inst.template_id)) || null,
    }))
  },

  /** One row per world, not per story. This keeps the home feed compact and
   * lets it page cleanly without splitting a realm's stories across pages. */
  async listRealms(
    playerId: string,
    includeArchived: boolean = false,
    page: number = 1,
    limit: number = 12,
    search?: string,
  ) {
    const playerOid = parseObjectId(playerId)
    const filter: Record<string, unknown> = { player_id: playerOid }
    if (!includeArchived) filter['meta.is_archived'] = { $ne: true }
    const safePage = Math.max(1, page)
    const safeLimit = Math.min(30, Math.max(1, limit))
    const term = search?.trim()
    const pipeline: any[] = [
      { $match: filter },
      { $sort: { 'meta.last_active_at': -1, _id: -1 } },
      {
        $group: {
          _id: '$template_id',
          latest: { $first: '$$ROOT' },
          story_count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: COLLECTIONS.world_templates,
          localField: '_id',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, title: 1, is_sentient: 1, description: 1, kind: 1, image_url: 1 } }],
          as: 'template',
        },
      },
      { $unwind: { path: '$template', preserveNullAndEmptyArrays: true } },
    ]
    if (term) {
      pipeline.push({
        $match: {
          $or: [
            { 'template.title': { $regex: term, $options: 'i' } },
            { 'template.description': { $regex: term, $options: 'i' } },
          ],
        },
      })
    }
    pipeline.push(
      { $sort: { 'latest.meta.last_active_at': -1, 'latest._id': -1 } },
      {
        $facet: {
          rows: [
            { $skip: (safePage - 1) * safeLimit },
            { $limit: safeLimit },
            { $project: { _id: 0, template_id: '$_id', latest: 1, template: 1, story_count: 1 } },
          ],
          count: [{ $count: 'total' }],
        },
      },
    )
    const [result] = await worldInstances().aggregate<any>(pipeline).toArray()
    return {
      realms: (result?.rows ?? []).map((row: { latest?: WorldInstanceDoc }) => row.latest?.group_state ? publicGroupData(row) : row),
      total: result?.count?.[0]?.total ?? 0,
      page: safePage,
    }
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
    data: { name?: string; identity?: string; reuse_from_instance_id?: string },
  ) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({
      _id: iid,
      player_id: pid,
    })
    if (!instance) throw new HttpError(404, 'Instance not found')

    const template = await worldTemplates().findOne(
      { _id: instance.template_id },
      { projection: { is_sentient: 1 } },
    )
    if (template?.is_sentient) {
      throw new HttpError(400, 'The world character is already established for this realm')
    }

    let name = data.name?.trim() || ''
    let identity = data.identity?.trim() || undefined
    let appearance: string | undefined
    if (data.reuse_from_instance_id) {
      const sourceId = parseObjectId(data.reuse_from_instance_id)
      const source = await worldInstances().findOne({
        _id: sourceId,
        player_id: pid,
        template_id: instance.template_id,
      })
      if (!source) throw new HttpError(400, 'That protagonist belongs to another realm')
      const sourceCard = await characters().findOne({
        instance_id: sourceId,
        player_id: pid,
        is_protagonist: true,
      })
      if (!sourceCard) throw new HttpError(400, 'That story has no reusable protagonist')
      name = sourceCard.canonical_name
      identity = sourceCard.persona || undefined
      appearance = sourceCard.appearance || undefined
    }
    if (!name) throw new HttpError(400, 'A protagonist name is required')

    const card = await characterCodexService.seedProtagonist({
      instanceId,
      playerId,
      name,
      persona: identity,
      appearance,
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

  /** Reusable GM protagonists are intentionally scoped to this one template.
   * They are copied, never shared, so two playthroughs can diverge safely. */
  async listReusableProtagonists(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const instance = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!instance) throw new HttpError(404, 'Instance not found')
    const template = await worldTemplates().findOne({ _id: instance.template_id }, { projection: { is_sentient: 1 } })
    if (template?.is_sentient) return { protagonists: [] }
    const siblingInstances = await worldInstances().find({
      player_id: pid,
      template_id: instance.template_id,
      _id: { $ne: iid },
    }).project({ _id: 1, 'meta.last_active_at': 1 }).sort({ 'meta.last_active_at': -1 }).toArray()
    if (!siblingInstances.length) return { protagonists: [] }
    const cards = await characters().find({
      instance_id: { $in: siblingInstances.map((row) => row._id) },
      player_id: pid,
      is_protagonist: true,
    }).toArray()
    const order = new Map(siblingInstances.map((row, index) => [idString(row._id), index]))
    return {
      protagonists: cards
        .sort((a, b) => (order.get(idString(a.instance_id)) ?? 999) - (order.get(idString(b.instance_id)) ?? 999))
        .map((card) => ({
          source_instance_id: idString(card.instance_id),
          name: card.canonical_name,
          identity: card.persona || '',
          appearance: card.appearance || '',
        })),
    }
  },

  async loadSession(instanceId: string, playerId: string) {
    const redis = getRedisClient()
    const iidStr = instanceId.trim()

    const cached = await redis.get(`session:${iidStr}`)
    if (cached) return JSON.parse(cached)

    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)

    // The account's onboarding gender is needed for this save's one effective
    // gender. Read only that key, in the same round trip as the save itself —
    // never a serial read ahead of the narrator. The session is cached for an
    // hour, so this costs one indexed projection read per cache miss.
    const [instance, player] = await Promise.all([
      worldInstances().findOne({
        _id: iid,
        player_id: pid,
      }),
      mongoColl.users().findOne({ _id: pid }, { projection: { 'preferences.gender': 1 } }),
    ])
    if (!instance) throw new Error('Instance not found')

    const template = await worldTemplates().findOne({
      _id: instance.template_id,
    })
    if (!template) throw new Error('Template not found')

    const session = {
      kind: template.kind || 'world',
      world_state: instance.world_state,
      // Template semantics travel with the session so post-stream bookkeeping
      // can judge each gauge on its own terms and apply its actual bounds.
      stat_definitions: template.base_stats_template || {},
      active_flags: instance.active_flags,
      current_scene: instance.current_scene,
      narration_pov: instance.narration_pov || 'third',
      // Effective engine code, undefined for English/off/unknown. The source and
      // check count drive writing detection; a failure changes nothing.
      reply_language: effectiveReplyLanguage(instance.reply_language)?.code,
      reply_language_source: instance.reply_language_source,
      reply_language_checks: instance.reply_language_checks || 0,
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
      // One effective gender per turn: the persona's when the save uses one,
      // else the account's onboarding answer, else unknown. The worker reads
      // this and adds no database read of its own.
      player_gender: effectivePlayerGender(instance.persona_snapshot, player?.preferences?.gender),
      current_time_anchor: instance.current_time_anchor || null,
      active_timeline_id: instance.active_timeline_id || 'main',
      default_calendar_id: instance.default_calendar_id ? idString(instance.default_calendar_id) : null,
      // `idString(null)` returns the STRING "null", and a provisional anchor has
      // no entity_id by design. That string is truthy, so the packet's
      // normaliser tried to parse it as an ObjectId, threw, and discarded the
      // whole anchor — silently losing the cursor the authored opening had just
      // established. Keep null as null.
      current_location: instance.current_location
        ? {
            ...instance.current_location,
            entity_id: instance.current_location.entity_id
              ? idString(instance.current_location.entity_id)
              : null,
          }
        : null,
      pending_destination: instance.pending_destination?.name
        ? {
            ...instance.pending_destination,
            entity_id: instance.pending_destination.entity_id
              ? idString(instance.pending_destination.entity_id)
              : null,
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
      // The authored cast. These people have no `characters` row until the codex
      // mints one from prose, so without this the lifecycle pass cannot name a
      // victim on a world's opening turns.
      seed_cast_snapshot: (instance.seed_cast_snapshot || []).map((character) => ({
        name: character.name,
        aliases: character.aliases || [],
      })),
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
      reply_language?: string
    },
  ): Promise<{
    narration_pov: 'first' | 'third'
    mode: string
    message_length: 'short' | 'medium' | 'long'
    narrative_style_override: string | null
    narration_tone: string
    focus_character_id: string | null
    persona_id: string | null
    reply_language: string
    reply_languages: Array<{ code: string; label: string }>
  }> {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const target = await worldInstances().findOne({ _id: iid, player_id: pid })
    if (!target) throw new HttpError(404, 'Instance not found')

    const update: Record<string, unknown> = { updated_at: new Date() }
    let unset: Record<string, ''> | null = null
    if (settings.reply_language !== undefined) {
      if (!isReplyLanguageSetting(settings.reply_language)) {
        throw new HttpError(400, 'Invalid reply_language')
      }
      update.reply_language_source = 'player'
      if (settings.reply_language === 'en') {
        // English is stored as absence; the source stays `player` so writing
        // detection never overrides an explicit choice.
        unset = { reply_language: '' }
      } else {
        update.reply_language = settings.reply_language
      }
    }
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
    if (settings.persona_id !== undefined) {
      if (settings.persona_id === null || settings.persona_id === '') {
        update.persona_id = null
        update.persona_snapshot = null
      } else {
        const template = await worldTemplates().findOne(
          { _id: target.template_id },
          { projection: { is_sentient: 1 } },
        )
        if (!template?.is_sentient) {
          throw new HttpError(
            400,
            'Global personas are for sentient worlds. Choose or create a protagonist for this GM world instead.',
          )
        }
        const personaOid = parseObjectId(settings.persona_id)
        const selectedPersona = await personas().findOne({
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
      { $set: update, ...(unset ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    )
    if (!result) throw new HttpError(404, 'Instance not found')
    if (settings.reply_language !== undefined) {
      // The account remembers the last language the player chose, `en` included.
      await mongoColl
        .users()
        .updateOne({ _id: pid }, { $set: { 'preferences.reply_language': settings.reply_language } })
    }

    // §6: a language the player sets on an opening-only save shows that opening
    // in the new language. Done after the setting is written, so the choice
    // stands even when the opening cannot be translated. Solo only: a group
    // keeps its own path, untouched.
    let openingChanged = false
    const previousCode = effectiveReplyLanguage(target.reply_language)?.code
    const nextEntry = effectiveReplyLanguage(result.reply_language)
    if (
      settings.reply_language !== undefined &&
      previousCode !== nextEntry?.code &&
      !target.group_state &&
      !result.group_state
    ) {
      openingChanged = await rewriteOpeningLanguage({
        instance: result,
        pid,
        entry: nextEntry ?? null,
      })
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
      ...liveFrameLanguage(result),
      // Only present when the transcript on the phone is stale; the app reloads.
      ...(openingChanged ? { opening_changed: true } : {}),
    }
  },
}

/**
 * The §6 settings rewrite: on a save whose only event is its unedited seed
 * opening, show that opening in `entry`'s language (or in English when `entry`
 * is null). Guarded so a first message sent meanwhile is never overwritten:
 *
 *  - skipped while a generation holds the save's lock or a newer event exists,
 *    checked before the translation and again after it;
 *  - the update matches the same event id, the same old `ai_response` and an
 *    opening the player has not edited.
 *
 * As in an edit: `voice_attribution` is unset, the event's media is purged and
 * `spoken_lines` recomputed and published — but no `edit_history` entry is
 * written, because this is not the player editing their story.
 *
 * Returns true only when the opening was actually rewritten. Never throws.
 */
async function rewriteOpeningLanguage(params: {
  instance: WorldInstanceDoc
  pid: ObjectId
  entry: ReturnType<typeof effectiveReplyLanguage> | null
}): Promise<boolean> {
  const { instance, pid, entry } = params
  const iid = instance._id
  const generationHoldsSave = async () =>
    !!(await getRedisClient().get(generationLockKey(idString(pid), idString(iid))))
  const hasNewerEvent = async () =>
    (await events().countDocuments({ instance_id: iid, player_id: pid, sequence: { $gt: 1 } })) > 0
  try {
    if (await generationHoldsSave()) return false

    const seed = await events().findOne({ instance_id: iid, player_id: pid, sequence: 1 })
    if (!seed || seed.data?.model_used !== 'seed' || seed.is_user_edited) return false
    if (await hasNewerEvent()) return false

    const base = String(
      (seed.data as { witness?: { ai_response?: string } } | undefined)?.witness?.ai_response
        || seed.data?.ai_response
        || '',
    )
    if (!base.trim()) return false

    const { openingGlossary, settingsOpeningFields } = await import('./opening-language.service')
    const fields = await settingsOpeningFields({
      entry: entry ?? null,
      seed: seed.data as never,
      ...openingGlossary({
        protagonistName: (
          await characters().findOne(
            { instance_id: iid, is_protagonist: true },
            { projection: { canonical_name: 1 } },
          )
        )?.canonical_name ?? null,
        seedCast: instance.seed_cast_snapshot ?? null,
        personaName: instance.persona_snapshot?.name ?? null,
        placeName: instance.current_location?.name ?? null,
      }),
    })
    if (!fields) return false

    const oldAi = String(seed.data?.ai_response || '')
    // Nothing to rewrite: the same words, with no English side to add or drop.
    if (
      fields.ai_response === oldAi &&
      !fields.witness && !fields.witness_status &&
      !seed.data?.witness && !seed.data?.witness_status
    ) return false
    // The translation takes seconds, and a first message may have been sent
    // during it. Look again, so that message's turn is never overtaken.
    if (await generationHoldsSave()) return false
    if (await hasNewerEvent()) return false
    const guard = { _id: seed._id, 'data.ai_response': oldAi, is_user_edited: { $ne: true } }
    // `witness_status` is never both set and unset: a fresh witness clears any
    // old failure, a fresh failure clears any stale witness.
    const unset: Record<string, ''> = { 'data.voice_attribution': '' }
    if (fields.witness) unset['data.witness_status'] = ''
    else if (fields.witness_status) unset['data.witness'] = ''
    else {
      unset['data.witness'] = ''
      unset['data.witness_status'] = ''
    }
    const result = await events().updateOne(guard, {
      $unset: unset,
      $set: {
        'data.ai_response': fields.ai_response,
        'data.spoken_lines': fields.spoken_lines,
        ...(fields.witness ? { 'data.witness': fields.witness } : {}),
        ...(fields.witness_status ? { 'data.witness_status': fields.witness_status } : {}),
        updated_at: new Date(),
      },
    } as never)
    if (result.matchedCount !== 1) return false
    await purgeMedia({ event_id: seed._id })
    const updated = await events().findOne({ _id: seed._id })
    if (updated) await publishSpokenLines(updated as WorldEventDoc).catch(() => {})
    return true
  } catch (err) {
    console.warn(`Failed to rewrite the opening of ${idString(iid)}:`, (err as Error).message)
    return false
  }
}
