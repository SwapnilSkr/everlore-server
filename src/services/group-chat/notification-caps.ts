import { mongoColl } from '../../config/mongo'
import { traceStore } from '../llm-trace.service'
import { parseObjectId } from '../../utils/mongo-id'

export const utcDay = (now: Date) => now.toISOString().slice(0, 10)

export async function unpromptedTraceCaps(playerId: string, now: Date) {
  const calls = await traceStore().calls.find({ group_origin: 'unprompted',
    created_at: { $gte: new Date(`${utcDay(now)}T00:00:00Z`), $lt: new Date(new Date(`${utcDay(now)}T00:00:00Z`).getTime() + 86_400_000) },
  }, { projection: { player_id: 1, purpose: 1, cost_usd: 1 } }).toArray()
  return { spend: calls.reduce((sum, call) => sum + Math.max(0, call.cost_usd ?? 0), 0),
    calls: calls.filter(call => String(call.player_id) === playerId && call.purpose === 'narration').length }
}

export async function notificationUsage(playerId: string, now: Date) {
  const _id = parseObjectId(playerId), day = utcDay(now)
  await mongoColl.users().updateOne({ _id, 'group_notification_usage.day': { $ne: day } }, {
    $set: { group_notification_usage: { day, sent: 0, calls: 0 } },
  })
  const player = await mongoColl.users().findOne({ _id })
  return player?.group_notification_usage
}

/** Reserves each transport attempt, including queued work not in the trace yet. */
export async function reserveUnpromptedCall(playerId: string, now: Date) {
  const caps = await unpromptedTraceCaps(playerId, now)
  if (!Number.isFinite(caps.spend) || caps.spend >= 5 || caps.calls >= 30) return false
  await notificationUsage(playerId, now)
  await mongoColl.users().updateOne({ _id: parseObjectId(playerId), 'group_notification_usage.day': utcDay(now) }, {
    $max: { 'group_notification_usage.calls': caps.calls },
  })
  const result = await mongoColl.users().updateOne({ _id: parseObjectId(playerId),
    'group_notification_usage.day': utcDay(now), 'group_notification_usage.calls': { $lt: 30 },
  }, { $inc: { 'group_notification_usage.calls': 1 } })
  return result.modifiedCount === 1
}

export async function releaseUnpromptedCall(playerId: string, now: Date) {
  await mongoColl.users().updateOne({ _id: parseObjectId(playerId), 'group_notification_usage.day': utcDay(now),
    'group_notification_usage.calls': { $gt: 0 } }, { $inc: { 'group_notification_usage.calls': -1 } })
}
