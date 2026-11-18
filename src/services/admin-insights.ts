import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import { reviewerAccounts, type ReviewersMode } from './reviewer-accounts'
import type { EffectiveBilling } from './billing-config.service'

/**
 * Shared building blocks for the console's read-only insight aggregates
 * (`everlore-docs/phases/admin-insights.md`, part 1).
 *
 * Nothing here writes. Every figure is derived from what the server already
 * stored, review accounts are left out unless an operator asks for them, and
 * every `generation_logs` read is bounded by a `created_at` window and matched
 * on the ids the caller is asking about.
 */

export const DAY_MS = 86_400_000
export const DAYS_30 = 30

/** The official account is the user named `Everlore` (as the catalog seed finds it). */
const OFFICIAL_USERNAME = 'everlore'

export type PersonGender = 'male' | 'female' | 'nonbinary'

export type PersonRef = {
  id: string
  /** `preferences.player_name`, else the username. */
  name: string
  username: string
  official: boolean
  reviewer: boolean
  gender: PersonGender | null
}

export type UserRow = {
  _id: ObjectId
  username?: string
  guest?: boolean
  reviewer?: true
  providers?: string[]
  preferences?: {
    player_name?: string
    gender?: string
    interests?: string[]
    nsfw_enabled?: boolean
  }
}

/** The stored gender vocabulary is `non_binary`; the contract reads `nonbinary`. */
export function personGender(value: unknown): PersonGender | null {
  if (value === 'male' || value === 'female') return value
  if (value === 'non_binary') return 'nonbinary'
  return null
}

export function isOfficialUsername(username: unknown): boolean {
  return typeof username === 'string' && username.toLowerCase() === OFFICIAL_USERNAME
}

/** A user row as the console links it. Callers project only the fields used here. */
export function personRef(row: UserRow): PersonRef {
  const username = row.username ?? ''
  return {
    id: idString(row._id),
    name: row.preferences?.player_name || username,
    username,
    official: isOfficialUsername(username),
    reviewer: row.reviewer === true,
    gender: personGender(row.preferences?.gender),
  }
}

export async function officialUserId(): Promise<ObjectId | null> {
  const row = await mongoColl.users().findOne(
    { username: { $regex: `^${OFFICIAL_USERNAME}$`, $options: 'i' } },
    { projection: { _id: 1 } },
  )
  return row?._id ?? null
}

/** Resolve a set of creator/player ids to refs in one read; gone accounts are absent. */
export async function personRefsByIds(ids: ObjectId[]): Promise<Map<string, PersonRef>> {
  const unique = [...new Map(ids.map((id) => [idString(id), id])).values()]
  if (unique.length === 0) return new Map()
  const rows = await mongoColl.users()
    .find(
      { _id: { $in: unique } },
      { projection: { username: 1, 'preferences.player_name': 1, 'preferences.gender': 1, reviewer: 1 } },
    )
    .toArray()
  return new Map(rows.map((row) => [idString(row._id), personRef(row as UserRow)]))
}

/**
 * The saves an aggregate may count.
 *
 * `exclude` (the default) drops reviewer accounts' saves, `only` keeps just
 * theirs, and `include` counts everyone. Returned as the `player_id` match so it
 * composes with a template filter instead of replacing it.
 */
export async function playerScope(mode: ReviewersMode = 'exclude'): Promise<Record<string, unknown>> {
  if (mode === 'include') return {}
  const { userIds } = await reviewerAccounts.scope()
  if (mode === 'only') return { player_id: { $in: userIds } }
  return userIds.length > 0 ? { player_id: { $nin: userIds } } : {}
}

/** The `days` UTC days ending today, oldest first. */
export function daySeries(days: number, now: Date = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, index) =>
    new Date(today - (days - index - 1) * DAY_MS).toISOString().slice(0, 10))
}

/** The instant the oldest day in a `days` series began, UTC. */
export function windowStart(days: number, now: Date = new Date()): Date {
  return new Date(`${daySeries(days, now)[0]}T00:00:00.000Z`)
}

/** UTC `YYYY-MM-DD` of an instant, as Mongo's `$dateToString` writes it. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

export const dayExpression = { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'UTC' } }

/** A save's lifetime turns. `meta.total_events` is the only cumulative counter. */
export function saveTurns(meta: { total_events?: number } | null | undefined): number {
  const value = meta?.total_events
  return typeof value === 'number' && value > 0 ? value : 0
}

/** A save's last activity, if it ever had one. */
export function saveLastActive(meta: { last_active_at?: Date } | null | undefined): Date | null {
  return meta?.last_active_at instanceof Date ? meta.last_active_at : null
}

/** The cover a card shows: the small WebP, then the full image, then nothing. */
export function coverUrl(template: { image_thumb_url?: string; image_url?: string }): string | null {
  return template.image_thumb_url || template.image_url || null
}

/**
 * What a set of story turns and media items would have cost in Ink at the
 * catalog prices.
 *
 * One function, so the promo's "would have cost" and a metered account's
 * conversion use exactly the same arithmetic. Media is priced by the single
 * per-image price the catalog defines; there is no other media price to use.
 */
export function inkEquivalent(
  input: { turns: number; media: number },
  costs: EffectiveBilling['costs'],
): number {
  return input.turns * costs.story_turn + input.media * costs.image_preview
}

/** Round money to a stable number of decimals so a sum is not 0.30000000000004. */
export function money(value: number): number {
  return Number((value || 0).toFixed(6))
}

/** Sort a `Map` built from a grouped aggregate by hex id. */
export function mapById<T>(rows: Array<{ _id: unknown } & T>): Map<string, T> {
  return new Map(rows.map((row) => [idString(row._id), row]))
}
