import { env } from '../../config/env'
import { mongoColl } from '../../config/mongo'
import { getRedisClient } from '../../config/redis'
import { acquireGenerationTurn, generationLockKey, releaseGenerationLock } from '../../utils/generation-lock'
import { parseObjectId } from '../../utils/mongo-id'
import { HttpError } from '../../utils/http-error'
import { fcmSender, directNotification } from '../push/fcm'
import { loadGroupMembers } from './instance'
import { resolveGroupThread } from './threads'
import { eligibleDirectNotification, pickDirectSender, DIRECT_PENDING_MS } from './notification-policy'
import { notificationUsage, unpromptedTraceCaps, reserveUnpromptedCall, releaseUnpromptedCall, utcDay } from './notification-caps'
import type { GroupState } from './types'
import type { WorldInstanceDoc } from '../../models/world-instance.model'

export function pendingDirectFrom(state: GroupState, now: Date): string[] {
  const pending = state.pending_direct
  return pending && now.getTime() - pending.scheduled_at.getTime() < DIRECT_PENDING_MS ? [pending.member_id] : []
}

async function clearPending(instance: WorldInstanceDoc) {
  const pending = instance.group_state?.pending_direct
  if (pending) await mongoColl.worldInstances().updateOne({ _id: instance._id, player_id: instance.player_id,
    'group_state.pending_direct.member_id': pending.member_id, 'group_state.pending_direct.scheduled_at': pending.scheduled_at,
  }, { $unset: { 'group_state.pending_direct': '' } })
}

async function playerFence<T>(playerId: string, work: () => Promise<T>): Promise<T | undefined> {
  const redis = getRedisClient(), key = `lock:group-notifications:${playerId}`, owner = crypto.randomUUID()
  if (!await acquireGenerationTurn(redis, key, owner, false)) return undefined
  try { return await work() } finally { await releaseGenerationLock(redis, key, owner) }
}

export async function scheduleDirectNotifications(deps: {
  now?: () => Date; rng?: () => number; sender?: typeof fcmSender
} = {}) {
  if (!env.GROUP_NOTIFICATIONS_ENABLED) return
  const sender = deps.sender ?? fcmSender
  if (!sender.configured()) return
  const now = (deps.now ?? (() => new Date()))(), rng = deps.rng ?? Math.random
  const instances = await mongoColl.worldInstances().find({ group_state: { $exists: true }, is_archived: { $ne: true } }).toArray()
  for (const candidate of instances) await playerFence(String(candidate.player_id), async () => {
    if (!env.GROUP_NOTIFICATIONS_ENABLED) return
    const instance = await mongoColl.worldInstances().findOne({ _id: candidate._id, player_id: candidate.player_id })
    if (!instance?.group_state) return
    if (instance.group_state.pending_direct && !pendingDirectFrom(instance.group_state, now).length) {
      await clearPending(instance)
      delete instance.group_state.pending_direct
    }
    const playerId = String(instance.player_id)
    const player = await mongoColl.users().findOne({ _id: instance.player_id })
    if (!player || player.guest || player.account_status === 'banned') return
    const devices = await mongoColl.pushDevices().find({ player_id: instance.player_id }).toArray()
    const newest = devices.reduce<typeof devices[number] | undefined>((best, device) => !best || device.updated_at > best.updated_at ? device : best, undefined)
    const tz = newest?.tz_offset_minutes
    const usage = player.group_notification_usage?.day === utcDay(now) ? player.group_notification_usage : undefined
    const caps = await unpromptedTraceCaps(playerId, now)
    if (!eligibleDirectNotification({ enabled: env.GROUP_NOTIFICATIONS_ENABLED, hasDevice: devices.length > 0,
      optedOut: player.preferences?.group_notifications === false, state: { ...instance.group_state, tz_offset_minutes: tz }, now,
      sentToday: usage?.sent ?? 0, spendToday: caps.spend }) || rng() >= 0.25) return
    const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id })
    if (template?.kind !== 'group') return
    const member = pickDirectSender(await loadGroupMembers(instance), rng)
    if (!member) return
    // The same exclusive fence as an open/write prevents admission from stale activity.
    const redis = getRedisClient(), key = generationLockKey(playerId, String(instance._id)), owner = crypto.randomUUID()
    if (!await acquireGenerationTurn(redis, key, owner, false)) return
    try {
      const pending = { member_id: member.id, scheduled_at: now, notified_at: now }
      const claimed = await mongoColl.worldInstances().updateOne({ _id: instance._id, player_id: instance.player_id,
        'group_state.pending_direct': { $exists: false }, 'group_state.last_seen_at': instance.group_state.last_seen_at,
        'group_state.unprompted_since_player': instance.group_state.unprompted_since_player,
      }, { $set: { 'group_state.pending_direct': pending, 'group_state.last_direct_notified_at': now, 'group_state.tz_offset_minutes': tz }, $inc: { 'group_state.unprompted_since_player': 1 } })
      if (!claimed.modifiedCount) return
      instance.group_state.pending_direct = pending
      await notificationUsage(playerId, now)
      const allowance = await mongoColl.users().updateOne({ _id: instance.player_id, 'group_notification_usage.day': utcDay(now),
        'group_notification_usage.sent': { $lt: 3 },
      }, { $inc: { 'group_notification_usage.sent': 1 } })
      const payload = directNotification(template.title, member.name, String(instance._id), member.id)
      const results = allowance.modifiedCount ? await Promise.allSettled(devices.map(device => sender.send(device, payload))) : []
      if (!results.some(result => result.status === 'fulfilled' && result.value)) {
        await mongoColl.worldInstances().updateOne({ _id: instance._id, player_id: instance.player_id,
          'group_state.pending_direct.member_id': pending.member_id, 'group_state.pending_direct.scheduled_at': now,
        }, { $unset: { 'group_state.pending_direct': '', ...(instance.group_state.last_direct_notified_at ? {} : { 'group_state.last_direct_notified_at': '' }) },
          ...(instance.group_state.last_direct_notified_at ? { $set: { 'group_state.last_direct_notified_at': instance.group_state.last_direct_notified_at } } : {}),
          $inc: { 'group_state.unprompted_since_player': -1 } })
        if (allowance.modifiedCount) await mongoColl.users().updateOne({ _id: instance.player_id, 'group_notification_usage.day': utcDay(now) }, {
          $inc: { 'group_notification_usage.sent': -1 },
        })
        return
      }
    } finally { await releaseGenerationLock(redis, key, owner) }
  })
}

export async function openPendingDirect(instanceId: string, playerId: string, characterId: string, now = new Date()) {
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId), player_id: parseObjectId(playerId) })
  if (!instance?.group_state) throw new HttpError(404, 'That chat could not be found.')
  await resolveGroupThread(instance, characterId)
  if (!env.GROUP_NOTIFICATIONS_ENABLED) return { writing: false }
  const player = await mongoColl.users().findOne({ _id: instance.player_id })
  if (!player || player.guest || player.account_status === 'banned') throw new HttpError(403, 'Sign in to continue.')
  await mongoColl.worldInstances().updateOne({ _id: instance._id, player_id: instance.player_id }, {
    $max: { 'group_state.last_seen_at': now },
  })
  return await playerFence(playerId, async () => {
    const fresh = await mongoColl.worldInstances().findOne({ _id: instance._id, player_id: instance.player_id })
    if (!fresh?.group_state?.pending_direct || fresh.group_state.pending_direct.member_id !== characterId) return { writing: false }
    if (!pendingDirectFrom(fresh.group_state, now).length) { await clearPending(fresh); return { writing: false } }
    // Dispatch acquires the chat lock BEFORE consuming pending or the daily allowance.
    const { dispatchGroupTurn } = await import('./dispatch')
    try {
      const turnId = await dispatchGroupTurn({ instanceId, playerId, origin: 'unprompted', directWith: characterId, now,
        turnId: `direct-${instanceId}-${characterId}-${fresh.group_state.pending_direct.scheduled_at.getTime()}`,
        rollbackPending: async () => {
          await releaseUnpromptedCall(playerId, now)
          await mongoColl.worldInstances().updateOne({ _id: fresh._id, player_id: fresh.player_id,
            'group_state.pending_direct': { $exists: false },
          }, { $set: { 'group_state.pending_direct': fresh.group_state!.pending_direct! } })
        },
        claimPending: async () => {
          if (!await reserveUnpromptedCall(playerId, now)) { await clearPending(fresh); return false }
          const claimed = await mongoColl.worldInstances().updateOne({ _id: fresh._id, player_id: fresh.player_id,
            'group_state.pending_direct.member_id': characterId,
            'group_state.pending_direct.scheduled_at': fresh.group_state!.pending_direct!.scheduled_at,
          }, { $unset: { 'group_state.pending_direct': '' } })
          if (!claimed.modifiedCount) { await releaseUnpromptedCall(playerId, now); return false }
          return true
        },
      })
      return { writing: !!turnId }
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409) return { writing: false }
      throw error
    }
  }) ?? { writing: false }
}

/** Called before the player's direct writer; pending never becomes a second turn. */
export async function recordGroupPlayerWrite(instance: WorldInstanceDoc, directWith: string | undefined, now: Date) {
  const filter = { _id: instance._id, player_id: instance.player_id }
  await mongoColl.worldInstances().updateOne(filter, {
    $set: { 'group_state.unprompted_since_player': 0, 'group_state.last_seen_at': now },
  })
  if (directWith) await mongoColl.worldInstances().updateOne({ ...filter, 'group_state.pending_direct.member_id': directWith }, {
    $unset: { 'group_state.pending_direct': '' },
  })
  if (instance.group_state) {
    instance.group_state.unprompted_since_player = 0
    instance.group_state.last_seen_at = now
    if (instance.group_state.pending_direct?.member_id === directWith) delete instance.group_state.pending_direct
  }
}
