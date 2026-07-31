import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getMaintenanceQueue, getMemoryCurationQueue, getSceneSummaryQueue, QUEUE_RETENTION } from '../queues'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { PostProcessKind } from '../models/post-process-outbox.model'

export async function stagePostProcess(params: {
  instanceId: string
  playerId: string
  eventId: string
  kind: PostProcessKind
  payload: Record<string, unknown>
}) {
  const now = new Date()
  await mongoColl.postProcessOutbox().updateOne(
    { event_id: parseObjectId(params.eventId), kind: params.kind },
    {
      $setOnInsert: {
        _id: new ObjectId(),
        instance_id: parseObjectId(params.instanceId),
        player_id: parseObjectId(params.playerId),
        event_id: parseObjectId(params.eventId),
        kind: params.kind,
        payload: params.payload,
        status: 'pending',
        dispatch_attempts: 0,
        next_attempt_at: now,
        created_at: now,
        updated_at: now,
      },
    },
    { upsert: true },
  )
}

export async function dispatchPostProcessOutbox(limit = 50) {
  const now = new Date()
  const rows = await mongoColl.postProcessOutbox()
    .find({ status: 'pending', next_attempt_at: { $lte: now } })
    .sort({ created_at: 1 })
    .limit(limit)
    .toArray()

  let dispatched = 0
  for (const row of rows) {
    const claimed = await mongoColl.postProcessOutbox().findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { status: 'dispatched', dispatched_at: now, updated_at: now }, $inc: { dispatch_attempts: 1 } },
      { returnDocument: 'after' },
    )
    if (!claimed) continue
    try {
      const eventId = idString(row.event_id)
      if (row.kind === 'memory_curation') {
        await getMemoryCurationQueue().add('curate', row.payload, {
          jobId: `memory-curation-${eventId}`, priority: 5, attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: QUEUE_RETENTION.memoryCuration.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.memoryCuration.removeOnFail,
        })
      } else if (row.kind === 'scene_summary') {
        await getSceneSummaryQueue().add('summarize', row.payload, {
          jobId: `scene-summary-${eventId}`, priority: 10, attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: QUEUE_RETENTION.sceneSummary.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.sceneSummary.removeOnFail,
        })
      } else {
        const task = row.kind === 'projection_checkpoint' ? 'create_projection_checkpoint' : row.kind
        await getMaintenanceQueue().add('post-process', { task, ...row.payload }, {
          jobId: `${row.kind}-${eventId}`, priority: 20,
          ...(row.kind === 'character_projection' ? { delay: 90_000 } : {}),
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
          removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
        })
      }
      await mongoColl.postProcessOutbox().updateOne(
        { _id: row._id }, { $set: { status: 'completed', completed_at: new Date(), updated_at: new Date() } },
      )
      dispatched++
    } catch (err) {
      const attempts = row.dispatch_attempts + 1
      await mongoColl.postProcessOutbox().updateOne(
        { _id: row._id },
        { $set: { status: 'pending', last_error: (err as Error).message, next_attempt_at: new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempts)), updated_at: new Date() } },
      )
    }
  }
  return { dispatched, scanned: rows.length }
}
