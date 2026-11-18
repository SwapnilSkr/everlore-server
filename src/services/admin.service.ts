import { userActivityStages } from './admin-activity'
import { userOnboarding, usersSince } from './admin-onboarding'
import { ObjectId, type Document } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { UserAccountStatus, UserTier } from '../models/user.model'
import { memoryProjectionStatus } from '../models/projection.model'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { deletionService } from './deletion.service'
import { reviewerAccounts, type ReviewersMode } from './reviewer-accounts'
import { internalAccounts } from './internal-accounts'
import { playerInsights, playerInsightsService } from './admin-insights-players'
import { worldInsights, type WorldListOptions } from './admin-insights-worlds'
import { isDefaultCoverUrl, resolveTemplateImageUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { vectorStore } from './vector-store'
import { portraitUrl } from './media/portraits'

export type AdminUserTier = 'free' | 'premium' | 'creator' | 'inherit'

const users = () => mongoColl.users()
const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()
const sceneSummaries = () => mongoColl.sceneSummaries()
const generationLogs = () => mongoColl.generationLogs()

// Account access is changed only through the explicit tier/status operations
// below; generic JSON patching must not bypass those invariants. The team flag
// has its own route for the same reason: `internal_override` decides whether
// the sweep may tag the account again.
const BLOCKED_UPDATE_KEYS = new Set([
  '_id',
  'created_at',
  'password_hash',
  'google_sub',
  'providers',
  'account_status',
  'admin_tier_override',
  'banned_at',
  'ban_reason',
  'internal',
  'internal_reason',
  'internal_at',
  'internal_override',
])

function paging(opts: { page?: number; limit?: number }) {
  const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 200)
  const page = Math.max(Number(opts.page || 1), 1)
  return { limit, page, skip: (page - 1) * limit }
}

function serialize(value: unknown): unknown {
  if (value instanceof ObjectId) return idString(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serialize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key === '_id' ? 'id' : key] = serialize(child)
    }
    return out
  }
  return value
}

function isObjectId(value: unknown): value is ObjectId {
  return value instanceof ObjectId
}

function cleanPatch(input: Record<string, unknown>, extraBlocked: string[] = []): Record<string, unknown> {
  const blocked = new Set([...BLOCKED_UPDATE_KEYS, ...extraBlocked])
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (blocked.has(key) || value === undefined) continue
    out[key] = value
  }
  return out
}

function maybeObjectId(value: unknown): ObjectId | unknown {
  return typeof value === 'string' && ObjectId.isValid(value) ? parseObjectId(value) : value
}

function idFilter(field: string, id?: string): Record<string, unknown> {
  return id ? { [field]: parseObjectId(id) } : {}
}

async function listCollection(
  collection: any,
  filter: Record<string, unknown>,
  sort: Record<string, 1 | -1>,
  opts: { page?: number; limit?: number },
) {
  const { limit, page, skip } = paging(opts)
  const [total, rows] = await Promise.all([
    collection.countDocuments(filter),
    collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
  ])
  return { total, page, limit, items: rows.map((row: Document) => serialize(row)) }
}

export const adminService = {
  async overview() {
    // The headline counts, so review accounts are left out of them: their
    // accounts, their saves and their events.
    const { userIds } = await reviewerAccounts.scope()
    const playerMatch = userIds.length > 0 ? { player_id: { $nin: userIds } } : {}
    const [
      totalUsers,
      totalWorlds,
      publishedWorlds,
      totalInstances,
      totalEvents,
      totalMemories,
      totalCharacters,
    ] = await Promise.all([
      users().countDocuments({ reviewer: { $ne: true }, internal: { $ne: true } }),
      worldTemplates().countDocuments({}),
      worldTemplates().countDocuments({ is_published: true }),
      worldInstances().countDocuments(playerMatch),
      events().countDocuments(playerMatch),
      memories().countDocuments(playerMatch),
      characters().countDocuments({}),
    ])

    return {
      users: totalUsers,
      worlds: totalWorlds,
      published_worlds: publishedWorlds,
      world_instances: totalInstances,
      events: totalEvents,
      memories: totalMemories,
      characters: totalCharacters,
    }
  },

  async listUsers(opts: { page?: number; limit?: number; search?: string; sort?: string; since?: string; reviewers?: ReviewersMode }) {
    if (opts.sort !== undefined && opts.sort !== 'created' && opts.sort !== 'last_active') {
      throw new HttpError(400, 'Sort must be created or last_active.')
    }
    const filter: Record<string, unknown> = {}
    // Review and team accounts are someone's to see on request, not players by
    // default. One switch covers both, as it does in every other player number.
    const reviewers = opts.reviewers ?? 'exclude'
    if (reviewers === 'exclude') {
      filter.reviewer = { $ne: true }
      filter.internal = { $ne: true }
    } else if (reviewers === 'only') {
      filter.$and = [{ $or: [{ reviewer: true }, { internal: true }] }]
    }
    const since = usersSince(opts.since)
    if (since) filter.created_at = { $gte: since }
    if (opts.search) {
      filter.$or = [
        // The display name is searched alongside the handle: an operator
        // following up a report or a support message has the name the player
        // uses, not the generated username.
        { 'preferences.player_name': { $regex: opts.search, $options: 'i' } },
        { username: { $regex: opts.search, $options: 'i' } },
        { email: { $regex: opts.search, $options: 'i' } },
        { phone: { $regex: opts.search, $options: 'i' } },
      ]
    }
    const { limit, page, skip } = paging(opts)
    const [total, rows] = await Promise.all([
      users().countDocuments(filter),
      users().aggregate([
        { $match: filter },
        // Created ordering can page before the lookup. Activity ordering must
        // include the legacy story fallback before sorting and pagination.
        ...(opts.sort === 'last_active' ? [
          ...userActivityStages(),
          { $sort: { last_active_at: -1, _id: -1 } },
          { $skip: skip }, { $limit: limit },
        ] : [
          { $sort: { created_at: -1, _id: -1 } },
          { $skip: skip }, { $limit: limit },
          ...userActivityStages(),
        ]),
      ]).toArray(),
    ])
    // The added insight fields are computed for this page's rows only, in one
    // pass keyed by player id: no list-wide scan of logs, sessions or media.
    const insights = await playerInsights(rows as never[])
    return {
      total,
      page,
      limit,
      items: rows.map((row: Document) => {
        const extra = insights.get(idString(row._id))
        return serialize({
          ...row,
          onboarding: userOnboarding(row),
          // The team flag travels on the row so the console can tag it without
          // a second read; a player carries `false` and no reason.
          internal: row.internal === true,
          internal_reason: typeof row.internal_reason === 'string' ? row.internal_reason : null,
          ...(extra ? { profile: extra.profile, cost_usd_30d: extra.cost_usd_30d, ink: extra.ink } : {}),
        })
      }),
    }
  },

  async getUser(userId: string) {
    const [user] = await users().aggregate([
      { $match: { _id: parseObjectId(userId) } }, ...userActivityStages(),
    ]).toArray()
    if (!user) throw new HttpError(404, 'User not found')

    const uid = parseObjectId(userId)
    const [instances, createdWorlds, eventsCount, memoriesCount] = await Promise.all([
      worldInstances().countDocuments({ player_id: uid }),
      worldTemplates().countDocuments({ creator_id: uid }),
      events().countDocuments({ player_id: uid }),
      memories().countDocuments({ player_id: uid }),
    ])

    return {
      user: serialize({ ...user, onboarding: userOnboarding(user) }),
      counts: {
        own_instances: instances,
        created_worlds: createdWorlds,
        events: eventsCount,
        memories: memoriesCount,
      },
      // The profile card, its 30-day chart and the worlds this player played,
      // all read for this one account.
      ...(await playerInsightsService.detail(user as never)),
    }
  },

  async updateUser(userId: string, data: Record<string, unknown>) {
    const patch = cleanPatch(data)
    if ('tier' in patch) patch.tier = patch.tier as UserTier
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')

    const updated = await users().findOneAndUpdate(
      { _id: parseObjectId(userId) },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
    if (!updated) throw new HttpError(404, 'User not found')
    return { user: serialize(updated) }
  },

  /**
   * Per-account billing limits.
   *
   * `null` clears a key so the account falls back to its tier, which is a
   * different state from setting the tier's current number: the tier default
   * can then move without stranding this account on a stale copy of it.
   */
  async setUserBillingLimits(
    userId: string,
    limits: { monthly_ink?: number | null; daily_story_safety_cap?: number | null },
  ) {
    const uid = parseObjectId(userId)
    const set: Record<string, unknown> = { updated_at: new Date() }
    const unset: Record<string, ''> = {}

    for (const key of ['monthly_ink', 'daily_story_safety_cap'] as const) {
      const value = limits[key]
      if (value === undefined) continue
      if (value === null) {
        unset[`billing_overrides.${key}`] = ''
        continue
      }
      const max = key === 'monthly_ink' ? 100_000_000 : 1_000_000
      if (!Number.isSafeInteger(value) || value < 0 || value > max) {
        throw new HttpError(400, `${key} must be a whole number between 0 and ${max.toLocaleString()}`)
      }
      set[`billing_overrides.${key}`] = value
    }

    const update: Record<string, unknown> = { $set: set }
    if (Object.keys(unset).length) update.$unset = unset

    const updated = await users().findOneAndUpdate({ _id: uid }, update, {
      returnDocument: 'after',
      projection: { password_hash: 0 },
    })
    if (!updated) throw new HttpError(404, 'User not found')
    return { user: serialize(updated) }
  },

  async setUserTier(userId: string, tier: AdminUserTier) {
    const uid = parseObjectId(userId)
    const update: any = tier === 'inherit'
      ? { $set: { tier: 'free' as UserTier, updated_at: new Date() }, $unset: { admin_tier_override: '' } }
      : { $set: { tier: tier as UserTier, admin_tier_override: tier, updated_at: new Date() } }
    const updated = await users().findOneAndUpdate(
      { _id: uid },
      update,
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
    if (!updated) throw new HttpError(404, 'User not found')
    return { user: serialize(updated) }
  },

  async setUserStatus(userId: string, status: UserAccountStatus, reason?: string) {
    const uid = parseObjectId(userId)
    const normalizedReason = String(reason || '').trim().slice(0, 240)
    const update: any = status === 'banned'
      ? {
          $set: {
            account_status: 'banned' as const,
            banned_at: new Date(),
            ban_reason: normalizedReason || 'Banned by administrator',
            updated_at: new Date(),
          },
        }
      : {
          $set: { account_status: 'active' as const, updated_at: new Date() },
          $unset: { banned_at: '', ban_reason: '' },
        }
    const updated = await users().findOneAndUpdate(
      { _id: uid },
      update,
      { returnDocument: 'after', projection: { password_hash: 0 } },
    )
    if (!updated) throw new HttpError(404, 'User not found')
    return { user: serialize(updated) }
  },

  async deleteUser(userId: string) {
    return deletionService.deleteAccount(userId)
  },

  /**
   * The team flag by hand ("Contract, part 2b"). On records `manual` unless a
   * rule already named a better reason; off clears both keys and records the
   * override the sweep honours.
   */
  async setUserInternal(userId: string, internal: boolean) {
    return { user: serialize(await internalAccounts.setInternal(userId, internal)) }
  },

  async listWorlds(opts: WorldListOptions) {
    // The filters, sort and per-page stats live together in the insights module;
    // existing params keep their meaning, and the new ones are validated there.
    return worldInsights.list(opts)
  },

  async listWorldReview() {
    const worlds = await worldTemplates().aggregate([
      { $match: { is_published: true, visibility: 'public', review_status: 'pending' } },
      { $sort: { submitted_at: 1, _id: 1 } },
      { $lookup: {
        from: 'users', localField: 'creator_id', foreignField: '_id', as: 'creator',
        pipeline: [{ $project: { _id: 1, username: 1 } }],
      } },
      { $project: {
        _id: 1, title: 1, description: 1, image_url: 1,
        seed_prompt: 1, global_lore: 1, opening_line: 1,
        kind: 1, is_sentient: 1, is_nsfw_capable: 1, narrative_style: 1,
        protagonist: 1, creator: { $first: '$creator' }, submitted_at: 1,
        was_approved_before: { $eq: ['$ever_approved', true] },
        seed_cast: 1, topics: 1, opening_lines: 1,
      } },
    ]).toArray()
    // A group's lines are what the owner reviews, so the queue carries the cast
    // and the written prompts. Other worlds' items keep exactly the shape they
    // had: a non-group never gains these keys. Faces travel as absolute URLs
    // because the console has no CDN configuration of its own, and nothing
    // absent is sent as null.
    const items = worlds.map((world) => {
      if (world.kind !== 'group') {
        delete world.seed_cast
        delete world.topics
        delete world.opening_lines
        return world
      }
      const cast = Array.isArray(world.seed_cast) ? world.seed_cast as Record<string, unknown>[] : []
      return {
        ...world,
        seed_cast: cast.map((member) => {
          const group = member.group as Record<string, unknown> | undefined
          const portrait = member.portrait as Record<string, unknown> | undefined
          const row: Record<string, unknown> = {}
          const put = (key: string, value: unknown) => {
            if (value !== undefined && value !== null) row[key] = value
          }
          put('name', member.name)
          put('age', group?.age)
          put('role', member.role)
          put('appearance', member.appearance)
          put('persona', member.persona)
          put('speech', group?.speech)
          put('wants', group?.wants)
          put('intimacy', group?.intimacy)
          put('start_bond', group?.start_bond)
          put('voice', group?.voice)
          put('first_texts', member.first_texts)
          put('statuses', member.statuses)
          if (typeof portrait?.asset_key === 'string') put('portrait_url', portraitUrl(portrait.asset_key))
          if (typeof portrait?.thumb_key === 'string') put('portrait_thumb_url', portraitUrl(portrait.thumb_key))
          return row
        }),
      }
    })
    return { items }
  },

  async reviewWorld(worldId: string, status: 'approved' | 'changes_requested', adminUser: string, note?: string) {
    const normalizedNote = note?.trim()
    if (status === 'changes_requested' && (!normalizedNote || normalizedNote.length > 500)) {
      throw new HttpError(400, 'Please add a note of up to 500 characters.')
    }
    const updated = await worldTemplates().findOneAndUpdate(
      { _id: parseObjectId(worldId), is_published: true, visibility: 'public', review_status: 'pending' },
      {
        $set: {
          review_status: status,
          reviewed_at: new Date(),
          reviewed_by: adminUser,
          updated_at: new Date(),
          ...(status === 'approved' ? { ever_approved: true } : { review_note: normalizedNote! }),
        },
        ...(status === 'approved' ? { $unset: { review_note: '' } } : {}),
      },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(409, 'This world is no longer awaiting review.')
    return { world: updated }
  },

  async getWorld(templateId: string) {
    // Same `world` and `counts` as before, plus the creator, cover, stats and
    // the single-world insights block.
    return worldInsights.get(templateId)
  },

  async updateWorld(templateId: string, data: Record<string, unknown>) {
    const tid = parseObjectId(templateId)
    const existing = await worldTemplates().findOne({ _id: tid })
    if (!existing) throw new HttpError(404, 'World not found')

    const patch = cleanPatch(data)
    if ('creator_id' in patch) patch.creator_id = maybeObjectId(patch.creator_id)

    if (typeof patch.image_url === 'string' && patch.image_url !== existing.image_url) {
      patch.image_url = await resolveTemplateImageUrl(patch.image_url)
      if (existing.image_url && !isDefaultCoverUrl(existing.image_url)) {
        const oldKey = storageService.keyFromUrl(existing.image_url)
        if (oldKey) void storageService.delete(oldKey)
      }
    }

    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')
    const updated = await worldTemplates().findOneAndUpdate(
      { _id: tid },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    return { world: serialize(updated) }
  },

  async deleteWorld(templateId: string) {
    return deletionService.deleteTemplateById(templateId)
  },

  async listInstances(opts: { page?: number; limit?: number; player_id?: string; template_id?: string; archived?: boolean }) {
    const filter: Record<string, unknown> = {
      ...idFilter('player_id', opts.player_id),
      ...idFilter('template_id', opts.template_id),
    }
    if (opts.archived !== undefined) filter['meta.is_archived'] = opts.archived
    return listCollection(worldInstances(), filter, { updated_at: -1 }, opts)
  },

  async listContinuityAuditStatus(opts: {
    page?: number
    limit?: number
    status?: 'all' | 'healthy' | 'unhealthy' | 'missing' | 'stale'
    stale_days?: number
  }) {
    const { limit, page, skip } = paging(opts)
    const status = opts.status || 'all'
    const filter: Record<string, unknown> = { 'meta.is_archived': { $ne: true } }
    const staleDays = Math.min(Math.max(Number(opts.stale_days || 7), 1), 365)
    const staleBefore = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000)

    if (status === 'healthy') {
      filter['meta.last_continuity_audit.healthy'] = true
    } else if (status === 'unhealthy') {
      filter['meta.last_continuity_audit.healthy'] = false
    } else if (status === 'missing') {
      filter['meta.last_continuity_audit'] = { $exists: false }
    } else if (status === 'stale') {
      filter.$or = [
        { 'meta.last_continuity_audit': { $exists: false } },
        { 'meta.last_continuity_audit.checked_at': { $lt: staleBefore } },
      ]
    }

    const projection = {
      _id: 1,
      player_id: 1,
      template_id: 1,
      updated_at: 1,
      'meta.total_events': 1,
      'meta.last_active_at': 1,
      'meta.last_continuity_audit': 1,
    }
    const sort: Record<string, 1 | -1> =
      status === 'unhealthy'
        ? { 'meta.last_continuity_audit.summary.fail': -1, 'meta.last_continuity_audit.summary.warn': -1, updated_at: -1 }
        : { 'meta.last_continuity_audit.checked_at': 1, updated_at: -1 }

    const [total, rows] = await Promise.all([
      worldInstances().countDocuments(filter),
      worldInstances()
        .find(filter, { projection })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray(),
    ])

    return {
      total,
      page,
      limit,
      status,
      stale_days: staleDays,
      items: rows.map((row) =>
        serialize({
          _id: row._id,
          player_id: row.player_id,
          template_id: row.template_id,
          total_events: row.meta?.total_events || 0,
          last_active_at: row.meta?.last_active_at || null,
          updated_at: row.updated_at,
          last_continuity_audit: row.meta?.last_continuity_audit || null,
        }),
      ),
    }
  },

  async getInstance(instanceId: string) {
    const iid = parseObjectId(instanceId)
    const instance = await worldInstances().findOne({ _id: iid })
    if (!instance) throw new HttpError(404, 'Instance not found')
    const [eventsCount, memoriesCount, charactersCount, summariesCount, logsCount, chat, tokenStats] = await Promise.all([
      events().countDocuments({ instance_id: iid }),
      memories().countDocuments({ instance_id: iid }),
      characters().countDocuments({ instance_id: iid }),
      sceneSummaries().countDocuments({ instance_id: iid }),
      generationLogs().countDocuments({ instance_id: iid }),
      events()
        .find(
          { instance_id: iid },
          { projection: { sequence: 1, scene_tag: 1, created_at: 1, 'data.player_input': 1, 'data.ai_response': 1, 'data.model_used': 1 } },
        )
        .sort({ sequence: 1 })
        .limit(200)
        .toArray(),
      generationLogs()
        .aggregate([
          { $match: { instance_id: iid } },
          { $group: { _id: null, tokens_in: { $sum: { $ifNull: ['$tokens_in', 0] } }, tokens_out: { $sum: { $ifNull: ['$tokens_out', 0] } }, avg_ttft_ms: { $avg: '$ttft_ms' } } },
        ])
        .toArray(),
    ])
    return {
      instance: serialize(instance),
      counts: {
        events: eventsCount,
        memories: memoriesCount,
        characters: charactersCount,
        scene_summaries: summariesCount,
        generation_logs: logsCount,
        tokens_in: Number(tokenStats[0]?.tokens_in || 0),
        tokens_out: Number(tokenStats[0]?.tokens_out || 0),
        avg_ttft_ms: typeof tokenStats[0]?.avg_ttft_ms === 'number' ? Math.round(Number(tokenStats[0].avg_ttft_ms)) : null,
      },
      chat: chat.map((event) => serialize({
        id: event._id,
        sequence: event.sequence,
        scene_tag: event.scene_tag,
        created_at: event.created_at,
        player_input: event.data?.player_input || '',
        ai_response: event.data?.ai_response || '',
        model_used: event.data?.model_used || null,
      })),
    }
  },

  async updateInstance(instanceId: string, data: Record<string, unknown>) {
    const patch = cleanPatch(data)
    if ('player_id' in patch) patch.player_id = maybeObjectId(patch.player_id)
    if ('template_id' in patch) patch.template_id = maybeObjectId(patch.template_id)
    if ('focus_character_id' in patch && patch.focus_character_id) {
      patch.focus_character_id = maybeObjectId(patch.focus_character_id)
    }
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')

    const updated = await worldInstances().findOneAndUpdate(
      { _id: parseObjectId(instanceId) },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(404, 'Instance not found')
    return { instance: serialize(updated) }
  },

  async deleteInstance(instanceId: string) {
    return deletionService.deleteInstanceById(instanceId)
  },

  async listEvents(opts: { page?: number; limit?: number; instance_id?: string; player_id?: string }) {
    const filter: Record<string, unknown> = {
      ...idFilter('instance_id', opts.instance_id),
      ...idFilter('player_id', opts.player_id),
    }
    return listCollection(events(), filter, { created_at: -1 }, opts)
  },

  async updateEvent(eventId: string, data: Record<string, unknown>) {
    const patch = cleanPatch(data, ['instance_id'])
    if ('player_id' in patch) patch.player_id = maybeObjectId(patch.player_id)
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')
    const updated = await events().findOneAndUpdate(
      { _id: parseObjectId(eventId) },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(404, 'Event not found')
    return { event: serialize(updated) }
  },

  async deleteEvent(eventId: string) {
    const eid = parseObjectId(eventId)
    const event = await events().findOne({ _id: eid })
    if (!event) throw new HttpError(404, 'Event not found')

    const mems = await memories().find({ source_event_ids: eid }, { projection: { _id: 1, instance_id: 1, pinecone_id: 1 } }).toArray()
    for (const memory of mems) {
      if (memory.pinecone_id) {
        try {
          await vectorStore.deleteIds({ kind: 'mem', instanceId: idString(memory.instance_id) }, [memory.pinecone_id])
        } catch {
          // best-effort vector cleanup; Mongo deletion still proceeds
        }
      }
    }
    if (mems.length > 0) await memories().deleteMany({ _id: { $in: mems.map((m) => m._id) } })
    await generationLogs().deleteMany({ instance_id: event.instance_id, sequence: event.sequence })
    await mongoColl.extractorRaw().deleteMany({ instance_id: event.instance_id, sequence: event.sequence })
    await events().deleteOne({ _id: eid })
    await worldInstances().updateOne(
      { _id: event.instance_id },
      {
        $inc: {
          'meta.total_events': -1,
          'meta.total_memories': -mems.length,
        },
        $set: { updated_at: new Date() },
      },
    )
    return { deleted: true, deleted_memories: mems.length }
  },

  async listMemories(opts: { page?: number; limit?: number; instance_id?: string; player_id?: string }) {
    const filter: Record<string, unknown> = {
      ...idFilter('instance_id', opts.instance_id),
      ...idFilter('player_id', opts.player_id),
    }
    return listCollection(memories(), filter, { updated_at: -1 }, opts)
  },

  async updateMemory(memoryId: string, data: Record<string, unknown>) {
    const patch = cleanPatch(data, ['instance_id'])
    if ('player_id' in patch) patch.player_id = maybeObjectId(patch.player_id)
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')
    const updated = await memories().findOneAndUpdate(
      { _id: parseObjectId(memoryId) },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(404, 'Memory not found')
    return { memory: serialize(updated) }
  },

  async deleteMemory(memoryId: string) {
    const mid = parseObjectId(memoryId)
    const memory = await memories().findOne({ _id: mid })
    if (!memory) throw new HttpError(404, 'Memory not found')
    if (memory.pinecone_id) {
      await vectorStore.deleteIds({ kind: 'mem', instanceId: idString(memory.instance_id) }, [memory.pinecone_id])
    }
    await memories().deleteOne({ _id: mid })
    await worldInstances().updateOne(
      { _id: memory.instance_id },
      { $inc: { 'meta.total_memories': -1 }, $set: { updated_at: new Date() } },
    )
    return { deleted: true }
  },

  async listCharacters(opts: { page?: number; limit?: number; instance_id?: string }) {
    return listCollection(characters(), idFilter('instance_id', opts.instance_id), { updated_at: -1 }, opts)
  },

  async updateCharacter(characterId: string, data: Record<string, unknown>) {
    const patch = cleanPatch(data, ['instance_id', 'player_id', 'name_normalized'])
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'No editable fields provided')

    const updated = await characters().findOneAndUpdate(
      { _id: parseObjectId(characterId) },
      { $set: { ...patch, updated_at: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new HttpError(404, 'Character not found')
    return { character: serialize(updated) }
  },

  async deleteCharacter(characterId: string) {
    const cid = parseObjectId(characterId)
    const character = await characters().findOne({ _id: cid })
    if (!character) throw new HttpError(404, 'Character not found')

    await characters().deleteOne({ _id: cid })
    await worldInstances().updateOne(
      { _id: character.instance_id, focus_character_id: cid },
      { $set: { focus_character_id: null, updated_at: new Date() } },
    )
    return { deleted: true }
  },

  async listGenerationLogs(opts: { page?: number; limit?: number; instance_id?: string; player_id?: string }) {
    const filter: Record<string, unknown> = {
      ...idFilter('instance_id', opts.instance_id),
      ...idFilter('player_id', opts.player_id),
    }
    return listCollection(generationLogs(), filter, { created_at: -1 }, opts)
  },

  /**
   * Projection inspection: everything derived from one event, in one view —
   * the debug surface for the "projections must be traceable back to source
   * events" invariant. Shows memories sourced from the event (with effective
   * lifecycle status), entity edges carrying it as provenance, scene summaries
   * covering its sequence, the ledgered codex deltas, and the entities the
   * linked memories/edges reference.
   */
  async getEventProjections(eventId: string) {
    const eid = parseObjectId(eventId)
    const event = await events().findOne({ _id: eid })
    if (!event) throw new HttpError(404, 'Event not found')
    const iid = event.instance_id

    const [mems, edges, summaries] = await Promise.all([
      memories()
        .find({ instance_id: iid, source_event_ids: eid })
        .toArray(),
      mongoColl
        .entityEdges()
        .find({ instance_id: iid, source_event_ids: eid })
        .toArray(),
      sceneSummaries()
        .find({
          instance_id: iid,
          'event_range.start_sequence': { $lte: event.sequence },
          'event_range.end_sequence': { $gte: event.sequence },
        })
        .toArray(),
    ])

    const entityIds = [
      ...new Map(
        [
          ...mems.flatMap((m) => [...(m.subject_entity_ids || []), ...(m.object_entity_ids || [])]),
          ...mems.flatMap((m) => [m.location_entity_id, m.location_anchor?.entity_id].filter(isObjectId)),
          ...edges.flatMap((e) => [e.source_entity_id, e.target_entity_id]),
        ].map((id) => [idString(id), id] as const),
      ).values(),
    ]
    const ents = entityIds.length
      ? await mongoColl.entities().find({ _id: { $in: entityIds } }).toArray()
      : []

    // Memory version graph (Phase 2): resolve the atoms these memories link to
    // (updates/extends/derives) into id+snippet+status so the lineage is
    // inspectable. PRIVACY: a linked atom that is a private side-chat secret is
    const linkedMemoryIds = [
      ...new Map(
        mems
          .flatMap((m) => [
            ...(m.updates_memory_ids || []),
            ...(m.extends_memory_ids || []),
            ...(m.derives_from_memory_ids || []),
          ])
          .map((id) => [idString(id), id] as const),
      ).values(),
    ]
    const linkedDocs = linkedMemoryIds.length
      ? await memories().find({ _id: { $in: linkedMemoryIds } }).toArray()
      : []
    const linkedById = new Map(linkedDocs.map((m) => [idString(m._id), m]))
    const resolveLinks = (ids: ObjectId[] | undefined) =>
      (ids || []).map((id) => {
        const doc = linkedById.get(idString(id))
        return serialize({
          _id: id,
          text: doc ? doc.text : '[removed]',
          status: doc ? memoryProjectionStatus(doc) : 'archived',
        })
      })

    return {
      event: serialize({
        _id: event._id,
        instance_id: event.instance_id,
        sequence: event.sequence,
        type: event.type,
        scene_tag: event.scene_tag,
        time_anchor: event.time_anchor || null,
        location_anchor: event.location_anchor || null,
        is_user_edited: event.is_user_edited,
        created_at: event.created_at,
      }),
      codex_deltas: event.data?.codex_deltas || [],
      memories: mems.map((m) =>
        serialize({
          _id: m._id,
          text: m.text,
          type: m.type,
          importance: m.importance,
          status: memoryProjectionStatus(m),
          is_archived: m.is_archived,
          has_vector: !!m.pinecone_id,
          subjects: m.subjects || [],
          objects: m.objects || [],
          subject_entity_ids: m.subject_entity_ids || [],
          object_entity_ids: m.object_entity_ids || [],
          time_anchor: m.time_anchor || null,
          timeline_id: m.timeline_id || null,
          location_anchor: m.location_anchor || null,
          location_entity_id: m.location_entity_id || null,
          location_name: m.location_name || null,
          unresolved_thread: m.unresolved_thread === true,
          // Version graph (Phase 2): what this atom evolves + what invalidated it.
          updates_memories: resolveLinks(m.updates_memory_ids),
          extends_memories: resolveLinks(m.extends_memory_ids),
          derives_from_memories: resolveLinks(m.derives_from_memory_ids),
          superseded_by_event_ids: (m.superseded_by_event_ids || []).map(idString),
        }),
      ),
      entity_edges: edges.map((e) =>
        serialize({
          _id: e._id,
          type: e.type,
          label: e.label ?? null,
          weight: e.weight ?? null,
          importance: e.importance,
          status: e.status,
          source_entity_id: e.source_entity_id,
          target_entity_id: e.target_entity_id,
          source_event_count: (e.source_event_ids || []).length,
        }),
      ),
      scene_summaries: summaries.map((s) =>
        serialize({
          _id: s._id,
          scene_tag: s.scene_tag,
          event_range: s.event_range,
          status: s.status || 'active',
        }),
      ),
      entities: ents.map((e) =>
        serialize({
          _id: e._id,
          type: e.type,
          canonical_name: e.canonical_name,
          status: e.status,
          character_id: e.character_id ?? null,
        }),
      ),
    }
  },
}
