import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { HttpError } from '../utils/http-error'
import { idString, parseObjectId } from '../utils/mongo-id'
import type { ReviewersMode } from './reviewer-accounts'
import {
  calls,
  countriesOfPlayers,
  coverUrl,
  dayExpression,
  daySeries,
  DAYS_30,
  events,
  money,
  officialUserId,
  personRefsByIds,
  playerScope,
  saveTurns,
  storyTurnMatch,
  windowStart,
  type PersonRef,
} from './admin-insights'

/**
 * World and creator aggregates (`everlore-docs/phases/admin-insights.md`, parts
 * 1 and 2).
 *
 * Read-only. A list computes figures for the page's worlds only; the
 * `players|turns|last_played` sorts need one `$group` over `world_instances` to
 * establish the order first (the contract allows exactly that). Story turns are
 * `events` (solo and group chat alike) and model cost is `llm_calls`, both read
 * with a `created_at` window and matched on the page's save ids.
 */

const worldTemplates = () => mongoColl.worldTemplates()
const worldInstances = () => mongoColl.worldInstances()
const users = () => mongoColl.users()
const memories = () => mongoColl.memories()
const characters = () => mongoColl.characters()

export const WORLD_SORTS = ['created', 'players', 'turns', 'last_played'] as const
export type WorldSort = (typeof WORLD_SORTS)[number]
export const WORLD_KINDS = ['world', 'character', 'group'] as const
export type WorldKind = (typeof WORLD_KINDS)[number]
export const WORLD_SOURCES = ['official', 'community'] as const
export type WorldSource = (typeof WORLD_SOURCES)[number]

export type WorldStatsView = {
  players: number
  saves: number
  turns: number
  last_played_at: string | null
  turns_7d: number[]
  cost_usd_30d: number
}

type TemplateTotal = {
  players: number
  saves: number
  turns: number
  last_played_at: Date | null
  instance_ids: ObjectId[]
}

/**
 * One grouped pass over `world_instances` for a page's templates.
 *
 * A save belongs to whichever of the page's template ids it carries, on either
 * `template_id` or `group_template_id`; a group save carries both, and
 * `$setIntersection` attributes it once. The per-player intermediate keeps
 * `players` distinct without an `$addToSet` of every player on a big world.
 */
async function templateTotals(templateIds: ObjectId[], scope: Record<string, unknown>): Promise<Map<string, TemplateTotal>> {
  if (templateIds.length === 0) return new Map()
  const rows = await worldInstances().aggregate<{
    _id: ObjectId
    players: number
    saves: number
    turns: number
    last_played_at: Date | null
    instance_ids: ObjectId[]
  }>([
    {
      $match: {
        $or: [
          { template_id: { $in: templateIds } },
          { group_template_id: { $in: templateIds } },
        ],
        ...scope,
      },
    },
    {
      $addFields: {
        __template_keys: {
          $setIntersection: [
            [{ $ifNull: ['$template_id', null] }, { $ifNull: ['$group_template_id', null] }],
            templateIds,
          ],
        },
      },
    },
    { $unwind: '$__template_keys' },
    {
      $group: {
        _id: { template: '$__template_keys', player: '$player_id' },
        saves: { $sum: 1 },
        turns: { $sum: { $ifNull: ['$meta.total_events', 0] } },
        last_played_at: { $max: '$meta.last_active_at' },
        instance_ids: { $addToSet: '$_id' },
      },
    },
    {
      $group: {
        _id: '$_id.template',
        players: { $sum: 1 },
        saves: { $sum: '$saves' },
        turns: { $sum: '$turns' },
        last_played_at: { $max: '$last_played_at' },
        instance_ids: { $push: '$instance_ids' },
      },
    },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), {
    players: row.players,
    saves: row.saves,
    turns: row.turns,
    last_played_at: row.last_played_at ?? null,
    instance_ids: row.instance_ids.flat(),
  }]))
}

/**
 * The contract's `stats` for the given templates.
 *
 * `turns_7d` is story turns from `events` — solo and group chat both write them —
 * oldest day first with every day present; `cost_usd_30d` sums `llm_calls`
 * `cost_usd` over the same saves within 30 days. Both reads are one aggregate
 * each, windowed by `created_at`, matched on the page's instance ids.
 */
export async function worldStats(templateIds: ObjectId[], mode: ReviewersMode, now = new Date()): Promise<Map<string, WorldStatsView>> {
  if (templateIds.length === 0) return new Map()
  const scope = await playerScope(mode)
  const days7 = daySeries(7, now)
  const days7Set = new Set(days7)
  const start30 = windowStart(DAYS_30, now)

  const totals = await templateTotals(templateIds, scope)

  const instanceToTemplate = new Map<string, string>()
  for (const [key, total] of totals) {
    for (const id of total.instance_ids) instanceToTemplate.set(idString(id), key)
  }
  const instanceIds = [...instanceToTemplate.keys()].map((id) => parseObjectId(id))

  // Turns are a subset of the 30-day window the cost needs, so one start serves
  // both; only the 7-day days are kept.
  const [turnRows, costRows] = instanceIds.length === 0 ? [[], []] : await Promise.all([
    events().aggregate<{ _id: { instance: ObjectId; day: string }; turns: number }>([
      { $match: { instance_id: { $in: instanceIds }, created_at: { $gte: start30 }, ...storyTurnMatch() } },
      { $group: { _id: { instance: '$instance_id', day: dayExpression }, turns: { $sum: 1 } } },
    ]).toArray(),
    calls().aggregate<{ _id: ObjectId; cost_usd: number }>([
      { $match: { instance_id: { $in: instanceIds }, created_at: { $gte: start30 } } },
      { $group: { _id: '$instance_id', cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
  ])

  const turns7 = new Map<string, Map<string, number>>()
  for (const entry of turnRows) {
    const template = instanceToTemplate.get(idString(entry._id.instance))
    if (!template || !days7Set.has(entry._id.day)) continue
    const byDay = turns7.get(template) ?? new Map<string, number>()
    byDay.set(entry._id.day, (byDay.get(entry._id.day) ?? 0) + Number(entry.turns ?? 0))
    turns7.set(template, byDay)
  }

  const cost30 = new Map<string, number>()
  for (const entry of costRows) {
    const template = instanceToTemplate.get(idString(entry._id))
    if (!template) continue
    cost30.set(template, (cost30.get(template) ?? 0) + Number(entry.cost_usd ?? 0))
  }

  const stats = new Map<string, WorldStatsView>()
  for (const id of templateIds) {
    const key = idString(id)
    const total = totals.get(key)
    const byDay = turns7.get(key)
    stats.set(key, {
      players: total?.players ?? 0,
      saves: total?.saves ?? 0,
      turns: total?.turns ?? 0,
      last_played_at: total?.last_played_at ? total.last_played_at.toISOString() : null,
      turns_7d: days7.map((day) => byDay?.get(day) ?? 0),
      cost_usd_30d: money(cost30.get(key) ?? 0),
    })
  }
  return stats
}

/** Rank templates by a save-derived figure; worlds with saves first, then newest. */
async function orderByStat(
  filter: Record<string, unknown>,
  sort: 'players' | 'turns' | 'last_played',
  mode: ReviewersMode,
): Promise<ObjectId[]> {
  const candidates = await worldTemplates()
    .find(filter, { projection: { _id: 1, created_at: 1 } })
    .toArray()
  if (candidates.length === 0) return []
  const ids = candidates.map((row) => row._id)
  const totals = await templateTotals(ids, await playerScope(mode))
  const created = new Map(candidates.map((row) => [idString(row._id), row.created_at?.getTime() ?? 0]))

  const metric = (id: ObjectId): number => {
    const total = totals.get(idString(id))
    if (!total) return -1
    if (sort === 'players') return total.players
    if (sort === 'turns') return total.turns
    return total.last_played_at?.getTime() ?? 0
  }

  return [...candidates]
    .sort((left, right) => {
      const diff = metric(right._id) - metric(left._id)
      if (diff !== 0) return diff
      return (created.get(idString(right._id)) ?? 0) - (created.get(idString(left._id)) ?? 0)
        || idString(right._id).localeCompare(idString(left._id))
    })
    .map((row) => row._id)
}

function kindFilter(kind: WorldKind): Record<string, unknown> {
  // Worlds written before kinds existed have no `kind`; they are worlds.
  return kind === 'world'
    ? { $or: [{ kind: 'world' }, { kind: null }] }
    : { kind }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function creatorFilter(creator: string): Promise<Record<string, unknown>> {
  const term = escapeRegex(creator)
  const rows = await users().find(
    {
      $or: [
        { username: { $regex: term, $options: 'i' } },
        { 'preferences.player_name': { $regex: term, $options: 'i' } },
      ],
    },
    { projection: { _id: 1 } },
  ).toArray()
  return { creator_id: { $in: rows.map((row) => row._id) } }
}

export type WorldListOptions = {
  page?: number
  limit?: number
  search?: string
  creator_id?: string
  published?: boolean
  creator?: string
  kind?: WorldKind
  source?: WorldSource
  sort?: WorldSort
  reviewers?: ReviewersMode
}

function paging(opts: { page?: number; limit?: number }) {
  const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 200)
  const page = Math.max(Number(opts.page || 1), 1)
  return { limit, page, skip: (page - 1) * limit }
}

function serialize(value: unknown): unknown {
  if (value instanceof ObjectId) return idString(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serialize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key === '_id' ? 'id' : key] = serialize(child)
    }
    return out
  }
  return value
}

type WorldRow = {
  _id: ObjectId
  creator_id?: ObjectId
  image_url?: string
  image_thumb_url?: string
  created_at?: Date
  [key: string]: unknown
}

/** Attach `creator`, `cover_url` and `stats` to a page of world rows. */
async function decorate(rows: WorldRow[], mode: ReviewersMode, now: Date) {
  const creatorIds = rows.map((row) => row.creator_id).filter((id): id is ObjectId => id instanceof ObjectId)
  const [creators, stats] = await Promise.all([
    personRefsByIds(creatorIds),
    worldStats(rows.map((row) => row._id), mode, now),
  ])
  return rows.map((row) => {
    const creator = row.creator_id instanceof ObjectId ? creators.get(idString(row.creator_id)) ?? null : null
    const statsItem = stats.get(idString(row._id))
    return {
      ...serialize(row) as Record<string, unknown>,
      creator,
      cover_url: coverUrl(row as { image_thumb_url?: string; image_url?: string }),
      stats: statsItem ?? {
        players: 0, saves: 0, turns: 0, last_played_at: null,
        turns_7d: daySeries(7, now).map(() => 0), cost_usd_30d: 0,
      },
    }
  })
}

/**
 * The counts `getWorld` already returned, kept unchanged for the console.
 *
 * Every read is matched on this world's save ids, so it is bounded by one
 * world's rows rather than a `$lookup` over each collection. The three model
 * figures used to come from `generation_logs`, which never saw group turns or
 * background calls; they are now the same saves' `llm_calls` rows.
 */
async function readCounts(tid: ObjectId) {
  const saves = await worldInstances().find({ template_id: tid }, { projection: { _id: 1 } }).toArray()
  const instanceIds = saves.map((row) => row._id)
  if (instanceIds.length === 0) {
    return { instances: 0, events: 0, memories: 0, characters: 0, generation_logs: 0, tokens_in: 0, tokens_out: 0 }
  }
  const bySave = { instance_id: { $in: instanceIds } }
  const [eventCount, memoryCount, characterCount, callStats] = await Promise.all([
    events().countDocuments(bySave),
    memories().countDocuments(bySave),
    characters().countDocuments(bySave),
    calls()
      .aggregate<{ _id: null; count: number; tokens_in: number; tokens_out: number }>([
        { $match: bySave },
        { $group: {
          _id: null,
          count: { $sum: 1 },
          tokens_in: { $sum: { $ifNull: ['$prompt_tokens', 0] } },
          tokens_out: { $sum: { $ifNull: ['$completion_tokens', 0] } },
        } },
      ])
      .toArray(),
  ])
  return {
    instances: saves.length,
    events: eventCount,
    memories: memoryCount,
    characters: characterCount,
    generation_logs: Number(callStats[0]?.count || 0),
    tokens_in: Number(callStats[0]?.tokens_in || 0),
    tokens_out: Number(callStats[0]?.tokens_out || 0),
  }
}

/** The depth histogram's buckets, in order, for a world's saves by turn count. */
const DEPTH_BUCKETS = [
  { bucket: '1' as const, min: 1, max: 1 },
  { bucket: '2-5' as const, min: 2, max: 5 },
  { bucket: '6-20' as const, min: 6, max: 20 },
  { bucket: '21-50' as const, min: 21, max: 50 },
  { bucket: '51+' as const, min: 51, max: Number.MAX_SAFE_INTEGER },
]

export type WorldGender = { male: number; female: number; nonbinary: number; unset: number }

/** The extra detail one world shows: its own 30 days, who plays it, how deep. */
async function worldInsightsDetail(tid: ObjectId, mode: ReviewersMode, now: Date) {
  const scope = await playerScope(mode)
  const days = daySeries(DAYS_30, now)
  const start30 = windowStart(DAYS_30, now)

  const saves = await worldInstances()
    .find(
      { $or: [{ template_id: tid }, { group_template_id: tid }], ...scope },
      { projection: { _id: 1, player_id: 1, 'meta.total_events': 1, 'meta.last_active_at': 1 } },
    )
    .toArray()

  const instanceIds = saves.map((row) => row._id)
  const playerTurns = new Map<string, { player: ObjectId; turns: number; last: Date | null }>()
  const depthCounts = new Map<string, number>()
  for (const save of saves) {
    const turns = saveTurns(save.meta)
    if (turns > 0) {
      const bucket = DEPTH_BUCKETS.find((entry) => turns >= entry.min && turns <= entry.max)!.bucket
      depthCounts.set(bucket, (depthCounts.get(bucket) ?? 0) + 1)
    }
    const key = idString(save.player_id)
    const current = playerTurns.get(key) ?? { player: save.player_id, turns: 0, last: null }
    current.turns += turns
    const last = save.meta?.last_active_at instanceof Date ? save.meta.last_active_at : null
    if (last && (!current.last || last > current.last)) current.last = last
    playerTurns.set(key, current)
  }

  // Turns are `events` (solo and group alike, so a group world's line is no
  // longer flat) and cost is every `llm_calls` row on the save, background calls
  // included. Both are windowed by `created_at` and matched on the world's saves.
  const [turnRows, costRows] = instanceIds.length === 0 ? [[], []] : await Promise.all([
    events().aggregate<{ _id: { day: string; player: ObjectId }; turns: number }>([
      { $match: { instance_id: { $in: instanceIds }, created_at: { $gte: start30 }, ...storyTurnMatch() } },
      { $group: {
        _id: { day: dayExpression, player: '$player_id' },
        turns: { $sum: 1 },
      } },
    ]).toArray(),
    calls().aggregate<{ _id: string; cost_usd: number }>([
      { $match: { instance_id: { $in: instanceIds }, created_at: { $gte: start30 } } },
      { $group: { _id: dayExpression, cost_usd: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
    ]).toArray(),
  ])

  const byDay = new Map<string, { turns: number; cost: number; players: Set<string> }>()
  const entryFor = (day: string) => {
    const entry = byDay.get(day) ?? { turns: 0, cost: 0, players: new Set<string>() }
    byDay.set(day, entry)
    return entry
  }
  for (const row of turnRows) {
    const entry = entryFor(row._id.day)
    entry.turns += Number(row.turns ?? 0)
    if (row._id.player) entry.players.add(idString(row._id.player))
  }
  for (const row of costRows) entryFor(row._id).cost += Number(row.cost_usd ?? 0)

  const daily = days.map((date) => {
    const entry = byDay.get(date)
    return { date, turns: entry?.turns ?? 0, players: entry?.players.size ?? 0, cost_usd: money(entry?.cost ?? 0) }
  })

  const playerIds = [...playerTurns.values()].map((row) => row.player)
  const [people, places] = await Promise.all([
    personRefsByIds(playerIds),
    countriesOfPlayers(playerIds, 10),
  ])

  // Distinct players per gender, over the world's own players. A gone account
  // has no gender, so it counts as unset.
  const gender: WorldGender = { male: 0, female: 0, nonbinary: 0, unset: 0 }
  for (const id of playerIds) {
    const person = people.get(idString(id))
    if (!person || !person.gender) gender.unset++
    else gender[person.gender]++
  }

  const top_players = [...playerTurns.values()]
    .sort((left, right) =>
      right.turns - left.turns
      || (right.last?.getTime() ?? 0) - (left.last?.getTime() ?? 0))
    .slice(0, 10)
    .map((row) => {
      // A deleted account still keeps its row and its link; nothing to name it with.
      const person: PersonRef = people.get(idString(row.player)) ?? {
        id: idString(row.player), name: '', username: '', official: false, reviewer: false,
        internal: false, internal_reason: null, gender: null,
      }
      return { ...person, turns: row.turns, last_played_at: row.last ? row.last.toISOString() : null }
    })

  return {
    daily,
    gender,
    depth: DEPTH_BUCKETS.map(({ bucket }) => ({ bucket, saves: depthCounts.get(bucket) ?? 0 })),
    top_players,
    countries: places.countries,
    country_unknown: places.unknown,
  }
}

export const worldInsights = {
  async list(opts: WorldListOptions) {
    const sort = opts.sort ?? 'created'
    if (!WORLD_SORTS.includes(sort)) throw new HttpError(400, 'Sort must be created, players, turns or last_played.')
    if (opts.kind && !WORLD_KINDS.includes(opts.kind)) throw new HttpError(400, 'Kind must be world, character or group.')
    if (opts.source && !WORLD_SOURCES.includes(opts.source)) throw new HttpError(400, 'Source must be official or community.')
    const mode = opts.reviewers ?? 'exclude'
    const now = new Date()
    const { limit, page, skip } = paging(opts)

    const clauses: Record<string, unknown>[] = []
    if (opts.creator_id) clauses.push({ creator_id: parseObjectId(opts.creator_id) })
    if (opts.published !== undefined) clauses.push({ is_published: opts.published })
    if (opts.kind) clauses.push(kindFilter(opts.kind))
    if (opts.creator && opts.creator.trim()) clauses.push(await creatorFilter(opts.creator.trim()))
    if (opts.source) {
      const official = await officialUserId()
      if (opts.source === 'official') clauses.push({ creator_id: official ?? { $in: [] } })
      else if (official) clauses.push({ creator_id: { $ne: official } })
    }
    if (opts.search) {
      const term = escapeRegex(opts.search)
      clauses.push({ $or: [
        { title: { $regex: term, $options: 'i' } },
        { slug: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
      ] })
    }
    const filter: Record<string, unknown> = clauses.length <= 1 ? (clauses[0] ?? {}) : { $and: clauses }

    const total = await worldTemplates().countDocuments(filter)

    let rows: WorldRow[]
    if (sort === 'created') {
      rows = await worldTemplates()
        .find(filter)
        .sort({ created_at: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray() as WorldRow[]
    } else {
      const pageIds = (await orderByStat(filter, sort, mode)).slice(skip, skip + limit)
      if (pageIds.length === 0) rows = []
      else {
        const found = await worldTemplates().find({ _id: { $in: pageIds } }).toArray() as WorldRow[]
        const byId = new Map(found.map((row) => [idString(row._id), row]))
        rows = pageIds.map((id) => byId.get(idString(id))).filter((row): row is WorldRow => Boolean(row))
      }
    }

    return { total, page, limit, items: await decorate(rows, mode, now) }
  },

  async get(templateId: string, mode: ReviewersMode = 'exclude') {
    const tid = parseObjectId(templateId)
    const template = await worldTemplates().findOne({ _id: tid }) as WorldRow | null
    if (!template) throw new HttpError(404, 'World not found')

    const now = new Date()
    const [row] = await decorate([template], mode, now)
    const insights = await worldInsightsDetail(tid, mode, now)
    const counts = await readCounts(tid)

    return {
      world: serialize(template),
      counts,
      creator: row.creator,
      cover_url: row.cover_url,
      stats: row.stats,
      insights,
    }
  },
}
