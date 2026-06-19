import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { ProjectionCheckpointChunkKind } from '../models/projection-checkpoint.model'
import { idString, parseObjectId } from '../utils/mongo-id'

const CHUNK_SIZE = 400
const KEEP_CHECKPOINTS = 6

const checkpoints = () => mongoColl.projectionCheckpoints()
const chunks = () => mongoColl.projectionCheckpointChunks()

function cloneForSnapshot<T>(doc: T): T {
  // BSON values (ObjectId/Date) survive as objects in memory; this shallow clone
  // strips driver prototypes only where the document carries extra methods.
  return { ...(doc as Record<string, unknown>) } as T
}

async function writeChunks(params: {
  checkpointId: ObjectId
  instanceId: ObjectId
  sequence: number
  kind: ProjectionCheckpointChunkKind
  docs: unknown[]
}) {
  const { checkpointId, instanceId, sequence, kind, docs } = params
  if (!docs.length) return
  const now = new Date()
  const rows = []
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    rows.push({
      _id: new ObjectId(),
      checkpoint_id: checkpointId,
      instance_id: instanceId,
      sequence,
      kind,
      index: Math.floor(i / CHUNK_SIZE),
      docs: docs.slice(i, i + CHUNK_SIZE),
      created_at: now,
    })
  }
  if (rows.length) await chunks().insertMany(rows as never[])
}

async function readChunkDocs<T>(checkpointId: ObjectId, kind: ProjectionCheckpointChunkKind): Promise<T[]> {
  const rows = await chunks()
    .find({ checkpoint_id: checkpointId, kind })
    .sort({ index: 1 })
    .toArray()
  return rows.flatMap((r) => (Array.isArray(r.docs) ? r.docs : [])) as T[]
}

export const projectionCheckpointService = {
  async latestBefore(instanceId: string, beforeOrAtSequence: number) {
    return checkpoints().findOne(
      {
        instance_id: parseObjectId(instanceId),
        kind: 'world_projection',
        status: 'active',
        sequence: { $lte: beforeOrAtSequence },
      },
      { sort: { sequence: -1 } },
    )
  },

  async create(instanceId: string, opts: { playerId?: string; sequence?: number } = {}) {
    const iid = parseObjectId(instanceId)
    const instance = await mongoColl.worldInstances().findOne({ _id: iid })
    if (!instance) throw new Error('Instance not found')
    if (opts.playerId && idString(instance.player_id) !== opts.playerId) {
      throw new Error('Instance not found')
    }
    const latest = opts.sequence ?? (await mongoColl.events().findOne(
      { instance_id: iid, type: { $ne: 'side_chat' } },
      { sort: { sequence: -1 }, projection: { sequence: 1 } },
    ))?.sequence ?? 0
    if (latest <= 0) return { created: false, reason: 'no_events', sequence: latest }

    const existing = await checkpoints().findOne({
      instance_id: iid,
      kind: 'world_projection',
      sequence: latest,
    })
    if (existing?.status === 'active') {
      return { created: false, reason: 'exists', sequence: latest, checkpointId: idString(existing._id) }
    }
    if (existing) {
      await chunks().deleteMany({ checkpoint_id: existing._id })
      await checkpoints().deleteOne({ _id: existing._id })
    }

    const checkpointId = new ObjectId()
    const now = new Date()
    await checkpoints().insertOne({
      _id: checkpointId,
      instance_id: iid,
      player_id: instance.player_id,
      sequence: latest,
      kind: 'world_projection',
      status: 'building',
      counts: { characters: 0, entities: 0, entity_edges: 0 },
      created_at: now,
    } as never)

    try {
      const [characters, entities, entityEdges] = await Promise.all([
        mongoColl.characters().find({ instance_id: iid }).toArray(),
        mongoColl.entities().find({ instance_id: iid }).toArray(),
        mongoColl.entityEdges().find({ instance_id: iid }).toArray(),
      ])
      await writeChunks({
        checkpointId,
        instanceId: iid,
        sequence: latest,
        kind: 'world_instance',
        docs: [cloneForSnapshot(instance)],
      })
      await writeChunks({
        checkpointId,
        instanceId: iid,
        sequence: latest,
        kind: 'characters',
        docs: characters.map(cloneForSnapshot),
      })
      await writeChunks({
        checkpointId,
        instanceId: iid,
        sequence: latest,
        kind: 'entities',
        docs: entities.map(cloneForSnapshot),
      })
      await writeChunks({
        checkpointId,
        instanceId: iid,
        sequence: latest,
        kind: 'entity_edges',
        docs: entityEdges.map(cloneForSnapshot),
      })
      await checkpoints().updateOne(
        { _id: checkpointId },
        {
          $set: {
            status: 'active',
            counts: {
              characters: characters.length,
              entities: entities.length,
              entity_edges: entityEdges.length,
            },
            completed_at: new Date(),
          },
        },
      )
      await this.pruneOld(instanceId)
      return { created: true, sequence: latest, checkpointId: idString(checkpointId) }
    } catch (err) {
      await checkpoints().updateOne(
        { _id: checkpointId },
        { $set: { status: 'failed', error: (err as Error).message, completed_at: new Date() } },
      )
      throw err
    }
  },

  async restoreCodexAndKinship(checkpointId: ObjectId) {
    const checkpoint = await checkpoints().findOne({ _id: checkpointId, status: 'active' })
    if (!checkpoint) throw new Error('Projection checkpoint not found')
    const iid = checkpoint.instance_id
    const [characters, edges] = await Promise.all([
      readChunkDocs<any>(checkpointId, 'characters'),
      readChunkDocs<any>(checkpointId, 'entity_edges'),
    ])
    const kinshipEdges = edges.filter((edge) => edge?.type === 'kinship')

    await mongoColl.characters().deleteMany({ instance_id: iid })
    if (characters.length) {
      await mongoColl.characters().insertMany(characters as never[], { ordered: false }).catch(async (err) => {
        await mongoColl.characters().deleteMany({ instance_id: iid })
        throw err
      })
    }

    await mongoColl.entityEdges().deleteMany({ instance_id: iid, type: 'kinship' })
    if (kinshipEdges.length) {
      await mongoColl.entityEdges().insertMany(kinshipEdges as never[], { ordered: false }).catch(async (err) => {
        await mongoColl.entityEdges().deleteMany({ instance_id: iid, type: 'kinship' })
        throw err
      })
    }
    return { sequence: checkpoint.sequence, characters: characters.length, kinshipEdges: kinshipEdges.length }
  },

  async pruneOld(instanceId: string) {
    const iid = parseObjectId(instanceId)
    const old = await checkpoints()
      .find({ instance_id: iid, kind: 'world_projection', status: 'active' })
      .sort({ sequence: -1 })
      .skip(KEEP_CHECKPOINTS)
      .toArray()
    if (!old.length) return { pruned: 0 }
    const ids = old.map((c) => c._id)
    await chunks().deleteMany({ checkpoint_id: { $in: ids } })
    await checkpoints().deleteMany({ _id: { $in: ids } })
    return { pruned: ids.length }
  },
}
