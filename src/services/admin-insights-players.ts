import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import type { ReviewersMode } from './reviewer-accounts'
import { effectiveBilling, type EffectiveBilling } from './billing-config.service'
import {
  coverUrl,
  dayExpression,
  daySeries,
  DAYS_30,
  inkEquivalent,
  money,
  personGender,
  personRefsByIds,
  saveTurns,
  windowStart,
  type PersonRef,
  type UserRow,
} from './admin-insights'

/**
 * Player aggregates (`everlore-docs/phases/admin-insights.md`, part 1).
 *
 * Read-only, and computed for the rows on the page only: a page's `profile`,
 * `cost_usd_30d` and `ink` are three bounded reads keyed by the page's player
 * ids. The player page's own 30-day `activity` and `worlds` are likewise keyed
 * by that one player.
 */

const users = () => mongoColl.users()
const appSessions = () => mongoColl.appSessions()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()
const generationLogs = () => mongoColl.generationLogs()
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

/** Turn count and summed model cost per player over a window, from generation_logs. */
async function playerCosts(playerIds: ObjectId[], from: Date): Promise<Map<string, { turns: number; cost: number }>> {
  if (playerIds.length === 0) return new Map()
  const rows = await generationLogs().aggregate<{ _id: ObjectId; turns: number; cost: number }>([
    { $match: { player_id: { $in: playerIds }, created_at: { $gte: from } } },
    { $group: {
      _id: '$player_id',
      turns: { $sum: 1 },
      cost: { $sum: { $ifNull: ['$turn_cost_usd', 0] } },
    } },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), { turns: row.turns, cost: Number(row.cost ?? 0) }]))
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

  const [sessions, costs, ink, media] = await Promise.all([
    latestSessions(playerIds),
    playerCosts(playerIds, start30),
    inkFor(playerIds, start30),
    config.promo.unlimited ? mediaCounts(playerIds, start30) : Promise.resolve(new Map<string, number>()),
  ])

  const out = new Map<string, { profile: PlayerProfile; cost_usd_30d: number; ink: InkView }>()
  for (const row of rows) {
    const key = idString(row._id)
    const cost = costs.get(key)
    const balance = ink.get(key)
    out.set(key, {
      profile: profileOf(row, sessions.get(key)),
      cost_usd_30d: money(cost?.cost ?? 0),
      ink: inkView(config.promo, {
        balance: balance?.balance ?? 0,
        spent_30d: balance?.spent_30d ?? 0,
        turns: cost?.turns ?? 0,
        media: media.get(key) ?? 0,
      }, config),
    })
  }
  return out
}

/**
 * The activity series a player page shows: 30 days of turns and cost, every day
 * present. Read from `generation_logs` with a window and the one `player_id`.
 */
async function activity(playerId: ObjectId, now: Date) {
  const days = daySeries(DAYS_30, now)
  const start30 = windowStart(DAYS_30, now)
  const rows = await generationLogs().aggregate<{ _id: string; turns: number; cost_usd: number }>([
    { $match: { player_id: playerId, created_at: { $gte: start30 } } },
    { $group: { _id: dayExpression, turns: { $sum: 1 }, cost_usd: { $sum: { $ifNull: ['$turn_cost_usd', 0] } } } },
  ]).toArray()
  const byDay = new Map(rows.map((row) => [row._id, row]))
  return days.map((date) => {
    const row = byDay.get(date)
    return { date, turns: row?.turns ?? 0, cost_usd: money(row?.cost_usd ?? 0) }
  })
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
