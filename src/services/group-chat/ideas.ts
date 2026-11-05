import { mongoColl } from '../../config/mongo'
import { parseObjectId } from '../../utils/mongo-id'
import type { GroupMember, GroupStatusLines, GroupStatusPeriod } from './types'

/** One short written message; the same ceiling applies to every idea and status. */
export const GROUP_IDEA_MAX_CHARS = 120
/** At most three survive validation, however many the writer returns. */
export const GROUP_IDEAS_MAX = 3

export const GROUP_STATUS_PERIODS: GroupStatusPeriod[] = ['morning', 'afternoon', 'evening', 'night']

/** The player's local hour, from the offset the newest device reported. */
export function statusPeriod(offsetMinutes: number, now = new Date()): GroupStatusPeriod {
  const hour = new Date(now.getTime() + offsetMinutes * 60_000).getUTCHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'night'
}

/** Picked fresh on every read; an unknown offset means no status at all. */
export function pickStatus(statuses: GroupStatusLines | undefined, offsetMinutes: number | undefined, now = new Date()): string | undefined {
  if (!statuses || typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes)) return undefined
  const line = statuses[statusPeriod(offsetMinutes, now)]
  return typeof line === 'string' && line.trim() ? line.trim() : undefined
}

/** A member's card as the player reads it: the picked status, and the written
 *  first texts while the thread is still empty. Nothing here is ever stored. */
export function withMemberReadings<T extends { canonical_name?: string }>(
  cards: T[],
  members: Pick<GroupMember, 'name' | 'first_texts' | 'statuses'>[],
  input: { offsetMinutes?: number; firstTexts: boolean; now?: Date },
): T[] {
  return cards.map(card => {
    const name = String(card.canonical_name || '').trim().toLowerCase()
    const member = members.find(entry => entry.name.trim().toLowerCase() === name)
    if (!member) return card
    const status = pickStatus(member.statuses, input.offsetMinutes, input.now)
    const firstTexts = input.firstTexts ? (member.first_texts || []).filter(text => typeof text === 'string' && text.trim()) : []
    return { ...card, ...(status ? { status } : {}), ...(firstTexts.length ? { first_texts: firstTexts } : {}) }
  })
}

/** The save keeps the newest device's zone here, so the writer's clock and the
 *  picked status agree. The reads that open a chat refresh it. */
export async function refreshGroupTimezone(playerId: string, now = new Date()): Promise<number | undefined> {
  const owner = parseObjectId(playerId)
  const devices = await mongoColl.pushDevices().find({ player_id: owner }).toArray()
  const newest = devices.reduce<(typeof devices)[number] | undefined>((best, device) =>
    !best || device.updated_at > best.updated_at ? device : best, undefined)
  const offset = newest?.tz_offset_minutes
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return undefined
  await mongoColl.worldInstances().updateMany({
    player_id: owner, group_state: { $exists: true }, 'group_state.tz_offset_minutes': { $ne: offset },
  }, { $set: { 'group_state.tz_offset_minutes': offset } })
  return offset
}
