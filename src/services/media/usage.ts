import { ObjectId, MongoServerError } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import type { MediaKind, MediaUsageDoc } from '../../models/media.model'
import { mediaLimit } from './config'
import { utcMediaDay } from './policy'

export const duplicateKey = (error: unknown) => error instanceof MongoServerError && error.code === 11000

/** Unique live slot ownership makes the cap atomic even without replica-set transactions. */
export async function reserveMedia(row: Pick<MediaUsageDoc, '_id' | 'player_id' | 'instance_id' | 'event_id' | 'kind'>, now = new Date()): Promise<boolean> {
  const { day } = utcMediaDay(now)
  const prior = await mongoColl.mediaUsage().findOne({ _id: row._id })
  if (prior) return prior.status !== 'released'
  const live = await mongoColl.mediaUsage().find({ player_id: row.player_id, kind: row.kind, day, status: { $in: ['reserved', 'settled'] } }).toArray()
  const limit = mediaLimit(row.kind)
  if (live.length >= limit) return false
  // Slots above a newly lowered limit still count against today's allowance.
  const ceiling = Math.max(0, limit - live.filter((entry) => (entry.slot ?? -1) >= limit).length)
  for (let slot = 0; slot < ceiling; slot++) {
    try {
      await mongoColl.mediaUsage().insertOne({ ...row, day, slot, status: 'reserved', created_at: now })
      return true
    } catch (error) {
      if (!duplicateKey(error)) throw error
      const current = await mongoColl.mediaUsage().findOne({ _id: row._id })
      if (current) return current.status !== 'released'
    }
  }
  return false
}
export async function settleMedia(id: ObjectId): Promise<void> {
  await mongoColl.mediaUsage().updateOne({ _id: id, status: 'reserved' }, { $set: { status: 'settled' } })
}
export async function releaseMedia(id: ObjectId): Promise<void> {
  await mongoColl.mediaUsage().updateOne({ _id: id, status: 'reserved' }, { $set: { status: 'released' }, $unset: { slot: '' } })
}
export async function mediaUsage(playerId: ObjectId, now = new Date()) {
  const { day, resets_at } = utcMediaDay(now)
  const result: Record<string, unknown> = { resets_at }
  for (const kind of ['voice', 'picture', 'video', 'portrait'] as MediaKind[]) {
    result[kind] = { used: await mongoColl.mediaUsage().countDocuments({ player_id: playerId, day, kind, status: { $in: ['reserved', 'settled'] } }), limit: mediaLimit(kind) }
  }
  return result
}
