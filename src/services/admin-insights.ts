import type { Collection, ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import { HttpError } from '../utils/http-error'
import { reviewerAccounts, type ReviewersMode } from './reviewer-accounts'
import type { EffectiveBilling } from './billing-config.service'
import { STORY_TURN_TYPES } from './admin-activity'
import { traceStore } from './llm-trace.service'
import type { LLMCallDoc } from '../models/llm-call.model'

/**
 * Shared building blocks for the console's read-only insight aggregates
 * (`everlore-docs/phases/admin-insights.md`, parts 1 and 2).
 *
 * Nothing here writes. Every figure is derived from what the server already
 * stored, review accounts are left out unless an operator asks for them, and
 * every `events`/`llm_calls`/`app_sessions` read is bounded by its date field
 * and matched on the ids the caller is asking about.
 *
 * Story turns come from `events` (solo and group chat both write them) and model
 * cost from `llm_calls` (every priced call, background ones included).
 * `generation_logs` is no longer read here: it only ever saw solo turns.
 */

export const DAY_MS = 86_400_000
export const DAYS_30 = 30

/** The `days` values the console offers; anything else is a 400 sentence. */
export const INSIGHT_DAYS = [7, 30, 90] as const
export type InsightDays = (typeof INSIGHT_DAYS)[number]

export function insightDays(value?: string): InsightDays {
  if (value === undefined || value === '') return 30
  const days = Number(value)
  if (!INSIGHT_DAYS.includes(days as InsightDays)) {
    throw new HttpError(400, 'Days must be 7, 30 or 90.')
  }
  return days as InsightDays
}

/** Story turns are the event kinds the Overview counts; solo and group alike. */
export function storyTurnMatch(): Record<string, unknown> {
  return { type: { $in: STORY_TURN_TYPES } }
}

/**
 * Which of `instanceIds` are group chats.
 *
 * A group turn reserves 0 Ink (`billing.service.ts` `reserveGroupTurn`), so an
 * Ink equivalent prices solo turns only. Callers pass the saves active in their
 * window, so this read is bounded by the window, not by the collection.
 */
export async function groupSaveSet(instanceIds: ObjectId[]): Promise<Set<string>> {
  const unique = [...new Map(instanceIds.map((id) => [idString(id), id])).values()]
  if (unique.length === 0) return new Set()
  const rows = await mongoColl.worldInstances()
    .find(
      { _id: { $in: unique }, group_template_id: { $exists: true } },
      { projection: { _id: 1 } },
    )
    .toArray()
  return new Set(rows.map((row) => idString(row._id)))
}

export const events = () => mongoColl.events()
export const calls = (): Collection<LLMCallDoc> => traceStore().calls

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
  /** A review account and a team account are both left out by default. */
  internal: boolean
  internal_reason: string | null
  gender: PersonGender | null
}

export type UserRow = {
  _id: ObjectId
  username?: string
  guest?: boolean
  reviewer?: true
  internal?: true
  internal_reason?: string
  providers?: string[]
  /** ISO 3166-1 alpha-2 of the last connection, absent until one is known. */
  country?: string
  /** Country guessed from a locale or a phone, for players seen before capture. */
  country_hint?: { code: string; source: 'locale' | 'phone' }
  preferences?: {
    player_name?: string
    gender?: string
    interests?: string[]
    nsfw_enabled?: boolean
  }
}

/** Where the country the console prints came from. */
export type CountrySource = 'connection' | 'phone' | 'phone_setting' | null

/**
 * The country to show for an account, and where it came from.
 *
 * A captured connection country always wins and is never replaced by a hint.
 * With none, the stored hint fills the gap: a phone region is "phone", a locale
 * region is "phone_setting" (the app's own setting, not the network).
 */
export function countryOfUser(user: {
  country?: string
  country_hint?: { code?: string; source?: 'locale' | 'phone' }
}): { country: string | null; source: CountrySource } {
  const captured = typeof user.country === 'string' ? user.country.trim().toUpperCase() : ''
  if (captured) return { country: captured, source: 'connection' }
  const hinted = typeof user.country_hint?.code === 'string' ? user.country_hint.code.trim().toUpperCase() : ''
  if (!hinted) return { country: null, source: null }
  return { country: hinted, source: user.country_hint?.source === 'phone' ? 'phone' : 'phone_setting' }
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
    internal: row.internal === true,
    internal_reason: typeof row.internal_reason === 'string' ? row.internal_reason : null,
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
      { projection: { username: 1, 'preferences.player_name': 1, 'preferences.gender': 1, reviewer: 1, internal: 1, internal_reason: 1 } },
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

/** The same day expression over another date field (`started_at`, `last_at`). */
export function dayExpressionOn(field: string) {
  return { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: 'UTC' } }
}

/** The Monday that begins `date`'s UTC week, `YYYY-MM-DD`. */
export function mondayOf(date: Date): string {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  // getUTCDay: 0 is Sunday, so a Sunday belongs to the week that began six days before.
  const offset = (new Date(day).getUTCDay() + 6) % 7
  return new Date(day - offset * DAY_MS).toISOString().slice(0, 10)
}

/** The `weeks` Mondays ending with the one `now` falls in, oldest first. */
export function mondaySeries(weeks: number, now: Date = new Date()): string[] {
  const current = new Date(`${mondayOf(now)}T00:00:00.000Z`).getTime()
  return Array.from({ length: weeks }, (_, index) =>
    new Date(current - (weeks - index - 1) * 7 * DAY_MS).toISOString().slice(0, 10))
}

/**
 * The `app_sessions` filter that leaves review accounts out, by account and by
 * install — the same two keys the funnel uses, since a reviewer's session may
 * carry either.
 */
export async function sessionScope(mode: ReviewersMode = 'exclude'): Promise<Record<string, unknown>[]> {
  if (mode === 'include') return []
  const { userIds, installIds } = await reviewerAccounts.scope()
  if (mode === 'only') {
    const any = [
      ...(userIds.length > 0 ? [{ user_id: { $in: userIds } }] : []),
      ...(installIds.length > 0 ? [{ install_id: { $in: installIds } }] : []),
    ]
    // An empty `$or` is invalid; "only reviewers" with none flagged matches nothing.
    return any.length > 0 ? [{ $or: any }] : [{ _id: { $in: [] } }]
  }
  return [
    ...(userIds.length > 0 ? [{ user_id: { $nin: userIds } }] : []),
    ...(installIds.length > 0 ? [{ install_id: { $nin: installIds } }] : []),
  ]
}

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

/**
 * The countries a set of players is in, most players first, plus how many have
 * no country on record. A gone account counts as unknown, not as missing.
 *
 * `country` wins; the stored hint (`country_hint.code`, part 2b) fills the gap
 * for players seen before connection capture existed.
 */
export async function countriesOfPlayers(
  ids: ObjectId[],
  limit?: number,
): Promise<{ countries: Array<{ code: string; players: number }>; unknown: number }> {
  const unique = [...new Map(ids.map((id) => [idString(id), id])).values()]
  if (unique.length === 0) return { countries: [], unknown: 0 }
  const rows = await mongoColl.users()
    .find({ _id: { $in: unique } }, { projection: { country: 1, country_hint: 1 } })
    .toArray()
  const counts = new Map<string, number>()
  let unknown = unique.length - rows.length
  for (const row of rows) {
    const { country } = countryOfUser(row as { country?: string; country_hint?: { code?: string; source?: 'locale' | 'phone' } })
    if (country) counts.set(country, (counts.get(country) ?? 0) + 1)
    else unknown++
  }
  const countries = [...counts.entries()]
    .map(([code, players]) => ({ code, players }))
    .sort((left, right) => right.players - left.players || left.code.localeCompare(right.code))
  return { countries: limit === undefined ? countries : countries.slice(0, limit), unknown }
}

/** Sort a `Map` built from a grouped aggregate by hex id. */
export function mapById<T>(rows: Array<{ _id: unknown } & T>): Map<string, T> {
  return new Map(rows.map((row) => [idString(row._id), row]))
}
