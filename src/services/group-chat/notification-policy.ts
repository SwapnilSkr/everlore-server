import type { GroupMember, GroupState } from './types'

const HOUR = 60 * 60 * 1000
export const DIRECT_PENDING_MS = 48 * HOUR
export interface NotificationEligibility {
  enabled: boolean; hasDevice: boolean; optedOut: boolean; now: Date
  state: GroupState; sentToday: number; spendToday: number
}

/** The scheduler has one admission policy; I/O only supplies its facts. */
export function eligibleDirectNotification(input: NotificationEligibility): boolean {
  const { state, now } = input
  const gap = now.getTime() - (state.last_seen_at?.getTime() ?? NaN)
  const offset = state.tz_offset_minutes
  const hour = offset === undefined ? NaN : new Date(now.getTime() + offset * 60_000).getUTCHours()
  return input.enabled && input.hasDevice && !input.optedOut && Number.isFinite(gap) &&
    gap >= 3 * HOUR && gap <= 14 * 24 * HOUR && Number.isFinite(offset) && Math.abs(offset!) <= 14 * 60 &&
    hour >= 9 && hour < 22 && !state.pending_direct &&
    (!state.last_direct_notified_at || now.getTime() - state.last_direct_notified_at.getTime() >= 12 * HOUR) &&
    state.unprompted_since_player < 2 && input.sentToday < 3 && Number.isFinite(input.spendToday) && input.spendToday < 5
}

export function pickDirectSender(members: GroupMember[], rng: () => number): GroupMember | undefined {
  const candidates = members.filter(member => (member.relationship?.fear ?? 0) < 70)
  const weight = (member: GroupMember) => Math.max(1, (member.relationship?.trust ?? 0) + (member.relationship?.affection ?? 0))
  let roll = rng() * candidates.reduce((sum, member) => sum + weight(member), 0)
  for (const member of candidates) { roll -= weight(member); if (roll < 0) return member }
  return undefined
}
