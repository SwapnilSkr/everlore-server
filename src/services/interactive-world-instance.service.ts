import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { COLLECTIONS } from '../models/collections'
import type {
  InteractiveWorldDoc,
  InteractiveWorldInstanceDoc,
} from '../models/interactive-world.model'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import { assertUnderSaveLimit } from './save-quota'
import { getRedisClient } from '../config/redis'

const worlds = () => mongoColl.interactiveWorlds()
const instances = () => mongoColl.interactiveWorldInstances()
const events = () => mongoColl.events()

export function reasonCannotStartWalk(
  world: InteractiveWorldDoc | null | undefined,
  playerId: string,
): string | null {
  if (!world) return 'This world is not yet open to play.'
  const mine = world.creator_id ? idString(world.creator_id) === playerId : false
  if (!world.is_published && !mine) return 'This world has not been published yet'
  if (world.moderation_status === 'hidden' && !mine) {
    return 'This world is unavailable while it is under review'
  }
  return null
}

export function reasonWalkInstanceNotBound(
  worldKey: string,
  instance: InteractiveWorldInstanceDoc | null | undefined,
  playerId: string,
): string | null {
  if (!instance || idString(instance.player_id) !== playerId) return 'World instance not found'
  if (instance.world_key.trim() !== worldKey.trim()) return 'World instance not found'
  return null
}

function worldSummary(world: InteractiveWorldDoc) {
  return {
    _id: world._id,
    title: world.title,
    description: (world.description ?? world.chapter_title) || '',
    image_url: world.image_url ?? '',
    interactive_world_key: world.key,
    is_sentient: false,
    kind: 'world' as const,
  }
}

function instanceAsListRow(instance: InteractiveWorldInstanceDoc, world: InteractiveWorldDoc | null) {
  return {
    _id: instance._id,
    template_id: instance.world_id,
    world_id: instance.world_id,
    world_key: instance.world_key,
    player_id: instance.player_id,
    meta: {
      total_events: instance.meta.total_events,
      total_memories: instance.meta.total_memories,
      total_tokens_consumed: 0,
      last_active_at: instance.meta.last_active_at,
      is_archived: instance.meta.is_archived,
    },
    created_at: instance.created_at,
    updated_at: instance.updated_at,
    template: world ? worldSummary(world) : null,
  }
}

export const interactiveWorldInstanceService = {
  async getById(instanceId: string, playerId: string) {
    return instances().findOne({
      _id: parseObjectId(instanceId),
      player_id: parseObjectId(playerId),
    }) as Promise<InteractiveWorldInstanceDoc | null>
  },

  async requireBound(
    worldKey: string,
    instanceId: string,
    playerId: string,
  ): Promise<{ instance: InteractiveWorldInstanceDoc; world: InteractiveWorldDoc }> {
    const instance = (await this.getById(instanceId, playerId)) as InteractiveWorldInstanceDoc | null
    const closed = reasonWalkInstanceNotBound(worldKey, instance, playerId)
    if (closed || !instance) throw new HttpError(404, closed || 'World instance not found')
    const world = (await worlds().findOne({ _id: instance.world_id })) as InteractiveWorldDoc | null
    if (!world || world.key !== worldKey.trim()) throw new HttpError(404, 'World instance not found')
    return { instance, world }
  },

  async create(
    playerId: string,
    worldKey: string,
    tier: string,
  ): Promise<{ instance: InteractiveWorldInstanceDoc; world: InteractiveWorldDoc }> {
    const key = worldKey.trim()
    const world = (await worlds().findOne({ key })) as InteractiveWorldDoc | null
    if (!world) throw new HttpError(404, 'This world is not yet open to play.')
    const closed = reasonCannotStartWalk(world, playerId)
    if (closed) throw new HttpError(403, closed)

    await assertUnderSaveLimit(playerId, tier)

    const now = new Date()
    const instance: InteractiveWorldInstanceDoc = {
      _id: new ObjectId(),
      world_id: world._id,
      world_key: world.key,
      player_id: parseObjectId(playerId),
      meta: {
        total_events: 0,
        total_memories: 0,
        last_active_at: now,
        is_archived: false,
      },
      created_at: now,
      updated_at: now,
    }
    await instances().insertOne(instance)
    return { instance, world }
  },

  async resolve(
    worldKey: string,
    playerId: string,
    tier: string,
  ): Promise<{ instance_id: string }> {
    const key = worldKey.trim()
    if (!key) throw new HttpError(404, 'This world is not yet open to play.')

    const world = (await worlds().findOne({ key })) as InteractiveWorldDoc | null
    if (!world) throw new HttpError(404, 'This world is not yet open to play.')
    const closed = reasonCannotStartWalk(world, playerId)
    if (closed) throw new HttpError(403, closed)

    const playerOid = parseObjectId(playerId)
    const existing = await instances().findOne(
      {
        player_id: playerOid,
        world_id: world._id,
        'meta.is_archived': { $ne: true },
      },
      { sort: { 'meta.last_active_at': -1, created_at: -1 } },
    )
    if (existing) return { instance_id: idString(existing._id) }

    try {
      const { instance } = await this.create(playerId, key, tier)
      return { instance_id: idString(instance._id) }
    } catch (err) {
      if (err instanceof HttpError && /instance limit/i.test(err.message)) {
        throw new HttpError(403, 'You already walk as many worlds as your membership allows.')
      }
      throw err
    }
  },

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
    const pipeline: Record<string, unknown>[] = [
      { $match: filter },
      { $sort: { 'meta.last_active_at': -1, _id: -1 } },
      {
        $group: {
          _id: '$world_id',
          latest: { $first: '$$ROOT' },
          story_count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: COLLECTIONS.interactive_worlds,
          localField: '_id',
          foreignField: '_id',
          as: 'world',
        },
      },
      { $unwind: { path: '$world', preserveNullAndEmptyArrays: true } },
    ]
    if (term) {
      pipeline.push({
        $match: {
          $or: [
            { 'world.title': { $regex: term, $options: 'i' } },
            { 'world.description': { $regex: term, $options: 'i' } },
            { 'world.chapter_title': { $regex: term, $options: 'i' } },
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
          ],
          count: [{ $count: 'total' }],
        },
      },
    )
    const [result] = await instances().aggregate<{
      rows: Array<{
        _id: ObjectId
        latest: InteractiveWorldInstanceDoc
        story_count: number
        world: InteractiveWorldDoc | null
      }>
      count: Array<{ total: number }>
    }>(pipeline).toArray()

    const rows = result?.rows ?? []
    return {
      realms: rows.map((row) => {
        const world = row.world
        const latest = instanceAsListRow(row.latest, world)
        return {
          template_id: idString(row._id),
          story_count: row.story_count,
          template: world ? worldSummary(world) : null,
          latest,
        }
      }),
      total: result?.count?.[0]?.total ?? 0,
      page: safePage,
    }
  },

  async listByWorld(playerId: string, worldId: string) {
    const playerOid = parseObjectId(playerId)
    const worldOid = parseObjectId(worldId)
    const world = (await worlds().findOne({ _id: worldOid })) as InteractiveWorldDoc | null
    const found = (await instances()
      .find({
        player_id: playerOid,
        world_id: worldOid,
        'meta.is_archived': { $ne: true },
      })
      .sort({ 'meta.last_active_at': -1 })
      .toArray()) as InteractiveWorldInstanceDoc[]

    if (found.length === 0) {
      return { template: world ? worldSummary(world) : null, stories: [] }
    }

    const instanceIds = found.map((i) => i._id)
    const previewRows = await events()
      .aggregate<{ _id: ObjectId; preview: string }>([
        {
          $match: {
            instance_id: { $in: instanceIds },
            player_id: playerOid,
            type: 'interactive_world',
          },
        },
        { $sort: { sequence: -1 } },
        {
          $group: {
            _id: '$instance_id',
            preview: { $first: '$data.ai_response' },
          },
        },
      ])
      .toArray()
    const previewMap = new Map(previewRows.map((r) => [idString(r._id), r.preview || '']))

    const stories = found.map((inst, idx) => {
      const raw = previewMap.get(idString(inst._id)) || ''
      const preview = raw.length > 160 ? `${raw.slice(0, 157)}…` : raw
      return {
        ...instanceAsListRow(inst, world),
        preview,
        story_index: found.length - idx,
      }
    })

    return { template: world ? worldSummary(world) : null, stories }
  },

  async getPlayStatus(playerId: string, worldId: string) {
    const playerOid = parseObjectId(playerId)
    const worldOid = parseObjectId(worldId)
    const rows = await instances()
      .find({
        player_id: playerOid,
        world_id: worldOid,
        'meta.is_archived': { $ne: true },
      })
      .project({ _id: 1, 'meta.last_active_at': 1, 'meta.total_events': 1 })
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

  async archive(instanceId: string, playerId: string) {
    const iid = parseObjectId(instanceId)
    const pid = parseObjectId(playerId)
    const result = await instances().updateOne(
      { _id: iid, player_id: pid },
      { $set: { 'meta.is_archived': true, updated_at: new Date() } },
    )
    if (result.matchedCount === 0) throw new HttpError(404, 'Instance not found')
    const redis = getRedisClient()
    await redis.del(`session:${idString(iid)}`)
    return { success: true }
  },

  async touch(instanceId: ObjectId, now: Date, extra?: { events?: number; memories?: number }) {
    await instances().updateOne(
      { _id: instanceId },
      {
        $set: { 'meta.last_active_at': now, updated_at: now },
        $inc: {
          'meta.total_events': extra?.events ?? 0,
          ...(extra?.memories ? { 'meta.total_memories': extra.memories } : {}),
        },
      },
    )
  },
}
