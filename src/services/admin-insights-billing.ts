import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString } from '../utils/mongo-id'
import { effectiveBilling, type EffectiveBilling } from './billing-config.service'
import type { ReviewersMode } from './reviewer-accounts'
import {
  calls,
  coverUrl,
  dayExpression,
  daySeries,
  events,
  groupSaveSet,
  inkEquivalent,
  money,
  personRefsByIds,
  playerScope,
  storyTurnMatch,
  windowStart,
  type PersonRef,
} from './admin-insights'

/**
 * `GET /admin/billing/summary` (`everlore-docs/phases/admin-insights.md`, parts
 * 1 and 2).
 *
 * Read-only: what the window cost in model spend, what it would have cost in Ink
 * at catalog prices, and who and what it went to. Turns are `events` (solo and
 * group chat alike) and cost is every `llm_calls` row, background calls
 * included — `generation_logs` saw only solo turns and understated both.
 *
 * The promo state decides whether a metered spend figure is even meaningful —
 * `spent_total` is 0 while the promo is on, because nothing was debited.
 */

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

type CostRollup = { turns: number; solo_turns: number; cost_usd: number; media: number }

/**
 * Story turns, summed model cost and media items in a window, reviewer-excluded.
 *
 * `turns` and `cost_usd` come from different collections by design: a turn is an
 * `event`, and a cost is a `llm_call`, which also covers the background calls
 * that belong to no turn. `solo_turns` is what an Ink equivalent may price,
 * because a group turn reserves 0 Ink.
 */
async function windowTotals(from: Date, scope: Record<string, unknown>): Promise<CostRollup> {
  const turnMatch = { created_at: { $gte: from }, ...storyTurnMatch(), ...scope }
  const [turnRows, cost, media] = await Promise.all([
    // Grouped per save so the group ones can be identified in one bounded read
    // rather than excluded with a `$nin` of every group save ever made.
    events().aggregate<{ _id: ObjectId; turns: number }>([
      { $match: turnMatch },
      { $group: { _id: '$instance_id', turns: { $sum: 1 } } },
    ]).toArray(),
    calls().aggregate<{ _id: null; cost: number }>([
      { $match: { created_at: { $gte: from }, ...scope } },
      { $group: { _id: null, cost: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
    // A released item was never made, so it would have cost nothing.
    mediaUsage().aggregate<{ _id: null; media: number }>([
      { $match: { created_at: { $gte: from }, status: { $ne: 'released' }, ...scope } },
      { $group: { _id: null, media: { $sum: 1 } } },
    ]).toArray(),
  ])
  const groupIds = await groupSaveSet(turnRows.map((row) => row._id).filter((id): id is ObjectId => id instanceof ObjectId))
  const turns = turnRows.reduce((sum, row) => sum + Number(row.turns ?? 0), 0)
  const solo_turns = turnRows
    .filter((row) => !(row._id && groupIds.has(idString(row._id))))
    .reduce((sum, row) => sum + Number(row.turns ?? 0), 0)
  return { turns, solo_turns, cost_usd: Number(cost[0]?.cost ?? 0), media: Number(media[0]?.media ?? 0) }
}

/** Cost, turns and distinct players per UTC day, every day of the window present. */
async function dailyRollup(
  days: SummaryDays,
  from: Date,
  scope: Record<string, unknown>,
  costs: EffectiveBilling['costs'],
  now: Date,
) {
  const [turnRows, costRows, mediaRows] = await Promise.all([
    events().aggregate<{ _id: { day: string; instance: ObjectId; player: ObjectId }; turns: number }>([
      { $match: { created_at: { $gte: from }, ...storyTurnMatch(), ...scope } },
      { $group: { _id: { day: dayExpression, instance: '$instance_id', player: '$player_id' }, turns: { $sum: 1 } } },
    ]).toArray(),
    calls().aggregate<{ _id: string; cost_usd: number }>([
      { $match: { created_at: { $gte: from }, ...scope } },
      { $group: { _id: dayExpression, cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
    // Media items are the other half of the Ink conversion, so the day's figure
    // prices them too rather than only the turns.
    mediaUsage().aggregate<{ _id: string; media: number }>([
      { $match: { created_at: { $gte: from }, status: { $ne: 'released' }, ...scope } },
      { $group: { _id: dayExpression, media: { $sum: 1 } } },
    ]).toArray(),
  ])
  const groupIds = await groupSaveSet(turnRows.map((row) => row._id.instance).filter((id): id is ObjectId => id instanceof ObjectId))
  const byDay = new Map<string, { turns: number; solo_turns: number; players: Set<string> }>()
  for (const row of turnRows) {
    const entry = byDay.get(row._id.day) ?? { turns: 0, solo_turns: 0, players: new Set<string>() }
    const turns = Number(row.turns ?? 0)
    entry.turns += turns
    if (!(row._id.instance && groupIds.has(idString(row._id.instance)))) entry.solo_turns += turns
    if (row._id.player) entry.players.add(idString(row._id.player))
    byDay.set(row._id.day, entry)
  }
  const costByDay = new Map(costRows.map((row) => [row._id, row.cost_usd]))
  const mediaByDay = new Map(mediaRows.map((row) => [row._id, row.media]))
  return daySeries(days, now).map((date) => {
    const row = byDay.get(date)
    return {
      date,
      cost_usd: money(costByDay.get(date) ?? 0),
      turns: row?.turns ?? 0,
      active_players: row?.players.size ?? 0,
      // Solo turns only: a group turn would never have been charged Ink.
      ink_equiv: inkEquivalent({ turns: row?.solo_turns ?? 0, media: mediaByDay.get(date) ?? 0 }, costs),
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

type PlayerCost = { id: ObjectId; cost: number; turns: number; solo_turns: number }

/**
 * Per-player cost and turns in the window, for the top players.
 *
 * The two figures come from different collections: cost is every `llm_calls` row
 * on the player, turns are the player's story `events`. A player who only made
 * portraits has a cost and no turn, and still belongs here — the contract counts
 * calls tied to no save in top players. `solo_turns` is what an Ink equivalent
 * may price, because a group turn reserves 0 Ink.
 */
async function playerRollup(from: Date, scope: Record<string, unknown>): Promise<PlayerCost[]> {
  const [costRows, turnRows] = await Promise.all([
    calls().aggregate<{ _id: ObjectId; cost: number }>([
      { $match: { created_at: { $gte: from }, ...scope } },
      { $group: { _id: '$player_id', cost: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
    events().aggregate<{ _id: { player: ObjectId; instance: ObjectId }; turns: number }>([
      { $match: { created_at: { $gte: from }, ...storyTurnMatch(), ...scope } },
      { $group: { _id: { player: '$player_id', instance: '$instance_id' }, turns: { $sum: 1 } } },
    ]).toArray(),
  ])
  const groupIds = await groupSaveSet(turnRows.map((row) => row._id.instance).filter((id): id is ObjectId => id instanceof ObjectId))
  const byPlayer = new Map<string, PlayerCost>()
  const entryFor = (id: ObjectId) => {
    const key = idString(id)
    const entry = byPlayer.get(key) ?? { id, cost: 0, turns: 0, solo_turns: 0 }
    byPlayer.set(key, entry)
    return entry
  }
  for (const row of costRows) if (row._id) entryFor(row._id).cost = Number(row.cost ?? 0)
  for (const row of turnRows) {
    if (!row._id.player) continue
    const entry = entryFor(row._id.player)
    const turns = Number(row.turns ?? 0)
    entry.turns += turns
    if (!(row._id.instance && groupIds.has(idString(row._id.instance)))) entry.solo_turns += turns
  }
  return [...byPlayer.values()]
}

/**
 * Per-world cost and turns in the window.
 *
 * Neither collection names a world, so each is grouped per save first, then those
 * saves' templates are read once and the rows summed per world — bounded by the
 * saves that had a turn or a call, never by the whole collection.
 */
async function worldRollup(from: Date, scope: Record<string, unknown>) {
  const [costRows, turnRows] = await Promise.all([
    calls().aggregate<{ _id: ObjectId; cost: number }>([
      { $match: { created_at: { $gte: from }, instance_id: { $exists: true }, ...scope } },
      { $group: { _id: '$instance_id', cost: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
    events().aggregate<{ _id: ObjectId; turns: number }>([
      { $match: { created_at: { $gte: from }, ...storyTurnMatch(), ...scope } },
      { $group: { _id: '$instance_id', turns: { $sum: 1 } } },
    ]).toArray(),
  ])
  const perInstance = new Map<string, { id: ObjectId; cost: number; turns: number }>()
  const entryFor = (id: ObjectId) => {
    const key = idString(id)
    const entry = perInstance.get(key) ?? { id, cost: 0, turns: 0 }
    perInstance.set(key, entry)
    return entry
  }
  for (const row of costRows) if (row._id) entryFor(row._id).cost = Number(row.cost ?? 0)
  for (const row of turnRows) if (row._id) entryFor(row._id).turns = Number(row.turns ?? 0)
  if (perInstance.size === 0) return []

  const saves = await worldInstances()
    .find({ _id: { $in: [...perInstance.values()].map((row) => row.id) } }, { projection: { template_id: 1, group_template_id: 1 } })
    .toArray()
  const instanceTemplate = new Map(saves.map((save) => [idString(save._id), save.group_template_id ?? save.template_id]))

  const perWorld = new Map<string, { id: ObjectId; cost: number; turns: number }>()
  for (const row of perInstance.values()) {
    const templateId = instanceTemplate.get(idString(row.id))
    if (!templateId) continue
    const key = idString(templateId)
    const entry = perWorld.get(key) ?? { id: templateId, cost: 0, turns: 0 }
    entry.cost += row.cost
    entry.turns += row.turns
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

    // An "active player" took a turn in the window, so the count is the players
    // with turns rather than a second aggregation. A player who only made
    // portraits is in `top_players` but is not an active player.
    const activePlayers = playerRows.filter((row) => row.turns > 0).length
    const topPlayers = [...playerRows]
      .sort((left, right) => right.cost - left.cost || right.turns - left.turns)
      .slice(0, 10)
    const people = await personRefsByIds(topPlayers.map((row) => row.id))

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
        // Solo turns plus media, both at catalog prices: a group turn never
        // reserved Ink, so pricing it would invent a charge nobody would pay.
        equiv_total: inkEquivalent({ turns: totals.solo_turns, media: totals.media }, config.costs),
        spent_total: spent,
      },
      top_players: topPlayers.map((row) => {
        // A deleted account keeps its id for the link; there is nothing to name it.
        const person: PersonRef = people.get(idString(row.id)) ?? {
          id: idString(row.id), name: '', username: '', official: false, reviewer: false, gender: null,
        }
        return {
          ...person,
          cost_usd: money(row.cost),
          turns: row.turns,
          ink_equiv: inkEquivalent({ turns: row.solo_turns, media: 0 }, config.costs),
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
