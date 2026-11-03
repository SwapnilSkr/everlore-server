import { resolveGroupThread } from './threads'
import { mongoColl } from '../../config/mongo'
import { getRedisClient } from '../../config/redis'
import { getGenerationQueue, QUEUE_RETENTION } from '../../queues'
import { instanceService } from '../instance.service'
import { billingService } from '../billing.service'
import { requireIdentity } from '../guest-policy'
import { HttpError } from '../../utils/http-error'
import { parseObjectId } from '../../utils/mongo-id'
import { acquireGenerationTurn, generationLockKey, releaseGenerationLock } from '../../utils/generation-lock'

/** GC-2 owns admission policy (presence, timers and caps); this owns one turn. */
export async function dispatchGroupTurn(params: {
  instanceId: string; playerId: string; origin: 'unprompted' | 'catchup'; gapStart?: Date
  directWith?: string; turnId?: string; now?: Date; claimPending?: () => Promise<boolean>; rollbackPending?: () => Promise<void>
}) {
  const { instanceId, playerId, origin, gapStart } = params
  if (!['unprompted', 'catchup'].includes(origin)) throw new HttpError(400, 'Invalid chat turn')
  if (origin === 'catchup' && (!gapStart || !Number.isFinite(gapStart.getTime()) || gapStart.getTime() >= Date.now())) {
    throw new HttpError(400, 'A past catch-up start time is required.')
  }
  await requireIdentity(playerId)
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId), player_id: parseObjectId(playerId) })
  if (!instance?.group_state) throw new HttpError(404, 'That chat could not be found.')
  const directWith = await resolveGroupThread(instance, params.directWith)
  if (directWith && origin !== 'unprompted') throw new HttpError(400, 'That chat could not be found.')
  const session = await instanceService.loadSession(instanceId, playerId)
  if (session.kind !== 'group') throw new HttpError(400, 'That chat could not be found.')
  const redis = getRedisClient()
  const key = generationLockKey(playerId, instanceId)
  const turnId = params.turnId ?? crypto.randomUUID()
  if (!await acquireGenerationTurn(redis, key, turnId, directWith === undefined)) throw new HttpError(409, 'This chat is finishing a reply. Try again in a moment.')
  let claimed = false
  let reservation: string | null = null
  try {
    if (params.claimPending) {
      claimed = await params.claimPending()
      if (!claimed) { await releaseGenerationLock(redis, key, turnId); return undefined }
    }
    reservation = (await billingService.reserveGroupTurn(playerId, turnId)).reservation_id
    await getGenerationQueue().add('generate', { instanceId, playerId, origin, userMessage: '', session,
      ...(directWith ? { directWith, unpromptedCallReserved: claimed, unpromptedCallDay: (params.now ?? new Date()).toISOString().slice(0, 10) } : {}),
      ...(gapStart ? { gapStart: gapStart.toISOString() } : {}), billingReservationId: reservation, requestedAt: Date.now() }, {
      jobId: turnId, priority: 1, attempts: 1,
      removeOnComplete: QUEUE_RETENTION.generation.removeOnComplete, removeOnFail: QUEUE_RETENTION.generation.removeOnFail,
    })
    return turnId
  } catch (error) {
    try { if (claimed) await params.rollbackPending?.() } finally {
      await releaseGenerationLock(redis, key, turnId)
      await billingService.release(playerId, reservation)
    }
    throw error
  }
}
