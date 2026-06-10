import { ObjectId, type Document } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { UserTier } from '../models/user.model'
import { memoryProjectionStatus } from '../models/projection.model'
import { idString, parseObjectId } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { deletionService } from './deletion.service'
import { isDefaultCoverUrl, resolveTemplateImageUrl } from '../constants/default-cover'
import { storageService } from './storage.service'
import { deletePineconeVector } from './pinecone-cleanup.service'

export type AdminUserTier = 'free' | 'premium' | 'creator'

const users = () => mongoColl.users()
const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const events = () => mongoColl.events()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()
const sceneSummaries = () => mongoColl.sceneSummaries()
const generationLogs = () => mongoColl.generationLogs()

const BLOCKED_UPDATE_KEYS = new Set(['_id', 'created_at', 'password_hash', 'google_sub', 'providers'])

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
    const [
      totalUsers,
      totalWorlds,
      publishedWorlds,
      totalInstances,
      totalEvents,
      totalMemories,
      totalCharacters,
    ] = await Promise.all([
      users().countDocuments({}),
      worldTemplates().countDocuments({}),
      worldTemplates().countDocuments({ is_published: true }),
      worldInstances().countDocuments({}),
      events().countDocuments({}),
      memories().countDocuments({}),
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

  async listUsers(opts: { page?: number; limit?: number; search?: string }) {
    const filter: Record<string, unknown> = {}
    if (opts.search) {
      filter.$or = [
        { username: { $regex: opts.search, $options: 'i' } },
        { email: { $regex: opts.search, $options: 'i' } },
        { phone: { $regex: opts.search, $options: 'i' } },
      ]
    }
    return listCollection(users(), filter, { created_at: -1 }, opts)
  },

  async getUser(userId: string) {
    const user = await users().findOne({ _id: parseObjectId(userId) }, { projection: { password_hash: 0 } })
    if (!user) throw new HttpError(404, 'User not found')

    const uid = parseObjectId(userId)
    const [instances, createdWorlds, eventsCount, memoriesCount] = await Promise.all([
      worldInstances().countDocuments({ player_id: uid }),
      worldTemplates().countDocuments({ creator_id: uid }),
      events().countDocuments({ player_id: uid }),
      memories().countDocuments({ player_id: uid }),
    ])

    return {
      user: serialize(user),
      counts: {
        own_instances: instances,
        created_worlds: createdWorlds,
        events: eventsCount,
        memories: memoriesCount,
      },
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

  async setUserTier(userId: string, tier: AdminUserTier) {
    return this.updateUser(userId, { tier })
  },

  async deleteUser(userId: string) {
    return deletionService.deleteAccount(userId)
  },

  async listWorlds(opts: { page?: number; limit?: number; search?: string; creator_id?: string; published?: boolean }) {
    const filter: Record<string, unknown> = { ...idFilter('creator_id', opts.creator_id) }
    if (opts.published !== undefined) filter.is_published = opts.published
    if (opts.search) {
      filter.$or = [
        { title: { $regex: opts.search, $options: 'i' } },
        { slug: { $regex: opts.search, $options: 'i' } },
        { description: { $regex: opts.search, $options: 'i' } },
      ]
    }
    return listCollection(worldTemplates(), filter, { created_at: -1 }, opts)
  },

  async getWorld(templateId: string) {
    const tid = parseObjectId(templateId)
    const template = await worldTemplates().findOne({ _id: tid })
    if (!template) throw new HttpError(404, 'World not found')
    const [instances, eventsCount, memoriesCount] = await Promise.all([
      worldInstances().countDocuments({ template_id: tid }),
      events()
        .aggregate([{ $lookup: { from: 'world_instances', localField: 'instance_id', foreignField: '_id', as: 'i' } }, { $match: { 'i.template_id': tid } }, { $count: 'count' }])
        .toArray(),
      memories()
        .aggregate([{ $lookup: { from: 'world_instances', localField: 'instance_id', foreignField: '_id', as: 'i' } }, { $match: { 'i.template_id': tid } }, { $count: 'count' }])
        .toArray(),
    ])
    return {
      world: serialize(template),
      counts: {
        instances,
        events: Number(eventsCount[0]?.count || 0),
        memories: Number(memoriesCount[0]?.count || 0),
      },
    }
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

  async getInstance(instanceId: string) {
    const iid = parseObjectId(instanceId)
    const instance = await worldInstances().findOne({ _id: iid })
    if (!instance) throw new HttpError(404, 'Instance not found')
    const [eventsCount, memoriesCount, charactersCount, summariesCount, logsCount] = await Promise.all([
      events().countDocuments({ instance_id: iid }),
      memories().countDocuments({ instance_id: iid }),
      characters().countDocuments({ instance_id: iid }),
      sceneSummaries().countDocuments({ instance_id: iid }),
      generationLogs().countDocuments({ instance_id: iid }),
    ])
    return {
      instance: serialize(instance),
      counts: {
        events: eventsCount,
        memories: memoriesCount,
        characters: charactersCount,
        scene_summaries: summariesCount,
        generation_logs: logsCount,
      },
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
          await deletePineconeVector(`mem_${idString(memory.instance_id)}`, memory.pinecone_id)
        } catch {
          // best-effort vector cleanup; Mongo deletion still proceeds
        }
      }
    }
    if (mems.length > 0) await memories().deleteMany({ _id: { $in: mems.map((m) => m._id) } })
    await generationLogs().deleteMany({ instance_id: event.instance_id, sequence: event.sequence })
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
      await deletePineconeVector(`mem_${idString(memory.instance_id)}`, memory.pinecone_id)
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
          ...edges.flatMap((e) => [e.source_entity_id, e.target_entity_id]),
        ].map((id) => [idString(id), id] as const),
      ).values(),
    ]
    const ents = entityIds.length
      ? await mongoColl.entities().find({ _id: { $in: entityIds } }).toArray()
      : []

    return {
      event: serialize({
        _id: event._id,
        instance_id: event.instance_id,
        sequence: event.sequence,
        type: event.type,
        scene_tag: event.scene_tag,
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
          unresolved_thread: m.unresolved_thread === true,
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
