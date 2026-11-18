import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString } from '../utils/mongo-id'
import { effectiveBilling, type EffectiveBilling } from './billing-config.service'
import type { ReviewersMode } from './reviewer-accounts'
import {
  coverUrl,
  dayExpression,
  daySeries,
  inkEquivalent,
  money,
  personRefsByIds,
  playerScope,
  windowStart,
  type PersonRef,
} from './admin-insights'

/**
 * `GET /admin/billing/summary` (`everlore-docs/phases/admin-insights.md`, part 1).
 *
 * Read-only: what the window cost in model spend, what it would have cost in Ink
 * at catalog prices, and who and what it went to. The promo state decides
 * whether a metered spend figure is even meaningful — `spent_total` is 0 while
 * the promo is on, because nothing was debited.
 */

const generationLogs = () => mongoColl.generationLogs()
const inkLedger = () => mongoColl.inkLedger()
const mediaUsage = () => mongoColl.mediaUsage()
const worldInstances = () => mongoColl.worldInstances()
const worldTemplates = () => mongoColl.worldTemplates()

export const SUMMARY_DAYS = [7, 30, 90] as const
export type SummaryDays = (typeof SUMMARY_DAYS)[number]

/** `days` is one of 7, 30 or 90; anything else is a 400 sentence. */
export function summaryDays(value?: string): SummaryDays {
  if (value === undefined || value === '') return 30
  const days = Number(value)
  if (!SUMMARY_DAYS.includes(days as SummaryDays)) {
    throw new HttpError(400, 'Days must be 7, 30 or 90.')
  }
  return days as SummaryDays
}

type CostRollup = { turns: number; cost_usd: number; media: number }

/** Turn count, summed model cost and media items in a window, reviewer-excluded. */
async function windowTotals(from: Date, scope: Record<string, unknown>): Promise<CostRollup> {
  const [turns, media] = await Promise.all([
    generationLogs().aggregate<{ _id: null; turns: number; cost: number }>([
      { $match: { created_at: { $gte: from }, ...scope } },
      { $group: { _id: null, turns: { $sum: 1 }, cost: { $sum: { $ifNull: ['$turn_cost_usd', 0] } } } },
    ]).toArray(),
    // A released item was never made, so it would have cost nothing.
    mediaUsage().aggregate<{ _id: null; media: number }>([
      { $match: { created_at: { $gte: from }, status: { $ne: 'released' }, ...scope } },
      { $group: { _id: null, media: { $sum: 1 } } },
    ]).toArray(),
  ])
  return {
    turns: Number(turns[0]?.turns ?? 0),
    cost_usd: Number(turns[0]?.cost ?? 0),
    media: Number(media[0]?.media ?? 0),
  }
}

/** Cost, turns and distinct players per UTC day, every day of the window present. */
async function dailyRollup(
  days: SummaryDays,
  from: Date,
  scope: Record<string, unknown>,
  costs: EffectiveBilling['costs'],
  now: Date,
) {
  const [rows, mediaRows] = await Promise.all([
    generationLogs().aggregate<{
      _id: string
      turns: number
      cost_usd: number
      players: ObjectId[]
    }>([
      { $match: { created_at: { $gte: from }, ...scope } },
      { $group: {
        _id: { day: dayExpression, player: '$player_id' },
        turns: { $sum: 1 },
        cost_usd: { $sum: { $ifNull: ['$turn_cost_usd', 0] } },
      } },
      { $group: {
        _id: '$_id.day',
        turns: { $sum: '$turns' },
        cost_usd: { $sum: '$cost_usd' },
        players: { $addToSet: '$_id.player' },
      } },
    ]).toArray(),
    // Media items are the other half of the Ink conversion, so the day's figure
    // prices them too rather than only the turns.
    mediaUsage().aggregate<{ _id: string; media: number }>([
      { $match: { created_at: { $gte: from }, status: { $ne: 'released' }, ...scope } },
      { $group: { _id: dayExpression, media: { $sum: 1 } } },
    ]).toArray(),
  ])
  const byDay = new Map(rows.map((row) => [row._id, row]))
  const mediaByDay = new Map(mediaRows.map((row) => [row._id, row.media]))
  return daySeries(days, now).map((date) => {
    const row = byDay.get(date)
    const turns = Number(row?.turns ?? 0)
    return {
      date,
      cost_usd: money(row?.cost_usd ?? 0),
      turns,
      active_players: (row?.players ?? []).filter(Boolean).length,
      ink_equiv: inkEquivalent({ turns, media: mediaByDay.get(date) ?? 0 }, costs),
    }
  })
}

/**
 * Metered spend: what the ledger debited in the window, net of releases (a
 * failed turn's release refunds its reserve; settle rows carry 0).
 */
async function spentTotal(from: Date, scope: Record<string, unknown>): Promise<number> {
  const [row] = await inkLedger().aggregate<{ _id: null; spent: number }>([
    { $match: { reason: { $in: ['reserve', 'release'] }, created_at: { $gte: from }, ...scope } },
    { $group: { _id: null, spent: { $sum: { $multiply: ['$delta', -1] } } } },
  ]).toArray()
  return Math.max(0, Number(row?.spent ?? 0))
}

type PlayerCost = { _id: ObjectId; cost: number; turns: number }

/** Per-player cost and turns in the window, for the top players. */
async function playerRollup(from: Date, scope: Record<string, unknown>) {
  return generationLogs().aggregate<PlayerCost>([
    { $match: { created_at: { $gte: from }, ...scope } },
    { $group: { _id: '$player_id', cost: { $sum: { $ifNull: ['$turn_cost_usd', 0] } }, turns: { $sum: 1 } } },
  ]).toArray()
}

/**
 * Per-world cost and turns in the window.
 *
 * `generation_logs` names a save, not a world, so the logs are grouped per save
 * first, then those saves' templates are read once and the rows summed per
 * world — bounded by the saves that had a turn, never by the whole collection.
 */
async function worldRollup(from: Date, scope: Record<string, unknown>) {
  const perInstance = await generationLogs().aggregate<{ _id: ObjectId; cost: number; turns: number }>([
    { $match: { created_at: { $gte: from }, ...scope } },
    { $group: { _id: '$instance_id', cost: { $sum: { $ifNull: ['$turn_cost_usd', 0] } }, turns: { $sum: 1 } } },
  ]).toArray()
  if (perInstance.length === 0) return []

  const instanceIds = perInstance.map((row) => row._id).filter((id): id is ObjectId => id instanceof ObjectId)
  const saves = await worldInstances()
    .find({ _id: { $in: instanceIds } }, { projection: { template_id: 1, group_template_id: 1 } })
    .toArray()
  const instanceTemplate = new Map(saves.map((save) => [idString(save._id), save.group_template_id ?? save.template_id]))

  const perWorld = new Map<string, { id: ObjectId; cost: number; turns: number }>()
  for (const row of perInstance) {
    const templateId = instanceTemplate.get(idString(row._id))
    if (!templateId) continue
    const key = idString(templateId)
    const entry = perWorld.get(key) ?? { id: templateId, cost: 0, turns: 0 }
    entry.cost += Number(row.cost ?? 0)
    entry.turns += Number(row.turns ?? 0)
    perWorld.set(key, entry)
  }
  return [...perWorld.values()]
}

export const billingInsights = {
  async summary(daysValue?: string, mode: ReviewersMode = 'exclude', now = new Date()) {
    const days = summaryDays(daysValue)
    const from = windowStart(days, now)
    const scope = await playerScope(mode)
    const config = await effectiveBilling()
    const unlimited = config.promo.unlimited

    const [totals, daily, playerRows, worldRows, spent] = await Promise.all([
      windowTotals(from, scope),
      dailyRollup(days, from, scope, config.costs, now),
      playerRollup(from, scope),
      worldRollup(from, scope),
      unlimited ? Promise.resolve(0) : spentTotal(from, scope),
    ])

    // An "active player" took a turn in the window, so the count is the size of
    // the per-player rollup rather than a second aggregation.
    const activePlayers = playerRows.length
    const topPlayers = [...playerRows]
      .sort((left, right) => right.cost - left.cost || right.turns - left.turns)
      .slice(0, 10)
    const people = await personRefsByIds(topPlayers.map((row) => row._id))

    const topWorlds = [...worldRows]
      .sort((left, right) => right.cost - left.cost || right.turns - left.turns)
      .slice(0, 10)
    const templates = topWorlds.length === 0
      ? []
      : await worldTemplates()
        .find(
          { _id: { $in: topWorlds.map((row) => row.id) } },
          { projection: { title: 1, image_url: 1, image_thumb_url: 1, creator_id: 1 } },
        )
        .toArray()
    const templateById = new Map(templates.map((row) => [idString(row._id), row]))
    const creators = await personRefsByIds(
      templates.map((row) => row.creator_id).filter((id): id is ObjectId => id instanceof ObjectId),
    )

    return {
      promo: {
        unlimited,
        daily_turn_cap: config.promo.daily_turn_cap,
        updated_at: config.promo.updated_at ? config.promo.updated_at.toISOString() : null,
      },
      days,
      cost: {
        total_usd: money(totals.cost_usd),
        per_active_player_usd: activePlayers > 0 ? money(totals.cost_usd / activePlayers) : 0,
        active_players: activePlayers,
        turns: totals.turns,
      },
      daily,
      ink: {
        // The window's turn cost plus its media, both at catalog prices.
        equiv_total: inkEquivalent({ turns: totals.turns, media: totals.media }, config.costs),
        spent_total: spent,
      },
      top_players: topPlayers.map((row) => {
        // A deleted account keeps its id for the link; there is nothing to name it.
        const person: PersonRef = people.get(idString(row._id)) ?? {
          id: idString(row._id), name: '', username: '', official: false, reviewer: false, gender: null,
        }
        return {
          ...person,
          cost_usd: money(row.cost),
          turns: row.turns,
          ink_equiv: inkEquivalent({ turns: row.turns, media: 0 }, config.costs),
        }
      }),
      top_worlds: topWorlds
        .filter((row) => templateById.has(idString(row.id)))
        .map((row) => {
          const template = templateById.get(idString(row.id))!
          const creatorId = template.creator_id
          return {
            id: idString(template._id),
            title: template.title ?? '',
            cover_url: coverUrl(template),
            creator: creatorId instanceof ObjectId ? creators.get(idString(creatorId)) ?? null : null,
            cost_usd: money(row.cost),
            turns: row.turns,
          }
        }),
    }
  },
}
