import { getRedisClient } from '../config/redis'
import { mongoColl } from '../config/mongo'
import { parseObjectId } from '../utils/mongo-id'

// A request cannot begin guest writes between the transfer's fence and drain.
// Expiring members let a crashed HTTP process stop blocking recovery.
const key = (id: string) => `guest:requests:${id}`
const closingKey = (id: string) => `guest:transfer:${id}`
export async function beginGuestRequest(id: string, background = false): Promise<string | null> {
  const redis = getRedisClient()
  const lease = crypto.randomUUID()
  const admitted = await redis.eval(`
    if redis.call('exists', KEYS[2]) == 1 then return 0 end
    redis.call('zadd', KEYS[1], ARGV[1], ARGV[2])
    return 1`, 2, key(id), closingKey(id), Date.now() + 15 * 60_000, lease)
  if (!admitted) return null
  const row = await mongoColl.users().findOne({ _id: parseObjectId(id), guest: true,
    ...(!background ? { guest_merge_target: { $exists: false } } : {}), guest_purging: { $ne: true } })
  if (!row) { await redis.zrem(key(id), lease); return null }
  return lease
}
export async function endGuestRequest(id: string, lease: string): Promise<void> {
  await getRedisClient().zrem(key(id), lease)
}
export async function hasGuestRequests(id: string): Promise<boolean> {
  const redis = getRedisClient()
  await redis.zremrangebyscore(key(id), '-inf', Date.now())
  return (await redis.zcard(key(id))) > 0
}

/** Atomically close admission only after every in-flight writer has drained. */
export async function closeGuestRequests(id: string): Promise<string | null> {
  const owner = crypto.randomUUID()
  const closed = await getRedisClient().eval(`
    redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
    if redis.call('zcard', KEYS[1]) > 0 then return 0 end
    if not redis.call('set', KEYS[2], ARGV[2], 'NX', 'EX', 900) then return 0 end
    return 1`, 2, key(id), closingKey(id), Date.now(), owner)
  return closed ? owner : null
}
export async function reopenGuestRequests(id: string, owner: string): Promise<void> {
  await getRedisClient().eval(`
    if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
    return 0`, 1, closingKey(id), owner)
}
