import { ObjectId } from 'mongodb'
import { env } from '../../config/env'
import { mongoColl } from '../../config/mongo'
import { HttpError } from '../../utils/http-error'
import { log } from '../../utils/logger'
import { STORY_TURN_TYPES } from '../admin-activity'
import { readPlayInstalls } from '../play-installs.service'
import { categoryForClass } from './classify'
import { compareVersions, versionEntries } from './groups.service'
import {
  appDailyRollupService, dayRange, medianFromHist, mergeHist, summarizeEvents, utcDayOf,
} from './rollup.service'
import { deriveTriageState, enqueueTriage, TRIAGE_CLASSES, triageService } from './triage.service'
import type { AppDailyDoc, AppErrorGroupDoc, ErrorGroupStatus, TriageState } from './types'

/**
 * The admin's window on the app (`everlore-docs/phases/analytics.md` §4.6).
 *
 * Every window figure comes from `app_daily`, so a 90-day request reads at most
 * 90 tiny rows rather than 90 days of events. The exceptions are the ones that
 * are about people rather than counts — the funnel cohort and a group's affected
 * players — which read the raw rows they need, bounded by the cohort or the
 * fingerprint.
 *
 * Shapes follow §4.6a–b: a field the server cannot know is `null`, never
 * omitted, because the console renders the contract rather than guessing.
 */

const DAY_MS = 86_400_000
const DEFAULT_DAYS = 30
const MIN_DAYS = 7
const MAX_DAYS = 90
const FINGERPRINT = /^[0-9a-f]{40}$/
const OBJECT_ID = /^[0-9a-f]{24}$/i
const MAX_LIMIT = 200
const SAMPLE_LIMIT = 5
const ERROR_HISTORY_DAYS = 30

export const ERROR_VIEWS = ['needs_look', 'confirmed', 'resolved', 'ignored', 'all'] as const
export type ErrorView = (typeof ERROR_VIEWS)[number]

/** §4.6b: the funnel steps a session can have dropped at. `first_open` has no step before it. */
export const DROP_STEPS = ['started', 'opened_world', 'first_turn', 'returned_d1'] as const
export type DropStep = (typeof DROP_STEPS)[number]

/** §4.6a: `days` is 7–90 (default 30), and anything else is a 400. */
export function daysParam(value?: string): number {
  if (value === undefined) return DEFAULT_DAYS
  const days = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    throw new HttpError(400, 'Days must be a whole number between 7 and 90.')
  }
  return days
}

/**
 * §4.6a: `dropped_at` names a funnel step, not a screen. A screen name here used
 * to match the last step of `screen_path`, which answered a different question
 * than the console's drop-off links ask.
 */
export function dropStepParam(value?: string): DropStep | null {
  if (value === undefined) return null
  if (!(DROP_STEPS as readonly string[]).includes(value)) {
    throw new HttpError(400, 'dropped_at must be one of started, opened_world, first_turn or returned_d1.')
  }
  return value as DropStep
}

export function viewParam(value?: string): ErrorView {
  if (value === undefined) return 'needs_look'
  if (!(ERROR_VIEWS as readonly string[]).includes(value)) {
    throw new HttpError(400, 'View must be one of needs_look, confirmed, resolved, ignored or all.')
  }
  return value as ErrorView
}

export function fingerprintParam(value: string): string {
  if (!FINGERPRINT.test(value)) throw new HttpError(400, 'Not an error group key.')
  return value
}

function objectIdParam(value: string, label: string): ObjectId {
  if (!OBJECT_ID.test(value)) throw new HttpError(400, `${label} must be a 24-character id.`)
  return new ObjectId(value)
}

function dateParam(value: string, label: string): Date {
  const at = new Date(value)
  if (!Number.isFinite(at.getTime())) throw new HttpError(400, `${label} must be an ISO date.`)
  return at
}

function limitParam(value?: string): number {
  if (value === undefined) return 50
  const limit = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HttpError(400, `Limit must be a whole number between 1 and ${MAX_LIMIT}.`)
  }
  return limit
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function iso(when: Date | undefined | null): string | null {
  return when ? new Date(when).toISOString() : null
}

function emptyDay(day: string): AppDailyDoc {
  return {
    _id: day,
    day,
    updated_at: new Date(0),
    sessions: 0,
    funnel: {
      first_opens: 0, sessions_started: 0, sign_ins: 0, signups: 0,
      opened_world: 0, first_turn: 0, returned_d1: 0,
    },
    screens: {},
    actions: {},
    counters: { offline: 0, expected_4xx: 0, image_load: 0, top_4xx: {} },
    errors: { samples: 0, players: 0, groups_new: 0, by_class: {} },
    versions: {},
  }
}

function keyOf(value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value)
}

async function distinctKeys(
  coll: { distinct(field: string, filter: Record<string, unknown>): Promise<unknown[]> },
  field: string,
  filter: Record<string, unknown>,
): Promise<Set<string>> {
  const values = await coll.distinct(field, filter)
  return new Set(values.filter((value) => value !== null && value !== undefined).map(keyOf))
}

/**
 * The stored days for a window, oldest first and every day present.
 *
 * Today may be computed live: the hourly roll can be an hour behind and the
 * console opens on today. An older day with no row is genuinely not rolled yet —
 * `backfillMissing` writes it within the hour — and is reported as an empty day
 * rather than failing the page.
 */
async function dailyRows(days: number, now = new Date()): Promise<AppDailyDoc[]> {
  const range = dayRange(days, now)
  const rows = await mongoColl.appDaily()
    .find({ _id: { $gte: range[0], $lte: range[range.length - 1] } })
    .sort({ _id: 1 })
    .toArray()

  const byDay = new Map(rows.map((row) => [row._id, row]))
  const today = range[range.length - 1]
  if (!byDay.has(today)) byDay.set(today, await appDailyRollupService.computeDay(today))

  return range.map((day) => {
    const row = byDay.get(day)
    if (row) return row
    log.warn('telemetry: daily row missing', { day })
    return emptyDay(day)
  })
}

async function usernamesById(ids: ObjectId[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await mongoColl.users()
    .find({ _id: { $in: ids } }, { projection: { username: 1 } })
    .toArray()
  return new Map(rows.map((row) => [row._id.toHexString(), row.username]))
}

function deviceOf(device: { os: string; os_version?: string; model?: string; form: string } | undefined) {
  return {
    os: device?.os ?? null,
    os_version: device?.os_version ?? null,
    model: device?.model ?? null,
    form: device?.form ?? null,
  }
}

type ScreenTotals = { views: number; players: number; total_ms: number; hist: Record<string, number>; exits: number; next: Record<string, number> }

function mergeScreenTotals(rows: AppDailyDoc[]): Map<string, ScreenTotals> {
  const merged = new Map<string, ScreenTotals>()
  for (const row of rows) {
    for (const [screen, stats] of Object.entries(row.screens)) {
      const total = merged.get(screen) ?? {
        views: 0, players: 0, total_ms: 0, hist: {}, exits: 0, next: {},
      }
      total.views += stats.views
      // Distinct players summed per day: exact for one day, an upper bound over a
      // window. The contract asks for players in a window and the daily row is the
      // only thing that outlives the raw rows it would take to dedupe them.
      total.players += stats.players
      total.total_ms += stats.total_ms
      total.exits += stats.exits
      mergeHist(total.hist, stats.hist ?? {})
      for (const [next, count] of Object.entries(stats.next ?? {})) {
        total.next[next] = (total.next[next] ?? 0) + count
      }
      merged.set(screen, total)
    }
  }
  return merged
}

/** Versions newest first across a set of days. */
function mergedVersions(rows: AppDailyDoc[]): string[] {
  const counts: Record<string, number> = {}
  for (const row of rows) {
    for (const [version, count] of Object.entries(row.versions ?? {})) {
      counts[version] = (counts[version] ?? 0) + count
    }
  }
  return Object.entries(counts)
    .sort((left, right) => compareVersions(right[0], left[0]))
    .map(([version]) => version)
}

function screenItem(screen: string, totals: ScreenTotals, sessions: number) {
  const nextTotal = Object.values(totals.next).reduce((sum, count) => sum + count, 0)
  return {
    screen,
    views: totals.views,
    players: totals.players,
    mean_ms: totals.views > 0 ? Math.round(totals.total_ms / totals.views) : 0,
    median_ms: medianFromHist(totals.hist),
    // §4.6a: the share of the window's sessions that ended here.
    exit_rate: sessions > 0 ? round1((totals.exits / sessions) * 100) : 0,
    next: Object.entries(totals.next)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([next, count]) => ({
        screen: next,
        share: nextTotal > 0 ? round1((count / nextTotal) * 100) : 0,
      })),
  }
}

export type ErrorItem = {
  fingerprint: string
  class: string
  category: string
  context_parts: { screen: string | null; action: string | null; version: string | null }
  explanation: string | null
  suggested_cause: string | null
  triage_state: TriageState
  type: string
  title: string
  top_frame: string | null
  status: ErrorGroupStatus
  first_seen: string | null
  last_seen: string | null
  events: number
  players: number
  on_newest_version: boolean
  versions: Array<{ version: string; count: number }>
  verified_by: string | null
  verified_at: string | null
}

/** §4.5a: the default view — new or back, and one of crash / 2+ players / newest version. */
export function needsLook(item: Pick<ErrorItem, 'status' | 'class' | 'players' | 'on_newest_version'>): boolean {
  if (item.status !== 'new' && item.status !== 'regressed') return false
  return item.class === 'crash' || item.players >= 2 || item.on_newest_version
}

function newestVersionOf(groups: Array<{ versions?: Record<string, number> }>): string | null {
  let newest: string | null = null
  for (const group of groups) {
    for (const entry of versionEntries(group.versions)) {
      if (!newest || compareVersions(entry.version, newest) > 0) newest = entry.version
    }
  }
  return newest
}

/** One cohort for the funnel and its session drop-off filters (§4.6b). */
type FunnelCohort = {
  firstOpens: number
  started: Set<string>
  openedWorld: Set<string>
  firstTurn: Set<string>
  returned: Set<string>
  playerIds: Map<string, ObjectId>
  accounts: { as_guest: number; kept_story: number; claimed: number; merged: number; signed_in_first: number }
  /** Installs first seen in the window without a player: the `started` drop. */
  unsignedInstalls: string[]
}

async function funnelCohort(days: number, now: Date): Promise<FunnelCohort> {
  const range = dayRange(days, now)
  const from = new Date(`${range[0]}T00:00:00Z`)
  const window = { $gte: from, $lte: now }

  const [userRows, mergeRows, firstOpens, unsignedInstalls] = await Promise.all([
    mongoColl.users().find({ $or: [
      { guest_started_at: window },
      { guest_started_at: { $exists: false }, created_at: window },
    ] }, { projection: { _id: 1, created_at: 1, guest: 1, guest_started_at: 1, signed_up_at: 1 } }).toArray(),
    mongoColl.guestMerges().find({ guest_started_at: window }).toArray(),
    mongoColl.appInstalls().countDocuments({ first_seen: window }),
    mongoColl.appInstalls()
      .find({ first_seen: window, user_ids: { $exists: false } }, { projection: { _id: 1 } })
      .toArray(),
  ])

  const starts = [
    ...userRows.map(row => ({ id: row._id, player: row._id,
      at: row.guest_started_at ?? row.created_at,
      kind: row.guest_started_at || row.guest === true ? 'guest' as const : 'direct' as const,
      claimed: row.guest !== true && !!(row.signed_up_at ?? row.created_at),
    })),
    ...mergeRows.map(row => ({ id: row.guest_id, player: row.target_id,
      at: row.guest_started_at, kind: 'merged' as const, claimed: false,
    })),
  ]
  const playerIds = new Map(starts.map(row => [row.id.toHexString(), row.player]))
  const players = [...new Map(starts.map(row => [row.player.toHexString(), row.player])).values()]
  const startDay = new Map(starts.map(row => [row.id.toHexString(), utcDayOf(row.at)]))
  const claimed = starts.filter(row => row.kind === 'guest' && row.claimed).length
  const merged = mergeRows.length
  const accounts = {
    as_guest: starts.filter(row => row.kind !== 'direct').length,
    kept_story: claimed + merged, claimed, merged,
    signed_in_first: starts.filter(row => row.kind === 'direct').length,
  }
  const empty = Promise.resolve(new Set<string>())

  const [viewers, savers, turned, sessionsBack, turnsBack] = await Promise.all([
    players.length > 0
      ? distinctKeys(mongoColl.appEvents(), 'user_id', { name: 'world_viewed', user_id: { $in: players } })
      : empty,
    players.length > 0
      ? distinctKeys(mongoColl.worldInstances(), 'player_id', { player_id: { $in: players } })
      : empty,
    players.length > 0
      ? distinctKeys(mongoColl.events(), 'player_id', {
        player_id: { $in: players },
        type: { $in: STORY_TURN_TYPES },
      })
      : empty,
    // "Came back the next day" needs the day after each start day, so only
    // activity from the earliest possible d1 onwards is fetched.
    players.length > 0
      ? mongoColl.appSessions()
        .find({ user_id: { $in: players }, last_at: { $gte: new Date(from.getTime() + DAY_MS), $lte: now } },
          { projection: { user_id: 1, last_at: 1 } })
        .toArray()
      : [],
    players.length > 0
      ? mongoColl.events()
        .find({
          player_id: { $in: players },
          type: { $in: STORY_TURN_TYPES },
          created_at: { $gte: new Date(from.getTime() + DAY_MS), $lte: now },
        }, { projection: { player_id: 1, created_at: 1 } })
        .toArray()
      : [],
  ])

  // A transferred start reads activity under the target, retaining its own day.
  const returnDays = new Map<string, Set<string>>()
  const addReturnDay = (player: ObjectId, at: Date) => {
    const id = player.toHexString()
    const days = returnDays.get(id) ?? new Set<string>()
    days.add(utcDayOf(at))
    returnDays.set(id, days)
  }
  for (const session of sessionsBack) {
    if (session.user_id) addReturnDay(session.user_id, session.last_at)
  }
  for (const event of turnsBack) {
    if (event.player_id) addReturnDay(event.player_id, event.created_at)
  }
  const reached = (ids: Set<string>) => new Set(starts
    .filter(row => ids.has(row.player.toHexString())).map(row => row.id.toHexString()))
  const returned = new Set(starts.filter(row => {
    const day = startDay.get(row.id.toHexString())!
    const nextDay = utcDayOf(new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY_MS))
    return returnDays.get(row.player.toHexString())?.has(nextDay)
  }).map(row => row.id.toHexString()))

  return {
    firstOpens,
    started: new Set(starts.map(row => row.id.toHexString())),
    openedWorld: reached(new Set([...viewers, ...savers])),
    firstTurn: reached(turned),
    returned, playerIds, accounts,
    unsignedInstalls: unsignedInstalls.map((row) => String(row._id)),
  }
}

/** The players who reached the step before `step` and never reached `step` itself. */
function droppedPlayers(cohort: FunnelCohort, step: DropStep): string[] {
  switch (step) {
    case 'started':
      // `first_open` is install evidence, so this step's drop is installs, not players.
      return []
    case 'opened_world':
      return [...cohort.started].filter((id) => !cohort.openedWorld.has(id))
    case 'first_turn':
      return [...cohort.openedWorld].filter((id) => !cohort.firstTurn.has(id))
    case 'returned_d1':
      return [...cohort.firstTurn].filter((id) => !cohort.returned.has(id))
  }
}

/**
 * The session filter for a drop-off step: the sessions of the people the funnel
 * counts as dropped here. `null` when nobody dropped, so the caller can answer an
 * empty page without querying.
 */
function dropFilter(cohort: FunnelCohort, step: DropStep): Record<string, unknown> | null {
  if (step === 'started') {
    if (cohort.unsignedInstalls.length === 0) return null
    return { install_id: { $in: cohort.unsignedInstalls } }
  }
  const ids = droppedPlayers(cohort, step)
  if (ids.length === 0) return null
  return { user_id: { $in: ids.map((id) => cohort.playerIds.get(id)!) } }
}

export const analyticsService = {
  /**
   * §4.6 funnel: a cohort by start day, computed from what the server knows for
   * certain. The app only supplies the first step — everything after starting is
   * counted from `users`, `world_instances` and story events, so a lost event or
   * an opt-out can never make the funnel lie about turns (§2.2).
   */
  async funnel(daysValue?: string) {
    const days = daysParam(daysValue)
    const now = new Date()
    const range = dayRange(days, now)
    const [installs, cohort] = await Promise.all([readPlayInstalls(), funnelCohort(days, now)])

    const sessionSample = (userIds: Iterable<string>) => {
      const ids = [...userIds].map((id) => cohort.playerIds.get(id)!)
      if (ids.length === 0) return Promise.resolve([] as Array<{ _id: string }>)
      return mongoColl.appSessions()
        .find({ user_id: { $in: ids } }, { projection: { _id: 1 } })
        .sort({ started_at: -1 })
        .limit(SAMPLE_LIMIT)
        .toArray()
    }
    const sessionSampleForInstalls = (installIds: string[]) => {
      if (installIds.length === 0) return Promise.resolve([] as Array<{ _id: string }>)
      return mongoColl.appSessions()
        .find({ install_id: { $in: installIds } }, { projection: { _id: 1 } })
        .sort({ started_at: -1 })
        .limit(SAMPLE_LIMIT)
        .toArray()
    }

    const missingWorld = [...cohort.started].filter((id) => !cohort.openedWorld.has(id))
    const missingTurn = [...cohort.openedWorld].filter((id) => !cohort.firstTurn.has(id))
    const missingReturn = [...cohort.firstTurn].filter((id) => !cohort.returned.has(id))
    const [droppedStarted, droppedWorld, droppedTurn, droppedReturn] = await Promise.all([
      sessionSampleForInstalls(cohort.unsignedInstalls),
      sessionSample(missingWorld),
      sessionSample(missingTurn),
      sessionSample(missingReturn),
    ])

    const steps = [
      { key: 'first_open', label: 'Opened the app', count: cohort.firstOpens, dropped: [] as Array<{ _id: string }> },
      { key: 'started', label: 'Started playing', count: cohort.started.size, dropped: droppedStarted },
      { key: 'opened_world', label: 'Opened a world', count: cohort.openedWorld.size, dropped: droppedWorld },
      { key: 'first_turn', label: 'Played a first turn', count: cohort.firstTurn.size, dropped: droppedTurn },
      { key: 'returned_d1', label: 'Came back the next day', count: cohort.returned.size, dropped: droppedReturn },
    ].map((step, index, all) => ({
      key: step.key,
      label: step.label,
      count: step.count,
      pct_of_prev: index === 0 || all[index - 1].count === 0
        ? (index === 0 ? null : 0)
        : round1((step.count / all[index - 1].count) * 100),
      dropped_sessions: step.dropped.map((row) => String(row._id)),
    }))

    return {
      days,
      generated_at: now.toISOString(),
      installs: {
        available: installs.available,
        reason: installs.reason,
        total: installs.available
          ? range.reduce((sum, day) => sum + (installs.daily[day] ?? 0), 0)
          : null,
      },
      steps,
      accounts: cohort.accounts,
      note: "Installs come from Play and can't be linked to a player.",
    }
  },

  /**
   * §4.6 sessions: recent sessions, newest first, with a `started_at` cursor.
   *
   * `dropped_at` is a funnel step (§4.6a): the drop set is resolved here, once,
   * and applied as a Mongo filter. Filtering after the query instead would make a
   * page short by however many non-matching sessions sat in it, and a page of
   * nothing would end the cursor while matching sessions were still unread.
   */
  async sessions(query: {
    user_id?: string
    install_id?: string
    dropped_at?: string
    days?: string
    version?: string
    limit?: string
    before?: string
  }) {
    const limit = limitParam(query.limit)
    const dropStep = dropStepParam(query.dropped_at)
    // `days` only sizes the drop-off cohort, but a bad value is refused either way.
    const days = daysParam(query.days)

    const conditions: Array<Record<string, unknown>> = []
    if (query.user_id) conditions.push({ user_id: objectIdParam(query.user_id, 'user_id') })
    if (query.install_id) conditions.push({ install_id: query.install_id })
    if (query.version) conditions.push({ app_version: query.version })
    if (query.before) conditions.push({ started_at: { $lt: dateParam(query.before, 'before') } })

    if (dropStep) {
      const scope = dropFilter(await funnelCohort(days, new Date()), dropStep)
      if (!scope) return { items: [], next_before: null }
      conditions.push(scope)
    }

    const rows = await mongoColl.appSessions()
      .find(conditions.length > 0 ? { $and: conditions } : {})
      .sort({ started_at: -1 })
      .limit(limit)
      .toArray()

    const usernames = await usernamesById(
      rows.map((row) => row.user_id).filter((id): id is ObjectId => Boolean(id)),
    )
    const items = rows.map((row) => this.sessionItem(row, usernames))
    return {
      items,
      next_before: items.length > 0 ? items[items.length - 1].started_at : null,
    }
  },

  sessionItem(
    row: {
      _id: string
      install_id: string
      user_id?: ObjectId
      app_version: string
      build: number
      device: { os: string; os_version?: string; model?: string; form: string }
      started_at: Date
      last_at: Date
      screen_path?: Array<{ screen: string; duration_ms: number }>
      counts?: { actions?: number; errors?: number }
    },
    usernames: Map<string, string>,
  ) {
    return {
      id: row._id,
      user: row.user_id
        ? { id: row.user_id.toHexString(), username: usernames.get(row.user_id.toHexString()) ?? null }
        : null,
      install_id: row.install_id,
      app_version: row.app_version,
      build: row.build,
      device: deviceOf(row.device),
      started_at: row.started_at.toISOString(),
      last_at: row.last_at.toISOString(),
      duration_ms: Math.max(0, row.last_at.getTime() - row.started_at.getTime()),
      path: (row.screen_path ?? []).map((step) => ({ screen: step.screen, duration_ms: step.duration_ms })),
      actions: row.counts?.actions ?? 0,
      errors: row.counts?.errors ?? 0,
    }
  },

  /** §4.6 one session: every event and error on it, in order. */
  async session(sessionId: string) {
    const row = await mongoColl.appSessions().findOne({ _id: sessionId })
    if (!row) throw new HttpError(404, 'That session could not be found.')

    const usernames = await usernamesById(row.user_id ? [row.user_id] : [])
    const [events, errors] = await Promise.all([
      mongoColl.appEvents()
        .find({ session_id: sessionId }, {
          projection: { at: 1, name: 1, screen: 1, duration_ms: 1, props: 1 },
        })
        .toArray(),
      mongoColl.appErrors()
        .find({ session_id: sessionId }, {
          projection: { at: 1, fingerprint: 1, class: 1, type: 1, message: 1, screen: 1 },
        })
        .toArray(),
    ])

    const timeline = [
      ...events.map((event) => ({
        at: event.at,
        element: {
          at: event.at.toISOString(),
          kind: 'event' as const,
          name: event.name,
          screen: event.screen ?? null,
          duration_ms: event.duration_ms ?? null,
          props: event.props ?? {},
        },
      })),
      ...errors.map((error) => ({
        at: error.at,
        element: {
          at: error.at.toISOString(),
          kind: 'error' as const,
          fingerprint: error.fingerprint,
          category: categoryForClass(error.class),
          title: error.message ?? error.type,
          screen: error.screen ?? null,
        },
      })),
    ].sort((left, right) => left.at.getTime() - right.at.getTime())

    return {
      session: this.sessionItem(row, usernames),
      timeline: timeline.map((entry) => entry.element),
    }
  },

  /**
   * §4.6 screens over a window.
   *
   * The default path merges the stored days. A `version` filter narrows to one
   * app version, which the daily row does not keep per screen, so that path reads
   * the raw views for the window — sharply bounded by the version itself.
   */
  async screens(daysValue?: string, version?: string) {
    const days = daysParam(daysValue)
    const now = new Date()
    const rows = await dailyRows(days, now)
    const versions = mergedVersions(rows)

    if (version) {
      const range = dayRange(days, now)
      const from = new Date(`${range[0]}T00:00:00Z`)
      const [events, ended] = await Promise.all([
        mongoColl.appEvents()
          .find({ at: { $gte: from, $lte: now }, app_version: version, name: 'screen_view' }, {
            projection: {
              name: 1, screen: 1, duration_ms: 1, user_id: 1, install_id: 1, session_id: 1,
              app_version: 1, at: 1,
            },
          })
          .sort({ session_id: 1, at: 1 })
          .toArray(),
        mongoColl.appSessions()
          .find({ app_version: version, last_at: { $gte: from, $lte: now } }, { projection: { screen_path: 1 } })
          .toArray(),
      ])
      const totals = summarizeEvents(events, ended).screens
      return {
        days,
        items: Object.entries(totals)
          .map(([screen, stats]) => screenItem(screen, {
            views: stats.views,
            players: stats.players,
            total_ms: stats.total_ms,
            hist: stats.hist,
            exits: stats.exits,
            next: stats.next,
          }, ended.length))
          .sort((left, right) => right.views - left.views),
        versions: versions.includes(version) ? versions : [version],
      }
    }

    const totals = mergeScreenTotals(rows)
    const sessions = rows.reduce((sum, row) => sum + row.sessions, 0)
    return {
      days,
      items: [...totals.entries()]
        .map(([screen, total]) => screenItem(screen, total, sessions))
        .sort((left, right) => right.views - left.views),
      versions: mergedVersions(rows),
    }
  },

  /** §4.6 actions over a window, with the per-day series the console draws. */
  async actions(daysValue?: string) {
    const days = daysParam(daysValue)
    const rows = await dailyRows(days)

    const names = new Set<string>()
    for (const row of rows) for (const name of Object.keys(row.actions)) names.add(name)

    const items = [...names].map((name) => {
      let count = 0
      let players = 0
      const props: Record<string, Record<string, number>> = {}
      const daily = rows.map((row) => {
        const action = row.actions[name]
        count += action?.count ?? 0
        players += action?.players ?? 0
        for (const [key, values] of Object.entries(action?.props ?? {})) {
          const bucket = props[key] ?? (props[key] = {})
          for (const [value, valueCount] of Object.entries(values)) {
            bucket[value] = (bucket[value] ?? 0) + valueCount
          }
        }
        return { date: row.day, count: action?.count ?? 0 }
      })

      return {
        name,
        count,
        players,
        daily,
        breakdown: Object.fromEntries(
          Object.entries(props).map(([key, values]) => [
            key,
            Object.entries(values)
              .sort((left, right) => right[1] - left[1])
              .map(([value, valueCount]) => ({ value, count: valueCount })),
          ]),
        ),
      }
    })

    return {
      days,
      items: items.sort((left, right) => right.count - left.count),
    }
  },

  /** §4.6 counters: the three classes that never become a group, per day. */
  async counters(daysValue?: string) {
    const days = daysParam(daysValue)
    const rows = await dailyRows(days)

    const top: Record<string, number> = {}
    const daily = rows.map((row) => {
      for (const [key, count] of Object.entries(row.counters.top_4xx ?? {})) {
        top[key] = (top[key] ?? 0) + count
      }
      return {
        date: row.day,
        offline: row.counters.offline,
        expected_4xx: row.counters.expected_4xx,
        image_load: row.counters.image_load,
      }
    })

    return {
      days,
      daily,
      top_4xx: Object.entries(top)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 10)
        .map(([key, count]) => {
          const [route, status] = key.split('|')
          return { route, status: Number(status), count }
        }),
    }
  },

  async errorItem(group: AppErrorGroupDoc, newest: string | null, since: Date): Promise<ErrorItem> {
    const [userIds, installIds, firstSample] = await Promise.all([
      distinctKeys(mongoColl.appErrors(), 'user_id', { fingerprint: group._id, at: { $gte: since } }),
      distinctKeys(mongoColl.appErrors(), 'install_id', {
        fingerprint: group._id, at: { $gte: since }, user_id: { $exists: false },
      }),
      mongoColl.appErrors().findOne({ fingerprint: group._id }, { sort: { at: 1 } }),
    ])

    const versions = versionEntries(group.versions)
    const lastAction = (firstSample?.breadcrumbs ?? []).filter((crumb) => crumb.kind === 'action').pop()

    return {
      fingerprint: group._id,
      class: group.class,
      category: group.category,
      context_parts: {
        screen: firstSample?.screen ?? null,
        action: lastAction?.name ?? null,
        version: firstSample?.app_version ?? null,
      },
      explanation: group.explanation ?? null,
      suggested_cause: group.triage?.likely_cause ?? null,
      triage_state: deriveTriageState(group),
      type: group.type,
      title: group.title,
      top_frame: group.top_frame ?? null,
      status: group.status,
      first_seen: iso(group.first_seen),
      last_seen: iso(group.last_seen),
      events: group.count,
      // Distinct user ids, with the install id standing in for a sample that was
      // never signed in (§4.6 requirement 2).
      players: new Set([...userIds, ...installIds]).size,
      on_newest_version: newest !== null && versions.some((entry) => entry.version === newest),
      versions,
      verified_by: group.verified_by ?? null,
      verified_at: iso(group.verified_at),
    }
  },

  /** §4.6 errors list, §4.5a view semantics, sorted by players then last seen. */
  async errors(viewValue?: string, daysValue?: string) {
    const view = viewParam(viewValue)
    const days = daysParam(daysValue)
    const from = new Date(new Date().getTime() - (days - 1) * DAY_MS)
    const since = new Date(Date.now() - 7 * DAY_MS)

    const groups = await mongoColl.appErrorGroups()
      .find({ last_seen: { $gte: from } })
      .sort({ last_seen: -1 })
      .toArray()
    const newest = newestVersionOf(groups)
    const all = await Promise.all(groups.map((group) => this.errorItem(group, newest, since)))

    const counts = {
      needs_look: all.filter(needsLook).length,
      confirmed: all.filter((item) => item.status === 'confirmed').length,
      resolved: all.filter((item) => item.status === 'resolved').length,
      ignored: all.filter((item) => item.status === 'ignored').length,
    }

    const items = all
      .filter((item) => {
        if (view === 'all') return true
        if (view === 'needs_look') return needsLook(item)
        return item.status === view
      })
      .sort((left, right) =>
        right.players - left.players ||
        (Date.parse(right.last_seen ?? '') || 0) - (Date.parse(left.last_seen ?? '') || 0))

    return { items, counts }
  },

  /** §4.6 one group: the list item plus its note and its latest samples. */
  async errorDetail(fingerprintValue: string) {
    const fingerprint = fingerprintParam(fingerprintValue)
    const group = await mongoColl.appErrorGroups().findOne({ _id: fingerprint })
    if (!group) throw new HttpError(404, 'That error group could not be found.')

    const since = new Date(Date.now() - 7 * DAY_MS)
    const overview = await mongoColl.appErrorGroups()
      .find({}, { projection: { _id: 1, versions: 1 } })
      .toArray()
    const item = await this.errorItem(group, newestVersionOf(overview), since)

    const range = dayRange(ERROR_HISTORY_DAYS)
    const from = new Date(`${range[0]}T00:00:00Z`)
    const [history, samples] = await Promise.all([
      mongoColl.appErrors()
        .find({ fingerprint, at: { $gte: from } }, { projection: { at: 1 } })
        .toArray(),
      mongoColl.appErrors()
        .find({ fingerprint })
        .sort({ at: -1 })
        .limit(SAMPLE_LIMIT)
        .toArray(),
    ])

    const perDay = new Map<string, number>()
    for (const row of history) {
      const day = utcDayOf(row.at)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }

    const usernames = await usernamesById(
      samples.map((row) => row.user_id).filter((id): id is ObjectId => Boolean(id)),
    )

    return {
      group: {
        ...item,
        note: group.note ?? null,
        suggested_owner: group.triage?.suggested_owner ?? null,
        confidence: group.triage?.confidence ?? null,
        resolved_in_version: group.resolved_in_version ?? null,
      },
      daily: range.map((day) => ({ date: day, count: perDay.get(day) ?? 0 })),
      samples: samples.map((sample) => ({
        id: sample.error_id,
        at: sample.at.toISOString(),
        user: sample.user_id
          ? { id: sample.user_id.toHexString(), username: usernames.get(sample.user_id.toHexString()) ?? null }
          : null,
        session_id: sample.session_id,
        app_version: sample.app_version,
        device: deviceOf(sample.device),
        source: sample.source,
        fatal: sample.fatal,
        message: sample.message ?? null,
        screen: sample.screen ?? null,
        http: sample.http ?? null,
        frames: sample.frames ?? [],
        breadcrumbs: sample.breadcrumbs ?? [],
      })),
    }
  },

  /**
   * §4.6 PATCH. The admin's decision is the only thing here that changes a
   * group: confirming records who said so, and resolving records the version the
   * fix is believed to be in, which is what a later sample is compared against.
   */
  async patchError(fingerprintValue: string, body: {
    status?: ErrorGroupStatus
    explanation?: string
    note?: string
  }, adminUser?: string) {
    const fingerprint = fingerprintParam(fingerprintValue)
    const group = await mongoColl.appErrorGroups().findOne({ _id: fingerprint })
    if (!group) throw new HttpError(404, 'That error group could not be found.')

    const update: Record<string, unknown> = {}
    if (body.status !== undefined) update.status = body.status
    if (body.explanation !== undefined) update.explanation = body.explanation
    if (body.note !== undefined) update.note = body.note

    if (Object.keys(update).length === 0) {
      throw new HttpError(400, 'Send a status, an explanation or a note.')
    }

    if (body.status === 'confirmed') {
      update.verified_by = adminUser || 'admin'
      update.verified_at = new Date()
    }
    if (body.status === 'resolved') {
      const newest = versionEntries(group.versions)[0]
      if (newest) update.resolved_in_version = newest.version
    }

    await mongoColl.appErrorGroups().updateOne({ _id: fingerprint }, { $set: update })
    const detail = await this.errorDetail(fingerprint)
    return { group: detail.group }
  },

  /**
   * §4.6 re-run the note. It counts against the caps like any other call, so the
   * caps are checked before the job is queued and again when it runs.
   */
  async retriage(fingerprintValue: string) {
    const fingerprint = fingerprintParam(fingerprintValue)
    const group = await mongoColl.appErrorGroups().findOne({ _id: fingerprint })
    if (!group) throw new HttpError(404, 'That error group could not be found.')

    if (!TRIAGE_CLASSES.has(group.class) || group.status === 'ignored') {
      return { triage_state: 'not_applicable' as TriageState }
    }
    if (!env.ERROR_TRIAGE_ENABLED) return { triage_state: 'off' as TriageState }
    if ((await triageService.capStatus()) !== 'ok') return { triage_state: 'capped' as TriageState }

    await mongoColl.appErrorGroups().updateOne({ _id: fingerprint }, { $set: { 'triage.state': 'pending' } })
    // A fresh job id: the create-time job is deduplicated by fingerprint, and a
    // re-run has to actually run.
    await enqueueTriage(fingerprint, `${fingerprint}-${Date.now()}`)
    return { triage_state: 'pending' as TriageState }
  },
}
