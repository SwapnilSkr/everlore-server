import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'

export const TIER_LIMITS: Record<string, { max_instances: number; max_memories: number }> = {
  free: { max_instances: 3, max_memories: 100 },
  premium: { max_instances: 20, max_memories: 500 },
  creator: { max_instances: 50, max_memories: 1000 },
}

/** Active chat realms plus active walks — one cap so splitting collections does not grant extra saves. */
export async function countActiveSaves(playerId: ObjectId): Promise<number> {
  const filter = { player_id: playerId, 'meta.is_archived': { $ne: true } }
  const [chat, walks] = await Promise.all([
    mongoColl.worldInstances().countDocuments(filter),
    mongoColl.interactiveWorldInstances().countDocuments(filter),
  ])
  return chat + walks
}

export async function assertUnderSaveLimit(playerId: string, tier: string): Promise<void> {
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.free
  const count = await countActiveSaves(parseObjectId(playerId))
  if (count >= limits.max_instances) {
    throw new HttpError(403, `Instance limit reached (${limits.max_instances})`)
  }
}
