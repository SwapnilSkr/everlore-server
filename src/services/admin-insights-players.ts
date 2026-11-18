import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import type { ReviewersMode } from './reviewer-accounts'
import { effectiveBilling, type EffectiveBilling } from './billing-config.service'
import {
  calls,
  coverUrl,
  dayExpression,
  daySeries,
  DAYS_30,
  events,
  groupSaveSet,
  inkEquivalent,
  money,
  personGender,
  personRefsByIds,
  saveTurns,
  storyTurnMatch,
  windowStart,
  type PersonRef,
  type UserRow,
} from './admin-insights'

/**
 * Player aggregates (`everlore-docs/phases/admin-insights.md`, parts 1 and 2).
 *
 * Read-only, and computed for the rows on the page only: a page's `profile`,
 * `cost_usd_30d` and `ink` are bounded reads keyed by the page's player ids.
 * The player page's own 30-day `activity` and `worlds` are likewise keyed by
 * that one player. Turns come from `events` (solo and group chat alike) and cost
 * from `llm_calls`, which is the only place background calls appear.
 */

const users = () => mongoColl.users()
const appSessions = () => mongoColl.appSessions()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const inkLedger = () => mongoColl.inkLedger()
const mediaUsage = () => mongoColl.mediaUsage()

export type SignIn = 'google' | 'phone' | 'guest' | 'other'

export type DeviceProfile = {
  model: string | null
  os_version: string | null
  form: 'phone' | 'tablet'
}

export type PlayerProfile = {
  gender: 'male' | 'female' | 'nonbinary' | null
  interests: string[]
  adult: boolean
  sign_in: SignIn
  device: DeviceProfile | null
  app_version: string | null
  /** `users.country`, or null when no country has ever been known. */
  country: string | null
}

export type InkView =
  | { mode: 'unlimited_promo'; balance: number; ink_equiv_30d: number }
  | { mode: 'metered'; balance: number; spent_30d: number }

/**
 * Sign-in from the account's provider list. A guest is a guest whatever its
 * providers say; a Google or phone provider wins over anything else recorded;
 * and an account with neither is `other` rather than a guess.
 */
export function signInOf(user: { guest?: boolean; providers?: string[] }): SignIn {
  if (user.guest === true) return 'guest'
  const providers = Array.isArray(user.providers) ? user.providers : []
  if (providers.includes('google')) return 'google'
  if (providers.includes('phone')) return 'phone'
  return 'other'
}

function profileOf(user: UserRow, latest: LatestSession | undefined): PlayerProfile {
  const device = latest?.device
  return {
    gender: personGender(user.preferences?.gender),
    interests: Array.isArray(user.preferences?.interests) ? user.preferences!.interests! : [],
    adult: user.preferences?.nsfw_enabled === true,
    sign_in: signInOf(user),
    device: device && device.form
      ? { model: device.model ?? null, os_version: device.os_version ?? null, form: device.form }
      : null,
    app_version: latest?.app_version ?? null,
    country: typeof user.country === 'string' && user.country ? user.country.toUpperCase() : null,
  }
}

type LatestSession = {
  user_id: ObjectId
  app_version?: string
  started_at?: Date
  device?: { model?: string; os_version?: string; form?: 'phone' | 'tablet' }
}

/**
 * Each player's latest analytics session, for the page's ids.
 *
 * `app_sessions` is indexed on `(user_id, started_at)`, so this is one sorted
 * read per player at most; a player with no session gets no entry and reads as
 * "not reported".
 */
async function latestSessions(playerIds: ObjectId[]): Promise<Map<string, LatestSession>> {
  if (playerIds.length === 0) return new Map()
  const rows = await appSessions()
    .aggregate<LatestSession>([
      { $match: { user_id: { $in: playerIds } } },
      { $sort: { started_at: -1 } },
      { $group: {
        _id: '$user_id',
        app_version: { $first: '$app_version' },
        started_at: { $first: '$started_at' },
        device: { $first: '$device' },
      } },
      { $project: { _id: 0, user_id: '$_id', app_version: 1, started_at: 1, device: 1 } },
    ])
    .toArray()
  return new Map(rows.map((row) => [idString(row.user_id), row]))
}

/**
 * Story turns per player over a window, from `events`.
 *
 * The same rows the Overview counts, so a group chat player's turns show here
 * exactly as a solo player's do. `solo` is what an Ink equivalent may price: a
 * group turn reserves 0 Ink (`billing.service.ts` `reserveGroupTurn`).
 */
async function playerTurns(
  playerIds: ObjectId[],
  from: Date,
): Promise<{ turns: Map<string, number>; solo: Map<string, number> }> {
  if (playerIds.length === 0) return { turns: new Map(), solo: new Map() }
  const rows = await events().aggregate<{ _id: { player: ObjectId; instance: ObjectId }; turns: number }>([
    { $match: { player_id: { $in: playerIds }, created_at: { $gte: from }, ...storyTurnMatch() } },
    { $group: { _id: { player: '$player_id', instance: '$instance_id' }, turns: { $sum: 1 } } },
  ]).toArray()
  const groupIds = await groupSaveSet(rows.map((row) => row._id.instance).filter((id): id is ObjectId => id instanceof ObjectId))
  const turns = new Map<string, number>()
  const solo = new Map<string, number>()
  for (const row of rows) {
    if (!row._id.player) continue
    const key = idString(row._id.player)
    const count = Number(row.turns ?? 0)
    turns.set(key, (turns.get(key) ?? 0) + count)
    if (!(row._id.instance && groupIds.has(idString(row._id.instance)))) {
      solo.set(key, (solo.get(key) ?? 0) + count)
    }
  }
  return { turns, solo }
}

/** Model cost per player over a window, from every priced call in `llm_calls`. */
async function playerCosts(playerIds: ObjectId[], from: Date): Promise<Map<string, number>> {
  if (playerIds.length === 0) return new Map()
  const rows = await calls().aggregate<{ _id: ObjectId; cost: number }>([
    { $match: { player_id: { $in: playerIds }, created_at: { $gte: from } } },
    { $group: { _id: '$player_id', cost: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), Number(row.cost ?? 0)]))
}

/** Ink balance from the ledger (never frozen mid-write), and spend over the window. */
async function inkFor(
  playerIds: ObjectId[],
  from: Date,
): Promise<Map<string, { balance: number; spent_30d: number }>> {
  if (playerIds.length === 0) return new Map()
  const [balances, spends] = await Promise.all([
    inkLedger().aggregate<{ _id: ObjectId; balance: number }>([
      { $match: { player_id: { $in: playerIds } } },
      { $group: { _id: '$player_id', balance: { $sum: '$delta' } } },
    ]).toArray(),
    // Spend is reserves net of releases: a failed turn's release refunds its
    // reserve (settle rows carry 0). `delta` is negative on a charge.
    inkLedger().aggregate<{ _id: ObjectId; spent: number }>([
      { $match: { player_id: { $in: playerIds }, reason: { $in: ['reserve', 'release'] }, created_at: { $gte: from } } },
      { $group: { _id: '$player_id', spent: { $sum: { $multiply: ['$delta', -1] } } } },
    ]).toArray(),
  ])
  const byId = new Map(playerIds.map((id) => [idString(id), { balance: 0, spent_30d: 0 }]))
  for (const row of balances) {
    const entry = byId.get(idString(row._id))
    if (entry) entry.balance = Number(row.balance ?? 0)
  }
  for (const row of spends) {
    const entry = byId.get(idString(row._id))
    if (entry) entry.spent_30d = Math.max(0, Number(row.spent ?? 0))
  }
  return byId
}

/**
 * The `InkView` for one player.
 *
 * During the promo nothing is debited, so the balance is whatever it was and
 * the figure that matters is what the last 30 days *would* have cost at catalog
 * prices. Metered accounts show what the ledger says they spent.
 */
function inkView(
  promo: EffectiveBilling['promo'],
  input: { balance: number; spent_30d: number; turns: number; media: number },
  config: EffectiveBilling,
): InkView {
  if (promo.unlimited) {
    return {
      mode: 'unlimited_promo',
      balance: input.balance,
      ink_equiv_30d: inkEquivalent({ turns: input.turns, media: input.media }, config.costs),
    }
  }
  return { mode: 'metered', balance: input.balance, spent_30d: input.spent_30d }
}

/** Media items per player over a window, the second half of the Ink conversion. */
async function mediaCounts(playerIds: ObjectId[], from: Date): Promise<Map<string, number>> {
  if (playerIds.length === 0) return new Map()
  const rows = await mediaUsage().aggregate<{ _id: ObjectId; media: number }>([
    // A released item was never made, so it would have cost nothing.
    { $match: { player_id: { $in: playerIds }, status: { $ne: 'released' }, created_at: { $gte: from } } },
    { $group: { _id: '$player_id', media: { $sum: 1 } } },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), row.media]))
}

/** `profile`, `cost_usd_30d` and `ink` for the page's players, in one pass. */
export async function playerInsights(
  rows: UserRow[],
  now = new Date(),
): Promise<Map<string, { profile: PlayerProfile; cost_usd_30d: number; ink: InkView }>> {
  const playerIds = rows.map((row) => row._id)
  if (playerIds.length === 0) return new Map()
  const start30 = windowStart(DAYS_30, now)
  const config = await effectiveBilling()

  const [sessions, turnCounts, costs, ink, media] = await Promise.all([
    latestSessions(playerIds),
    playerTurns(playerIds, start30),
    playerCosts(playerIds, start30),
    inkFor(playerIds, start30),
    config.promo.unlimited ? mediaCounts(playerIds, start30) : Promise.resolve(new Map<string, number>()),
  ])

  const out = new Map<string, { profile: PlayerProfile; cost_usd_30d: number; ink: InkView }>()
  for (const row of rows) {
    const key = idString(row._id)
    const balance = ink.get(key)
    out.set(key, {
      profile: profileOf(row, sessions.get(key)),
      cost_usd_30d: money(costs.get(key) ?? 0),
      ink: inkView(config.promo, {
        balance: balance?.balance ?? 0,
        spent_30d: balance?.spent_30d ?? 0,
        // Ink is priced on solo turns: a group turn reserved 0.
        turns: turnCounts.solo.get(key) ?? 0,
        media: media.get(key) ?? 0,
      }, config),
    })
  }
  return out
}

/**
 * The activity series a player page shows: 30 days of turns and cost, every day
 * present. Turns are `events`, cost is `llm_calls`; both are windowed and matched
 * on the one `player_id`.
 */
async function activity(playerId: ObjectId, now: Date) {
  const days = daySeries(DAYS_30, now)
  const start30 = windowStart(DAYS_30, now)
  const [turnRows, costRows] = await Promise.all([
    events().aggregate<{ _id: string; turns: number }>([
      { $match: { player_id: playerId, created_at: { $gte: start30 }, ...storyTurnMatch() } },
      { $group: { _id: dayExpression, turns: { $sum: 1 } } },
    ]).toArray(),
    calls().aggregate<{ _id: string; cost_usd: number }>([
      { $match: { player_id: playerId, created_at: { $gte: start30 } } },
      { $group: { _id: dayExpression, cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
  ])
  const turns = new Map(turnRows.map((row) => [row._id, row.turns]))
  const costs = new Map(costRows.map((row) => [row._id, row.cost_usd]))
  return days.map((date) => ({ date, turns: turns.get(date) ?? 0, cost_usd: money(costs.get(date) ?? 0) }))
}

type OwnedSave = {
  _id: ObjectId
  template_id: ObjectId
  group_template_id?: ObjectId
  meta?: { total_events?: number; last_active_at?: Date }
}

export type PlayerWorld = {
  id: string
  title: string
  kind: string
  cover_url: string | null
  turns: number
  last_played_at: string | null
}

/**
 * The worlds a player has played, up to 20 by last played.
 *
 * A save names its world on `template_id`, or `group_template_id` for a group.
 * Several saves of one world are one row here: turns are summed and the most
 * recent save is the one that dates it, because the page shows worlds, not
 * stories. Saves are read for one `player_id`, sorted by last activity.
 */
async function playerWorlds(playerId: ObjectId): Promise<PlayerWorld[]> {
  const saves = await worldInstances()
    .find(
      { player_id: playerId },
      { projection: { template_id: 1, group_template_id: 1, 'meta.total_events': 1, 'meta.last_active_at': 1 } },
    )
    .sort({ 'meta.last_active_at': -1, _id: -1 })
    .toArray() as unknown as OwnedSave[]

  const byWorld = new Map<string, { template: ObjectId; turns: number; last: Date | null }>()
  for (const save of saves) {
    const templateId = save.group_template_id ?? save.template_id
    if (!templateId) continue
    const key = idString(templateId)
    const entry = byWorld.get(key) ?? { template: templateId, turns: 0, last: null }
    entry.turns += saveTurns(save.meta)
    const last = save.meta?.last_active_at instanceof Date ? save.meta.last_active_at : null
    if (last && (!entry.last || last > entry.last)) entry.last = last
    byWorld.set(key, entry)
  }
  if (byWorld.size === 0) return []

  const ordered = [...byWorld.values()]
    .sort((left, right) => (right.last?.getTime() ?? 0) - (left.last?.getTime() ?? 0))
    .slice(0, 20)

  const templates = await worldTemplates()
    .find(
      { _id: { $in: ordered.map((entry) => entry.template) } },
      { projection: { title: 1, kind: 1, image_url: 1, image_thumb_url: 1 } },
    )
    .toArray()
  const byId = new Map(templates.map((row) => [idString(row._id), row]))

  return ordered.map((entry) => {
    const template = byId.get(idString(entry.template))
    return {
      id: idString(entry.template),
      // The world may be gone; the id still links and the title says so.
      title: template?.title ?? 'Deleted world',
      kind: template?.kind ?? 'world',
      cover_url: template ? coverUrl(template) : null,
      turns: entry.turns,
      last_played_at: entry.last ? entry.last.toISOString() : null,
    }
  })
}

export const playerInsightsService = {
  /** The extra fields one player page shows, beyond `getUser`'s own. */
  async detail(user: UserRow, now = new Date()) {
    const base = await playerInsights([user], now)
    const entry = base.get(idString(user._id))!
    const playerId = user._id
    const [series, worlds] = await Promise.all([activity(playerId, now), playerWorlds(playerId)])
    return {
      profile: entry.profile,
      cost_usd_30d: entry.cost_usd_30d,
      ink: entry.ink,
      activity: series,
      worlds,
    }
  },
}
