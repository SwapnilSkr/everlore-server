import { ObjectId } from 'mongodb'
import { mongoColl } from '../../config/mongo'
import { log } from '../../utils/logger'
import { idString } from '../../utils/mongo-id'
import { STORY_TURN_TYPES } from '../admin-activity'
import { NON_ACTION_EVENTS } from './schema'
import type { AppDailyAction, AppDailyDoc, AppDailyScreen } from './types'

/**
 * `app_daily` — the permanent daily record of what the app did (§6).
 *
 * The raw rows are forgetful on purpose: events live 90 days, error samples 30.
 * Neither can answer "was last month better than this one" once it has aged out,
 * so each UTC day is folded into counts and sums and kept.
 *
 * Everything here is bounded by **one day**. A day's raw rows are the largest
 * thing this touches, and every cross-day figure the console shows is assembled
 * by the read side from these rows — so re-rolling a day is cheap and idempotent,
 * and a 90-day window never scans 90 days of events.
 *
 * The one figure that cannot be rebuilt from a stored median is a window median,
 * so each screen keeps a histogram as well: whole-second buckets, which is the
 * unit the console shows. A median is the bucket's lower bound, so a value that
 * is not a whole second rounds down.
 */

const DAY_MS = 86_400_000
const HIST_MAX_SECONDS = 6 * 60 * 60
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** UTC calendar day of an instant, `YYYY-MM-DD`. */
export function utcDayOf(when: Date): string {
  return when.toISOString().slice(0, 10)
}

/** The `days` UTC days ending today, oldest first. */
export function dayRange(days: number, now: Date = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, index) =>
    utcDayOf(new Date(today - (days - index - 1) * DAY_MS)))
}

/** Every `YYYY-MM-DD` from `from` to `to` inclusive. */
export function dayRangeBetween(from: string, to: string): string[] {
  const days: string[] = []
  const end = new Date(`${to}T00:00:00Z`).getTime()
  for (let cursor = new Date(`${from}T00:00:00Z`).getTime(); cursor <= end; cursor += DAY_MS) {
    days.push(utcDayOf(new Date(cursor)))
  }
  return days
}

export function histBucket(durationMs: number): number {
  return Math.min(HIST_MAX_SECONDS, Math.max(0, Math.floor(durationMs / 1000)))
}

/**
 * The median of a bucket histogram: the lower bound of the bucket holding the
 * middle value. Whole-second timings are exact; anything finer rounds down.
 *
 * A histogram rather than a list because a 90-day window has to merge 90 of
 * these, and the median of a merged set is not recoverable from per-day medians.
 */
export function medianFromHist(hist: Record<string, number>): number {
  const buckets = Object.entries(hist)
    .map(([bucket, count]) => [Number(bucket), count] as const)
    .sort((left, right) => left[0] - right[0])
  const total = buckets.reduce((sum, [, count]) => sum + count, 0)
  if (total === 0) return 0

  const middle = Math.ceil(total / 2)
  let seen = 0
  for (const [bucket, count] of buckets) {
    seen += count
    if (seen >= middle) return bucket * 1000
  }
  return buckets[buckets.length - 1][0] * 1000
}

export function mergeHist(into: Record<string, number>, from: Record<string, number>): void {
  for (const [bucket, count] of Object.entries(from)) {
    into[bucket] = (into[bucket] ?? 0) + count
  }
}

/**
 * §4.6: `players` counts distinct user ids, falling back to the install id for a
 * session that was never signed in. The prefix keeps the two spaces apart, so an
 * install id can never collide with a user id.
 */
export function playerKey(row: { user_id?: ObjectId; install_id: string }): string {
  return row.user_id ? `u:${row.user_id.toHexString()}` : `i:${row.install_id}`
}

function emptyScreen(): AppDailyScreen {
  return { views: 0, players: 0, total_ms: 0, median_ms: 0, exits: 0, next: {}, hist: {} }
}

type SummarizableEvent = {
  name: string
  screen?: string
  duration_ms?: number
  props?: Record<string, string | number | boolean>
  user_id?: ObjectId
  install_id: string
  session_id: string
  app_version: string
}

/**
 * Screens, actions and versions from one set of events.
 *
 * Shared with the admin read side, which needs the same figures for a single app
 * version (a slice the daily row does not keep), so the console and the stored
 * history can never disagree about what a view or an action is.
 */
export function summarizeEvents(
  events: SummarizableEvent[],
  endedSessions: Array<{ screen_path?: Array<{ screen: string }> }> = [],
): { screens: Record<string, AppDailyScreen>; actions: Record<string, AppDailyAction>; versions: Record<string, number> } {
  const screens: Record<string, AppDailyScreen> = {}
  const actions: Record<string, AppDailyAction> = {}
  const versions: Record<string, number> = {}
  const screenPlayers = new Map<string, Set<string>>()
  const actionPlayers = new Map<string, Set<string>>()
  const screenPaths = new Map<string, string[]>()

  for (const event of events) {
    versions[event.app_version] = (versions[event.app_version] ?? 0) + 1

    if (event.name === 'screen_view' && event.screen) {
      const row = screens[event.screen] ?? (screens[event.screen] = emptyScreen())
      row.views += 1
      row.total_ms += event.duration_ms ?? 0
      const bucket = String(histBucket(event.duration_ms ?? 0))
      row.hist[bucket] = (row.hist[bucket] ?? 0) + 1

      let players = screenPlayers.get(event.screen)
      if (!players) screenPlayers.set(event.screen, players = new Set())
      players.add(playerKey(event))

      let path = screenPaths.get(event.session_id)
      if (!path) screenPaths.set(event.session_id, path = [])
      path.push(event.screen)
      continue
    }

    // Lifecycle events say where a session is, not what the player did.
    if (NON_ACTION_EVENTS.has(event.name)) continue

    const action = actions[event.name] ?? (actions[event.name] = { count: 0, players: 0, props: {} })
    action.count += 1
    for (const [key, value] of Object.entries(event.props ?? {})) {
      const values = action.props[key] ?? (action.props[key] = {})
      const label = String(value)
      values[label] = (values[label] ?? 0) + 1
    }

    let players = actionPlayers.get(event.name)
    if (!players) actionPlayers.set(event.name, players = new Set())
    players.add(playerKey(event))
  }

  for (const [screen, players] of screenPlayers) screens[screen].players = players.size
  for (const [name, players] of actionPlayers) actions[name].players = players.size
  for (const row of Object.values(screens)) row.median_ms = medianFromHist(row.hist)

  // Where people went next: consecutive screen views inside one session.
  for (const path of screenPaths.values()) {
    for (let index = 1; index < path.length; index++) {
      const row = screens[path[index - 1]]
      if (!row) continue
      row.next[path[index]] = (row.next[path[index]] ?? 0) + 1
    }
  }

  // Exit: the screen a session was on when it last reported.
  for (const session of endedSessions) {
    const path = session.screen_path ?? []
    const last = path[path.length - 1]
    if (!last) continue
    const row = screens[last.screen] ?? (screens[last.screen] = emptyScreen())
    row.exits += 1
  }

  return { screens, actions, versions }
}

/**
 * One day, folded from the raw rows and the server's own records.
 *
 * Read-only, and shared with the reader so an unrolled day renders exactly as it
 * would be stored: the job and the console cannot disagree about a day that has
 * not been written yet.
 */
async function computeDay(day: string): Promise<AppDailyDoc> {
  const start = new Date(`${day}T00:00:00Z`)
  const end = new Date(start.getTime() + DAY_MS)
  const inDay = { $gte: start, $lt: end }

  const [
    events,
    endedSessions,
    counterRows,
    errorRows,
    groupsNew,
    firstOpens,
    sessionsStarted,
    signups,
    saves,
    storyTurns,
  ] = await Promise.all([
    mongoColl.appEvents()
      .find({ at: inDay }, {
        projection: {
          name: 1, screen: 1, duration_ms: 1, props: 1, user_id: 1, install_id: 1,
          session_id: 1, app_version: 1, at: 1,
        },
      })
      .sort({ session_id: 1, at: 1 })
      .toArray(),
    mongoColl.appSessions().find({ last_at: inDay }, { projection: { screen_path: 1 } }).toArray(),
    mongoColl.appErrorCounters()
      .find({ day }, { projection: { class: 1, route: 1, status: 1, count: 1 } })
      .toArray(),
    mongoColl.appErrors()
      .find({ at: inDay }, { projection: { class: 1, user_id: 1, install_id: 1 } })
      .toArray(),
    mongoColl.appErrorGroups().countDocuments({ first_seen: inDay }),
    mongoColl.appInstalls().countDocuments({ first_seen: inDay }),
    mongoColl.appSessions().countDocuments({ started_at: inDay }),
    mongoColl.users().countDocuments({ created_at: inDay }),
    mongoColl.worldInstances().find({ created_at: inDay }, { projection: { player_id: 1 } }).toArray(),
    mongoColl.events()
      .find({ created_at: inDay, type: { $in: STORY_TURN_TYPES } }, { projection: { player_id: 1 } })
      .toArray(),
  ])

  const { screens, actions, versions } = summarizeEvents(events, endedSessions)

  const counters = { offline: 0, expected_4xx: 0, image_load: 0, top_4xx: {} as Record<string, number> }
  for (const row of counterRows) {
    if (row.class === 'offline') counters.offline += row.count
    else if (row.class === 'image_load') counters.image_load += row.count
    else if (row.class === 'expected_4xx') {
      counters.expected_4xx += row.count
      if (row.route && row.status !== undefined) {
        const key = `${row.route}|${row.status}`
        counters.top_4xx[key] = (counters.top_4xx[key] ?? 0) + row.count
      }
    }
  }

  const errorPlayers = new Set<string>()
  const byClass: Record<string, number> = {}
  for (const row of errorRows) {
    errorPlayers.add(playerKey(row))
    byClass[row.class] = (byClass[row.class] ?? 0) + 1
  }

  // Opened a world: the detail screen was seen, or a save was created.
  const openedWorld = new Set<string>()
  for (const event of events) {
    if (event.name === 'world_viewed' && event.user_id) openedWorld.add(event.user_id.toHexString())
  }
  for (const save of saves) {
    if (save.player_id) openedWorld.add(save.player_id.toHexString())
  }

  // First turn: a story turn today by a player who has never had one before.
  const turnedToday = [...new Set(storyTurns.map((event) => idString(event.player_id)))]
  let firstTurns = turnedToday.length
  if (turnedToday.length > 0) {
    const earlier = await mongoColl.events()
      .find({
        player_id: { $in: turnedToday.map((id) => new ObjectId(id)) },
        type: { $in: STORY_TURN_TYPES },
        created_at: { $lt: start },
      }, { projection: { player_id: 1 } })
      .toArray()
    const returned = new Set(earlier.map((event) => idString(event.player_id)))
    firstTurns = turnedToday.filter((id) => !returned.has(id)).length
  }

  // Came back the next day. Only knowable once the next day is over, which is
  // why the job re-rolls the two days behind as well as today.
  let returnedD1 = 0
  if (end.getTime() < Date.now()) {
    const signupRows = await mongoColl.users().find({ created_at: inDay }, { projection: { _id: 1 } }).toArray()
    const ids = signupRows.map((row) => row._id)
    if (ids.length > 0) {
      const nextDay = { $gte: end, $lt: new Date(end.getTime() + DAY_MS) }
      const [laterSessions, laterTurns] = await Promise.all([
        mongoColl.appSessions()
          .find({ user_id: { $in: ids }, last_at: nextDay }, { projection: { user_id: 1 } })
          .toArray(),
        mongoColl.events()
          .find({ player_id: { $in: ids }, created_at: nextDay, type: { $in: STORY_TURN_TYPES } },
            { projection: { player_id: 1 } })
          .toArray(),
      ])
      const cameBack = new Set([
        ...laterSessions.map((row) => idString(row.user_id)),
        ...laterTurns.map((event) => idString(event.player_id)),
      ])
      returnedD1 = ids.filter((id) => cameBack.has(id.toHexString())).length
    }
  }

  return {
    _id: day,
    day,
    updated_at: new Date(),
    sessions: endedSessions.length,
    funnel: {
      first_opens: firstOpens,
      sessions_started: sessionsStarted,
      sign_ins: events.filter((event) => event.name === 'sign_in_completed').length,
      signups,
      opened_world: openedWorld.size,
      first_turn: firstTurns,
      returned_d1: returnedD1,
    },
    screens,
    actions,
    counters,
    errors: {
      samples: errorRows.length,
      players: errorPlayers.size,
      groups_new: groupsNew,
      by_class: byClass,
    },
    versions,
  }
}

export const appDailyRollupService = {
  utcDayOf,
  dayRange,
  computeDay,

  /**
   * Write one day. `replaceOne` rather than `$set` so a re-roll also drops a
   * screen or action that a corrected raw row removed — the row is a snapshot,
   * not an accumulation.
   */
  async rollupDay(day: string) {
    if (!DAY.test(day)) throw new Error(`Invalid day: ${day}`)
    const row = await this.computeDay(day)
    await mongoColl.appDaily().replaceOne({ _id: day }, row, { upsert: true })
    return {
      day,
      screens: Object.keys(row.screens).length,
      actions: Object.keys(row.actions).length,
      samples: row.errors.samples,
    }
  },

  /**
   * Roll today and the two days behind it.
   *
   * More than one day because both halves settle late: an event at 23:59 lands
   * in a row already written, and `returned_d1` needs the following day to have
   * happened at all. Re-writing a recent day is cheap and idempotent.
   */
  async rollupRecent(days = 3) {
    const rolled = []
    for (const day of dayRange(days).slice().reverse()) {
      try {
        rolled.push(await this.rollupDay(day))
      } catch (error) {
        log.error('telemetry: app daily rollup failed', {
          day,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return rolled
  },

  /**
   * Write every day that has raw events but no row yet.
   *
   * Bounded by what the raw events still cover, so it is finite by construction
   * and a no-op once the record has caught up.
   */
  async backfillMissing() {
    const oldest = await mongoColl.appEvents()
      .find({}, { projection: { at: 1 } })
      .sort({ at: 1 })
      .limit(1)
      .toArray()
    if (oldest.length === 0) return { checked: 0, written: 0 }

    const existing = new Set(
      (await mongoColl.appDaily().find({}, { projection: { _id: 1 } }).toArray()).map((row) => row._id),
    )
    const days = dayRangeBetween(utcDayOf(oldest[0].at), utcDayOf(new Date()))
    const missing = days.filter((day) => !existing.has(day))

    let written = 0
    for (const day of missing) {
      try {
        await this.rollupDay(day)
        written++
      } catch (error) {
        log.error('telemetry: app daily backfill failed', {
          day,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { checked: days.length, written }
  },
}
