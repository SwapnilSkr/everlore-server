import { env } from '../../config/env'
import type { GroupState } from './types'
import { DIRECT_PENDING_MS } from './notification-policy'

/** Only plain documents are copied; dates and database ids keep their encoding. */
export function publicGroupData<T>(value: T, now = new Date()): T {
  if (Array.isArray(value)) return value.map(entry => publicGroupData(entry, now)) as T
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value
  const state = (value as { group_state?: GroupState }).group_state
  const pending = state?.pending_direct
  const extra = env.GROUP_NOTIFICATIONS_ENABLED && state ? { pending_from: pending && now.getTime() - new Date(pending.scheduled_at).getTime() < DIRECT_PENDING_MS ? [pending.member_id] : [] } : {}
  return { ...Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['dm_with', 'private_to', 'start_bond', 'intimacy', 'voice', 'wants', 'talkativeness', 'topics', 'group_state', 'group_state_after', 'group_context', 'group_template_id', 'cost', 'cost_usd', 'tame', 'scene_members', 'tame_members', 'pending_direct', 'scheduled_at', 'notified_at', 'last_direct_notified_at', 'group_notification_usage'].includes(key),
  ).map(([key, entry]) => [key, publicGroupData(entry, now)])), ...extra } as T
}
