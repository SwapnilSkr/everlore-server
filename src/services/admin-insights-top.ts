import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { idString } from '../utils/mongo-id'
import { traceStore } from './llm-trace.service'
import { ACCOUNTS_HIDDEN, type AccountFilter } from './reviewer-accounts'
import {
  countryOfUser,
  DAY_MS,
  dayExpression,
  dayExpressionOn,
  daySeries,
  insightDays,
  money,
  personRef,
  playerScope,
  sessionScope,
  storyTurnMatch,
  windowStart,
  type CountrySource,
  type PersonRef,
  type UserRow,
} from './admin-insights'

/**
 * Top and returning players, and how often people play
 * (`everlore-docs/phases/admin-insights.md`, "Contract, part 2b" and "part 2c").
 *
 * "Active" on a day means an app session started, or a story turn was written.
 * Both are counted over UTC days, and review and team accounts are left out by
 * default exactly as everywhere else — the scope is the one every `reviewers=`
 * filter uses.
 *
 * Every read is bounded: sessions by `started_at`, turns by `created_at`, calls
 * by `created_at`, each matched on the ids of the population just read. `mau`
 * reaches 30 days behind each day of the window, so the activity read is
 * `days + 30` — the most `app_sessions` keeps.
 */

const appSessions = () => mongoColl.appSessions()
const events = () => mongoColl.events()
const calls = () => traceStore().calls
const users = () => mongoColl.users()

/** `app_sessions` keeps 90 days; `mau` needs 30 behind each day. */
const SESSION_RETENTION_DAYS = 90
const TRAILING_MAU_DAYS = 30
const TRAILING_WAU_DAYS = 7

export type DailyPoint = { turns: number; sessions: number }

export type TopPlayerRow = PersonRef & {
  turns: number
  /** Distinct UTC days with an app session or a story turn. */
  active_days: number
  /** Distinct worlds with a turn in the window. */
  worlds: number
  cost_usd: number
  country: string | null
  country_source: CountrySource
  created_at: string
  last_active_at: string | null
  /** One entry per UTC day of the window, oldest first (part 2c). */
  daily: DailyPoint[]
}

export type ReturningPlayerRow = PersonRef & {
  active_days: number
  turns: number
  created_at: string
  last_active_at: string | null
  /** Longest run of consecutive active days inside the window. */
  streak_days: number
  daily: DailyPoint[]
}

type DayActivity = { turns: number; sessions: number }

/** player id → UTC day → what happened that day. */
type Activity = Map<string, Map<string, DayActivity>>

function bump(activity: Activity, player: string, day: string, field: keyof DayActivity, by = 1): void {
  const days = activity.get(player) ?? new Map<string, DayActivity>()
  const entry = days.get(day) ?? { turns: 0, sessions: 0 }
  entry[field] += by
  days.set(day, entry)
  activity.set(player, days)
}

/**
 * The accounts and players active in `[from, now]`: a session started, or a
 * story turn written. The two scopes are the ones every filter uses, so a
 * reviewer's account and a reviewer's install both drop out.
 */
async function population(from: Date, now: Date, accounts: AccountFilter): Promise<ObjectId[]> {
  const [sessionFilter, turnFilter] = await Promise.all([sessionScope(accounts), playerScope(accounts)])
  const sessionMatch: Record<string, unknown> = {
    started_at: { $gte: from, $lte: now },
    user_id: { $exists: true },
  }
  const turnMatch: Record<string, unknown> = {
    created_at: { $gte: from, $lte: now },
    player_id: { $exists: true },
    ...storyTurnMatch(),
  }
  const [sessionIds, turnIds] = await Promise.all([
    appSessions().distinct(
      'user_id',
      sessionFilter.length > 0 ? { $and: [sessionMatch, ...sessionFilter] } : sessionMatch,
    ),
    events().distinct('player_id', Object.keys(turnFilter).length > 0 ? { $and: [turnMatch, turnFilter] } : turnMatch),
  ])
  const ids = [...sessionIds, ...turnIds].filter((id): id is ObjectId => id instanceof ObjectId)
  return [...new Map(ids.map((id) => [idString(id), id])).values()]
}

/**
 * Turns and session starts per player per UTC day.
 *
 * Both reads are windowed by their own date field and matched on the
 * population's ids; the session read carries the install half of the scope too,
 * because a normal account can share a device with a review one.
 */
async function dayActivity(ids: ObjectId[], from: Date, now: Date, sessionFilter: Record<string, unknown>[]): Promise<Activity> {
  const activity: Activity = new Map()
  if (ids.length === 0) return activity

  const sessionMatch: Record<string, unknown> = { user_id: { $in: ids }, started_at: { $gte: from, $lte: now } }
  const turnMatch: Record<string, unknown> = { player_id: { $in: ids }, created_at: { $gte: from, $lte: now }, ...storyTurnMatch() }
  const [sessionRows, turnRows] = await Promise.all([
    appSessions().aggregate<{ _id: { player: ObjectId; day: string }; sessions: number }>([
      { $match: sessionFilter.length > 0 ? { $and: [sessionMatch, ...sessionFilter] } : sessionMatch },
      { $group: { _id: { player: '$user_id', day: dayExpressionOn('started_at') }, sessions: { $sum: 1 } } },
    ]).toArray(),
    events().aggregate<{ _id: { player: ObjectId; day: string }; turns: number }>([
      { $match: turnMatch },
      { $group: { _id: { player: '$player_id', day: dayExpression }, turns: { $sum: 1 } } },
    ]).toArray(),
  ])
  for (const row of sessionRows) {
    if (!row._id?.player || !row._id?.day) continue
    bump(activity, idString(row._id.player), row._id.day, 'sessions', Number(row.sessions ?? 0))
  }
  for (const row of turnRows) {
    if (!row._id?.player || !row._id?.day) continue
    bump(activity, idString(row._id.player), row._id.day, 'turns', Number(row.turns ?? 0))
  }
  return activity
}

/** Distinct worlds a player played in the window, from the turns' saves. */
async function worldsByPlayer(ids: ObjectId[], from: Date, now: Date): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (ids.length === 0) return out
  const rows = await events().aggregate<{ _id: { player: ObjectId; instance: ObjectId } }>([
    {
      $match: {
        player_id: { $in: ids },
        instance_id: { $exists: true },
        created_at: { $gte: from, $lte: now },
        ...storyTurnMatch(),
      },
    },
    { $group: { _id: { player: '$player_id', instance: '$instance_id' } } },
  ]).toArray()
  const instanceIds = [...new Map(rows
    .map((row) => row._id?.instance)
    .filter((id): id is ObjectId => id instanceof ObjectId)
    .map((id) => [idString(id), id])).values()]
  if (instanceIds.length === 0) return out

  const saves = await mongoColl.worldInstances()
    .find(
      { _id: { $in: instanceIds } },
      { projection: { template_id: 1, group_template_id: 1 } },
    )
    .toArray()
  const worldOf = new Map<string, string>()
  for (const save of saves) {
    const world = save.group_template_id ?? save.template_id
    if (world) worldOf.set(idString(save._id), idString(world))
  }

  for (const row of rows) {
    if (!row._id?.player || !row._id?.instance) continue
    const world = worldOf.get(idString(row._id.instance))
    if (!world) continue
    const player = idString(row._id.player)
    const worlds = out.get(player) ?? new Set<string>()
    worlds.add(world)
    out.set(player, worlds)
  }
  return out
}

/** Model cost per player over the window: every priced call, background included. */
async function costByPlayer(ids: ObjectId[], from: Date, now: Date): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await calls().aggregate<{ _id: ObjectId; cost: number }>([
    { $match: { player_id: { $in: ids }, created_at: { $gte: from, $lte: now } } },
    { $group: { _id: '$player_id', cost: { $sum: { $ifNull: ['$cost_usd', 0] } } } },
  ]).toArray()
  return new Map(rows.map((row) => [idString(row._id), Number(row.cost ?? 0)]))
}

type PersonRow = UserRow & { created_at?: Date; last_active_at?: Date }

async function userRows(ids: ObjectId[]): Promise<Map<string, PersonRow>> {
  if (ids.length === 0) return new Map()
  const rows = await users().find({ _id: { $in: ids } }, {
    projection: {
      username: 1, reviewer: 1, internal: 1, internal_reason: 1, created_at: 1, last_active_at: 1,
      country: 1, country_hint: 1, 'preferences.player_name': 1, 'preferences.gender': 1,
    },
  }).toArray()
  return new Map(rows.map((row) => [idString(row._id), row as unknown as PersonRow]))
}

/** The window's days, oldest first, with the player's own numbers on each. */
function daily(days: string[], byDay: Map<string, DayActivity> | undefined): DailyPoint[] {
  return days.map((date) => ({
    turns: byDay?.get(date)?.turns ?? 0,
    sessions: byDay?.get(date)?.sessions ?? 0,
  }))
}

/** The longest run of consecutive days present in `active`, inside the window. */
function longestStreak(active: Set<string>, days: string[]): number {
  let best = 0
  let run = 0
  for (const day of days) {
    if (active.has(day)) {
      run++
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

function isoOrNull(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null
}

/**
 * `created_at` is always present on a real account; a fixture or a legacy row
 * without one dates from the epoch, which reads as "not new" rather than
 * crashing the console.
 */
function createdIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString()
}

/** The date from which `mau` has a full trailing window, or null when it always does. */
export function partialFrom(days: number, now: Date): string | null {
  const series = daySeries(days, now)
  const today = new Date(`${series[series.length - 1]}T00:00:00.000Z`).getTime()
  // A session kept 90 days back, a 30-day window ending on day d: d-29 must be
  // no older than today-90, so coverage is complete from today-61.
  const covered = new Date(today - (SESSION_RETENTION_DAYS - TRAILING_MAU_DAYS + 1) * DAY_MS).toISOString().slice(0, 10)
  return series[0] < covered ? covered : null
}

/** The UTC days `[date - back, date + ahead]`. */
function dayRange(date: string, back: number, ahead = 0): string[] {
  const start = new Date(`${date}T00:00:00.000Z`).getTime()
  return Array.from({ length: back + ahead + 1 }, (_, index) =>
    new Date(start + (index - back) * DAY_MS).toISOString().slice(0, 10))
}

function activeWithin(daysSet: Set<string>, date: string, back: number): boolean {
  return dayRange(date, back).some((candidate) => daysSet.has(candidate))
}

export const playerHabitInsights = {
  /**
   * `GET /admin/players/top`: the most active players by turns, and the split
   * of everyone active into new and returning, with the returning players who
   * came on the most days.
   */
  async top(daysValue?: string, accounts: AccountFilter = ACCOUNTS_HIDDEN, now = new Date()) {
    const days = insightDays(daysValue)
    const from = windowStart(days, now)
    const series = daySeries(days, now)
    const sessionFilter = await sessionScope(accounts)
    const ids = await population(from, now, accounts)
    const [activity, worlds, costs, people] = await Promise.all([
      dayActivity(ids, from, now, sessionFilter),
      worldsByPlayer(ids, from, now),
      costByPlayer(ids, from, now),
      userRows(ids),
    ])

    const entries = ids.map((id) => {
      const key = idString(id)
      const user = people.get(key)
      const byDay = activity.get(key)
      const turns = [...(byDay?.values() ?? [])].reduce((sum, entry) => sum + entry.turns, 0)
      const place = user ? countryOfUser(user) : { country: null, source: null as CountrySource }
      const ref = user
        ? personRef(user)
        : {
          id: key, name: '', username: '', official: false, reviewer: false,
          internal: false, internal_reason: null, gender: null,
        }
      return {
        ...ref,
        turns,
        active_days: byDay?.size ?? 0,
        worlds: worlds.get(key)?.size ?? 0,
        cost_usd: money(costs.get(key) ?? 0),
        country: place.country,
        country_source: place.source,
        created_at: createdIso(user?.created_at),
        last_active_at: isoOrNull(user?.last_active_at),
        streak_days: longestStreak(new Set(byDay?.keys() ?? []), series),
        daily: daily(series, byDay),
        created: user?.created_at instanceof Date ? user.created_at : null,
      }
    })

    const top = [...entries]
      .sort((left, right) =>
        right.turns - left.turns
        || right.active_days - left.active_days
        || left.id.localeCompare(right.id))
      .slice(0, 20)
      .map(({ streak_days: _streak, created: _created, ...row }) => row)

    const returningCohort = entries.filter((entry) => !entry.created || entry.created.getTime() < from.getTime())
    const returning = {
      active: entries.length,
      new: entries.length - returningCohort.length,
      returning: returningCohort.length,
      players: returningCohort
        .sort((left, right) =>
          right.active_days - left.active_days
          || right.turns - left.turns
          || left.id.localeCompare(right.id))
        .slice(0, 20)
        // The contract's returning row is narrower than the top row: who they
        // are, how often they came and how long they stayed, and the daily array.
        .map(({ id, name, username, official, reviewer, internal, internal_reason, gender,
          active_days, turns, created_at, last_active_at, streak_days, daily: days }) => ({
          id, name, username, official, reviewer, internal, internal_reason, gender,
          active_days, turns, created_at, last_active_at, streak_days, daily: days,
        })),
    }

    return { days, top, returning }
  },

  /**
   * `GET /admin/players/frequency`: how many days people came, how long a visit
   * lasts, when they play, stickiness, and each day's new / returning /
   * resurrected split.
   */
  async frequency(daysValue?: string, accounts: AccountFilter = ACCOUNTS_HIDDEN, now = new Date()) {
    const days = insightDays(daysValue)
    const from = windowStart(days, now)
    const series = daySeries(days, now)
    const extendedFrom = new Date(from.getTime() - TRAILING_MAU_DAYS * DAY_MS)
    const sessionFilter = await sessionScope(accounts)

    const extendedIds = await population(extendedFrom, now, accounts)
    const [activity, people] = await Promise.all([
      dayActivity(extendedIds, extendedFrom, now, sessionFilter),
      userRows(extendedIds),
    ])
    const activeByPlayer = new Map<string, Set<string>>()
    for (const [player, byDay] of activity) activeByPlayer.set(player, new Set(byDay.keys()))

    // ── How many days: only the window's days count ────────────────────────
    const buckets = { '1': 0, '2-3': 0, '4-7': 0, '8-14': 0, '15+': 0 }
    for (const player of extendedIds) {
      const daysSet = activeByPlayer.get(idString(player)) ?? new Set<string>()
      let count = 0
      for (const date of series) if (daysSet.has(date)) count++
      if (count === 0) continue
      if (count === 1) buckets['1']++
      else if (count <= 3) buckets['2-3']++
      else if (count <= 7) buckets['4-7']++
      else if (count <= 14) buckets['8-14']++
      else buckets['15+']++
    }

    // ── How long a visit lasts, and when it starts ─────────────────────────
    const sessionRows = extendedIds.length === 0 ? [] : await appSessions()
      .find(
        {
          $and: [
            { user_id: { $in: extendedIds }, started_at: { $gte: from, $lte: now } },
            ...sessionFilter,
          ],
        },
        { projection: { started_at: 1, last_at: 1 } },
      )
      .toArray()

    const minutesBuckets = { '<1': 0, '1-5': 0, '5-15': 0, '15-30': 0, '30-60': 0, '60+': 0 }
    const weekHours = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
    for (const session of sessionRows) {
      const started = session.started_at instanceof Date ? session.started_at : null
      if (!started) continue
      const last = session.last_at instanceof Date ? session.last_at : started
      const minutes = Math.max(0, (last.getTime() - started.getTime()) / 60_000)
      if (minutes < 1) minutesBuckets['<1']++
      else if (minutes < 5) minutesBuckets['1-5']++
      else if (minutes < 15) minutesBuckets['5-15']++
      else if (minutes < 30) minutesBuckets['15-30']++
      else if (minutes < 60) minutesBuckets['30-60']++
      else minutesBuckets['60+']++

      // Monday is 0, Sunday is 6, whatever the locale.
      const weekday = (started.getUTCDay() + 6) % 7
      weekHours[weekday][started.getUTCHours()]++
    }

    // ── Stickiness: per day, the trailing windows ──────────────────────────
    const stickiness = series.map((date) => {
      let dau = 0
      let wau = 0
      let mau = 0
      for (const player of extendedIds) {
        const daysSet = activeByPlayer.get(idString(player)) ?? new Set<string>()
        if (daysSet.has(date)) dau++
        if (activeWithin(daysSet, date, TRAILING_WAU_DAYS - 1)) wau++
        if (activeWithin(daysSet, date, TRAILING_MAU_DAYS - 1)) mau++
      }
      return { date, dau, wau, mau }
    })

    // ── Lifecycle: new, returning, back after a break ──────────────────────
    //
    // New means the account was created that day. Otherwise a player active in
    // the seven days before is returning; anyone else has been away at least
    // seven clear days, which is what "back after a break" measures. The three
    // buckets always add up to that day's active players.
    const lifecycle = series.map((date) => {
      let fresh = 0
      let returning = 0
      let resurrected = 0
      for (const player of extendedIds) {
        const key = idString(player)
        const daysSet = activeByPlayer.get(key) ?? new Set<string>()
        if (!daysSet.has(date)) continue
        const created = people.get(key)?.created_at
        const createdDay = created instanceof Date ? created.toISOString().slice(0, 10) : null
        if (createdDay === date) fresh++
        else if (dayRange(date, 7, -1).some((day) => daysSet.has(day))) returning++
        else resurrected++
      }
      return { date, new: fresh, returning, resurrected }
    })

    return {
      days,
      active_days: [
        { bucket: '1' as const, players: buckets['1'] },
        { bucket: '2-3' as const, players: buckets['2-3'] },
        { bucket: '4-7' as const, players: buckets['4-7'] },
        { bucket: '8-14' as const, players: buckets['8-14'] },
        { bucket: '15+' as const, players: buckets['15+'] },
      ],
      session_minutes: [
        { bucket: '<1' as const, sessions: minutesBuckets['<1'] },
        { bucket: '1-5' as const, sessions: minutesBuckets['1-5'] },
        { bucket: '5-15' as const, sessions: minutesBuckets['5-15'] },
        { bucket: '15-30' as const, sessions: minutesBuckets['15-30'] },
        { bucket: '30-60' as const, sessions: minutesBuckets['30-60'] },
        { bucket: '60+' as const, sessions: minutesBuckets['60+'] },
      ],
      week_hours: weekHours,
      stickiness,
      lifecycle,
      partial_from: partialFrom(days, now),
    }
  },
}
