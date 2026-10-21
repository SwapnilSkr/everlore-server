import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { log } from '../utils/logger'

export const LAST_ACTIVE_INTERVAL_MS = 5 * 60_000

export function lastActiveFilter(userId: ObjectId, now: Date) {
  return {
    _id: userId,
    $or: [
      { last_active_at: { $exists: false } },
      { last_active_at: { $lt: new Date(now.getTime() - LAST_ACTIVE_INTERVAL_MS) } },
    ],
  }
}

// Every authenticated request and socket frame lands here, so without a local
// memo each one costs a Mongo round trip even when the conditional update
// matches nothing. The memo only skips work; the conditional update stays the
// cross-process guard.
const lastWrittenAt = new Map<string, number>()
const MEMO_LIMIT = 50_000

/** The indexed conditional update is atomic across workers; requests never await it. */
export function recordLastActive(userId: string): void {
  const nowMs = Date.now()
  const previous = lastWrittenAt.get(userId)
  if (previous !== undefined && nowMs - previous < LAST_ACTIVE_INTERVAL_MS) return
  if (lastWrittenAt.size >= MEMO_LIMIT) lastWrittenAt.clear()
  lastWrittenAt.set(userId, nowMs)
  void (async () => {
    const now = new Date(nowMs)
    await mongoColl.users().updateOne(lastActiveFilter(new ObjectId(userId), now), {
      $set: { last_active_at: now },
    })
  })().catch(() => log.warn('last-active update failed', { userId }))
}
