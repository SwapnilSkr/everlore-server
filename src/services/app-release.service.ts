import { randomBytes } from 'node:crypto'
import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { AppReleaseDoc, AppUpdateRound } from '../models/app-release.model'
import type { PushDeviceDoc } from '../models/push-device.model'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../queues'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'
import { parseObjectId } from '../utils/mongo-id'
import { reviewerAccounts } from './reviewer-accounts'
import { appUpdateNotification, fcmSender } from './push/fcm'

/**
 * The Android release singleton, its announce push and the automatic reminder
 * rounds (`everlore-docs/phases/update-nudge.md`, "Server contract" and part 2
 * section A).
 *
 * The rule that shapes everything lives with the app, not here: **Play decides
 * whether an update is actually available to a device.** The server only adds
 * the words, the floor below which the app stops, and one push per round of a
 * build. So nothing in this module may guess that a build has reached a phone —
 * the push is an instruction to open the app, where Play answers.
 *
 * Builds are compared, never version strings. Every read is bounded: 30 days for
 * "who is still on which build", 90 days for "who is still here at all" — both
 * over `app_sessions.started_at`, which is indexed.
 */

const ANDROID = 'android'
const STORE_URL = 'https://play.google.com/store/apps/details?id=com.everloreapp'

const DAY_MS = 86_400_000
/** The window `in_use` and the blocked-players gate count. */
const USAGE_DAYS = 30
/** Nobody who has not opened the app for this long is woken. */
const TARGET_DAYS = 90
/** A held device is sent at 10:00 its own time. */
const SEND_HOUR = 10
/** 22:00–09:00 local is someone's night. */
const NIGHT_FROM_HOUR = 22
const NIGHT_UNTIL_HOUR = 9
const NOTES_MAX = 3
const NOTE_MAX_CHARS = 90
/** Play's own ceiling for a versionCode. */
const BUILD_MAX = 2_100_000_000
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const CONFIRM_TTL_MS = 10 * 60_000

/** Rounds 2 and 3 skip a player who opened the app in the last 24 hours. */
const RECENT_ACTIVITY_MS = DAY_MS

/** When each round of a live build falls due, counted from `live_at`. */
const ROUND_DELAY_MS: Record<AppUpdateRound, number> = {
  1: 3_600_000,
  2: 3 * DAY_MS,
  3: 7 * DAY_MS,
}

export const APP_UPDATE_ROUNDS: readonly AppUpdateRound[] = [1, 2, 3]

type EffectiveRelease = {
  latest_build: number
  latest_version: string
  min_build: number
  notes: string[]
}

type AnnounceTargets = { devices: PushDeviceDoc[]; players: number }

function effective(doc: AppReleaseDoc | null): EffectiveRelease {
  return {
    latest_build: doc?.latest_build ?? 0,
    latest_version: doc?.latest_version ?? '0.0.0',
    min_build: doc?.min_build ?? 0,
    notes: doc?.notes ?? [],
  }
}

/**
 * The moment the live build became live. A document saved before rounds existed
 * has no `live_at`, and its last edit is the closest honest stand-in — never
 * "now", which would move the rounds forward on every read.
 */
function liveAtOf(doc: AppReleaseDoc | null): Date | undefined {
  return doc?.live_at ?? doc?.updated_at
}

export function roundDueAt(liveAt: Date, round: AppUpdateRound): Date {
  return new Date(liveAt.getTime() + ROUND_DELAY_MS[round])
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

async function storedRelease(): Promise<AppReleaseDoc | null> {
  return mongoColl.appRelease().findOne({ _id: ANDROID })
}

/**
 * The public read is what every app start asks for, so it is cached for a few
 * seconds — the same middle the billing config uses: long enough that a burst of
 * starts is one read, short enough that an edit is visible at once.
 *
 * A failed read answers "no nudge" rather than an error. A release is the one
 * thing that can stop a player playing, and a database hiccup must never gate
 * the app.
 */
const CACHE_TTL_MS = 5_000
let cache: { at: number; value: AppReleaseDoc | null } | null = null

export function invalidateAppRelease(): void {
  cache = null
}

async function cachedRelease(): Promise<AppReleaseDoc | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
  try {
    const value = await storedRelease()
    cache = { at: Date.now(), value }
    return value
  } catch (error) {
    log.error('app_release.read_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** `GET /app/release`: exactly these five keys, nothing else. */
export async function publicRelease(): Promise<EffectiveRelease & { store_url: string }> {
  const value = effective(await cachedRelease())
  return {
    latest_build: value.latest_build,
    latest_version: value.latest_version,
    min_build: value.min_build,
    notes: value.notes,
    store_url: STORE_URL,
  }
}

function isNight(offsetMinutes: number | undefined, now: Date): boolean {
  if (offsetMinutes === undefined) return false
  const local = (((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes) % 1440) + 1440) % 1440
  return local >= NIGHT_FROM_HOUR * 60 || local < NIGHT_UNTIL_HOUR * 60
}

/** The next 10:00 on the device's own clock, as an instant. */
function nextSendTime(offsetMinutes: number, now: Date): Date {
  const offsetMs = offsetMinutes * 60_000
  const local = now.getTime() + offsetMs
  let target = Math.floor(local / DAY_MS) * DAY_MS + SEND_HOUR * 3_600_000
  while (target <= local) target += DAY_MS
  return new Date(target - offsetMs)
}

/**
 * Each signed-in player's build at their newest session in the window.
 *
 * Only players below `latestBuild` are returned. `playerIds` narrows to the
 * players a held job was queued for; the rest of the rule stays the same, so the
 * morning re-check is the same test as the evening one.
 */
async function signedLatestBuilds(
  latestBuild: number,
  now: Date,
  days: number,
  playerIds?: ObjectId[],
): Promise<Map<string, number>> {
  const behind = new Map<string, number>()
  if (latestBuild <= 0) return behind

  const scope = await reviewerAccounts.scope()
  const userMatch: Record<string, unknown> = { $exists: true }
  if (scope.userIds.length > 0) userMatch.$nin = scope.userIds
  if (playerIds) userMatch.$in = playerIds

  const rows = await mongoColl.appSessions().aggregate<{ _id: ObjectId; build: number }>([
    { $match: { started_at: { $gte: new Date(now.getTime() - days * DAY_MS) }, user_id: userMatch } },
    { $sort: { started_at: -1 } },
    { $group: { _id: '$user_id', build: { $first: '$build' } } },
    { $match: { build: { $lt: latestBuild } } },
  ], { allowDiskUse: true }).toArray()

  for (const row of rows) behind.set(String(row._id), row.build)
  return behind
}

/**
 * Every signed-in player with a session in the window, whatever build they are
 * on. A "what's new" note is for all of them, not only the ones behind.
 *
 * The reader scope is the console's "test and team accounts" set, so review,
 * internal and test accounts are out of it exactly as on every insights read.
 */
export async function activeSignedPlayers(now: Date, days: number): Promise<ObjectId[]> {
  const scope = await reviewerAccounts.scope()
  const userMatch: Record<string, unknown> = { $exists: true }
  if (scope.userIds.length > 0) userMatch.$nin = scope.userIds

  const rows = await mongoColl.appSessions().aggregate<{ _id: ObjectId }>([
    { $match: { started_at: { $gte: new Date(now.getTime() - days * DAY_MS) }, user_id: userMatch } },
    { $group: { _id: '$user_id' } },
  ], { allowDiskUse: true }).toArray()

  return rows.map((row) => row._id)
}

/**
 * Guest installs' builds in the window, keyed by install.
 *
 * An install that signed in during the window is left out: the same phone would
 * otherwise be counted twice, once as an install and once as the account it
 * became.
 */
async function guestLatestBuilds(latestBuild: number, now: Date, days: number): Promise<Map<string, number>> {
  if (latestBuild <= 0) return new Map()
  const scope = await reviewerAccounts.scope()
  const since = new Date(now.getTime() - days * DAY_MS)
  const installMatch: Record<string, unknown> = { $exists: true }
  if (scope.installIds.length > 0) installMatch.$nin = scope.installIds

  let rows = await mongoColl.appSessions().aggregate<{ _id: string; build: number }>([
    { $match: { started_at: { $gte: since }, user_id: { $exists: false }, install_id: installMatch } },
    { $sort: { started_at: -1 } },
    { $group: { _id: '$install_id', build: { $first: '$build' } } },
    { $match: { build: { $lt: latestBuild } } },
  ], { allowDiskUse: true }).toArray()

  if (rows.length > 0) {
    const signedInstalls = new Set(await mongoColl.appSessions().distinct('install_id', {
      started_at: { $gte: since },
      user_id: { $exists: true },
      install_id: { $in: rows.map((row) => row._id) },
    }))
    rows = rows.filter((row) => !signedInstalls.has(row._id))
  }
  return new Map(rows.map((row) => [row._id, row.build]))
}

/** How many distinct players sat on each build in the last 30 days. */
async function buildUsage(now: Date): Promise<Array<{ build: number; players: number }>> {
  const scope = await reviewerAccounts.scope()
  const since = new Date(now.getTime() - USAGE_DAYS * DAY_MS)
  const userMatch: Record<string, unknown> = { $exists: true }
  if (scope.userIds.length > 0) userMatch.$nin = scope.userIds
  const installMatch: Record<string, unknown> = { $exists: true }
  if (scope.installIds.length > 0) installMatch.$nin = scope.installIds

  const [signed, guests] = await Promise.all([
    mongoColl.appSessions().aggregate<{ _id: number; players: number }>([
      { $match: { started_at: { $gte: since }, user_id: userMatch } },
      { $group: { _id: { build: '$build', who: '$user_id' } } },
      { $group: { _id: '$_id.build', players: { $sum: 1 } } },
    ], { allowDiskUse: true }).toArray(),
    mongoColl.appSessions().aggregate<{ _id: { build: number; install: string } }>([
      { $match: { started_at: { $gte: since }, user_id: { $exists: false }, install_id: installMatch } },
      { $group: { _id: { build: '$build', install: '$install_id' } } },
    ], { allowDiskUse: true }).toArray(),
  ])

  let guestRows = guests
  if (guestRows.length > 0) {
    const signedInstalls = new Set(await mongoColl.appSessions().distinct('install_id', {
      started_at: { $gte: since },
      user_id: { $exists: true },
      install_id: { $in: guestRows.map((row) => row._id.install) },
    }))
    guestRows = guestRows.filter((row) => !signedInstalls.has(row._id.install))
  }

  const perBuild = new Map<number, number>()
  for (const row of signed) perBuild.set(row._id, (perBuild.get(row._id) ?? 0) + row.players)
  for (const row of guestRows) perBuild.set(row._id.build, (perBuild.get(row._id.build) ?? 0) + 1)
  return [...perBuild]
    .map(([build, players]) => ({ build, players }))
    .sort((left, right) => right.build - left.build)
}

/**
 * Active players a floor would block: their newest session in the last 30 days
 * is below it. Review and team accounts are left out as on every insights read.
 */
async function blockedPlayers(minBuild: number, now: Date): Promise<number> {
  const [signed, guests] = await Promise.all([
    signedLatestBuilds(minBuild, now, USAGE_DAYS),
    guestLatestBuilds(minBuild, now, USAGE_DAYS),
  ])
  return signed.size + guests.size
}

/**
 * Who a round reaches: devices of players below the live build.
 *
 * Rounds 2 and 3 also leave out a player who opened the app in the last 24
 * hours. Play has told them already and they chose; the in-app sheet still
 * covers them.
 */
async function roundTargets(build: number, round: AppUpdateRound, now: Date): Promise<AnnounceTargets> {
  const behind = await signedLatestBuilds(build, now, TARGET_DAYS)
  if (behind.size === 0) return { devices: [], players: 0 }

  if (round >= 2) {
    const recent = await mongoColl.appSessions().distinct('user_id', {
      started_at: { $gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) },
      user_id: { $in: [...behind.keys()].map(parseObjectId) },
    })
    for (const player of recent) behind.delete(String(player))
    if (behind.size === 0) return { devices: [], players: 0 }
  }

  const devices = await mongoColl.pushDevices()
    .find({ player_id: { $in: [...behind.keys()].map(parseObjectId) } })
    .toArray()
  return { devices, players: new Set(devices.map((device) => String(device.player_id))).size }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send these settings as an object.')
  }
  return body as Record<string, unknown>
}

function refuseUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key))
  if (unknown) throw new HttpError(400, `Unknown field: ${unknown}.`)
}

function wholeBuild(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > BUILD_MAX) {
    throw new HttpError(400, `${field} must be a whole number between 0 and ${BUILD_MAX.toLocaleString('en-US')}.`)
  }
  return value
}

export type ReleaseInput = EffectiveRelease & { confirm_block?: boolean; auto_reminders?: boolean }

function releaseBody(body: unknown): ReleaseInput {
  const input = asObject(body)
  refuseUnknown(input, ['latest_build', 'latest_version', 'min_build', 'notes', 'confirm_block', 'auto_reminders'])

  const latest_build = wholeBuild(input.latest_build, 'Latest build')
  const min_build = wholeBuild(input.min_build, 'Minimum build')
  if (typeof input.latest_version !== 'string' || !VERSION_PATTERN.test(input.latest_version)) {
    throw new HttpError(400, 'The version must look like 1.0.14.')
  }
  if (!Array.isArray(input.notes)) throw new HttpError(400, "What's new must be a list of up to three lines.")
  if (input.notes.length > NOTES_MAX) throw new HttpError(400, "What's new can have at most three lines.")
  const notes = input.notes.map((note) => {
    if (typeof note !== 'string') throw new HttpError(400, "Each line of what's new must be text.")
    const trimmed = note.trim()
    if (trimmed.length < 1 || trimmed.length > NOTE_MAX_CHARS) {
      throw new HttpError(400, `Each line of what's new must be between 1 and ${NOTE_MAX_CHARS} characters.`)
    }
    return trimmed
  })
  if (input.confirm_block !== undefined && typeof input.confirm_block !== 'boolean') {
    throw new HttpError(400, 'confirm_block must be true or false.')
  }
  if (input.auto_reminders !== undefined && typeof input.auto_reminders !== 'boolean') {
    throw new HttpError(400, 'auto_reminders must be true or false.')
  }
  if (min_build > latest_build) {
    throw new HttpError(400, 'The minimum build cannot be higher than the latest build.')
  }
  return {
    latest_build,
    latest_version: input.latest_version,
    min_build,
    notes,
    ...(input.confirm_block !== undefined ? { confirm_block: input.confirm_block } : {}),
    ...(input.auto_reminders !== undefined ? { auto_reminders: input.auto_reminders } : {}),
  }
}

type AnnounceInput = { dry_run: boolean; confirm?: string }

function announceBody(body: unknown): AnnounceInput {
  const input = asObject(body)
  refuseUnknown(input, ['dry_run', 'confirm'])
  if (typeof input.dry_run !== 'boolean') throw new HttpError(400, 'dry_run must be true or false.')
  if (input.confirm !== undefined && typeof input.confirm !== 'string') {
    throw new HttpError(400, 'The confirmation must be the token from the check.')
  }
  return { dry_run: input.dry_run, ...(input.confirm !== undefined ? { confirm: input.confirm } : {}) }
}

// ─────────────────────────────────────────────────────────────────────────────
// The confirmation token: server-side, single use, ten minutes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a token is good for. A token from an update check can never publish a
 * note, and the other way round: both are "send this to every phone", and a
 * crossed pair would send the wrong thing.
 */
export type ConfirmKind = 'app_update' | 'whats_new'

const pendingConfirms = new Map<string, { kind: ConfirmKind; build: number; expires: number }>()

export function issueConfirm(kind: ConfirmKind, build: number, now: Date): string {
  for (const [token, entry] of pendingConfirms) {
    if (entry.expires <= now.getTime()) pendingConfirms.delete(token)
  }
  const token = randomBytes(24).toString('base64url')
  pendingConfirms.set(token, { kind, build, expires: now.getTime() + CONFIRM_TTL_MS })
  return token
}

/** Spent whether or not it was still valid: a replayed token is never accepted. */
export function consumeConfirm(token: string, kind: ConfirmKind, build: number, now: Date): void {
  const entry = pendingConfirms.get(token)
  pendingConfirms.delete(token)
  if (!entry || entry.expires <= now.getTime() || entry.build !== build || entry.kind !== kind) {
    throw new HttpError(400, 'That confirmation has expired. Run the check again.')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /admin/app-release`: the singleton, who is on each build, who is behind. */
export async function adminRelease(now = new Date()) {
  const doc = await storedRelease()
  const value = effective(doc)
  const [in_use, behind] = await Promise.all([
    buildUsage(now),
    (async () => {
      const players = await signedLatestBuilds(value.latest_build, now, TARGET_DAYS)
      if (players.size === 0) return 0
      const withDevice = await mongoColl.pushDevices()
        .distinct('player_id', { player_id: { $in: [...players.keys()].map(parseObjectId) } })
      return withDevice.length
    })(),
  ])

  const liveAt = liveAtOf(doc)
  const rounds = value.latest_build > 0 && liveAt
    ? APP_UPDATE_ROUNDS.map((round) => {
      const sent = (doc?.announced ?? [])
        .find((entry) => entry.build === value.latest_build && entry.round === round)
      return {
        round,
        due_at: roundDueAt(liveAt, round),
        ...(sent ? { sent_at: sent.at, devices: sent.devices } : {}),
      }
    })
    : []

  return {
    _id: ANDROID,
    ...value,
    ...(doc?.updated_at ? { updated_at: doc.updated_at } : {}),
    ...(liveAt ? { live_at: liveAt } : {}),
    auto_reminders: doc?.auto_reminders !== false,
    announced: (doc?.announced ?? []).map((entry) => ({
      build: entry.build,
      round: entry.round,
      at: entry.at,
      by: entry.by,
      devices: entry.devices,
    })),
    rounds,
    in_use,
    behind,
  }
}

/**
 * `PUT /admin/app-release`.
 *
 * The floor is the dangerous field: one typo locks every player out. So raising
 * it over a build that active players still use is refused with their count
 * unless the console has shown that number and confirmed.
 *
 * Saving a different `latest_build` is the owner saying "this is live on Play",
 * so that is the one write that moves `live_at` — and with it the three reminder
 * rounds. Editing the words of the same build leaves the schedule where it is.
 */
export async function saveRelease(body: unknown, now = new Date()) {
  const input = releaseBody(body)
  const doc = await storedRelease()
  const previous = effective(doc)

  if (input.min_build > previous.min_build) {
    const blocked = await blockedPlayers(input.min_build, now)
    if (blocked > 0 && input.confirm_block !== true) {
      throw new HttpError(
        409,
        `${blocked} players are still on an older version. Confirm that they should be blocked before saving.`,
        { blocked_players: blocked },
      )
    }
  }

  const buildChanged = input.latest_build !== previous.latest_build
  await mongoColl.appRelease().updateOne(
    { _id: ANDROID },
    {
      $set: {
        latest_build: input.latest_build,
        latest_version: input.latest_version,
        min_build: input.min_build,
        notes: input.notes,
        updated_at: now,
        // `live_at` moves only when the build does, and only to a build that can
        // be nudged: a zero build is "nothing is live", not a release.
        ...(buildChanged && input.latest_build > 0 ? { live_at: now } : {}),
        ...(input.auto_reminders !== undefined ? { auto_reminders: input.auto_reminders } : {}),
      },
      $setOnInsert: { announced: [] },
    },
    { upsert: true },
  )
  invalidateAppRelease()
  return adminRelease(now)
}

/**
 * `POST /admin/app-release/announce`: round 1, sent by hand.
 *
 * A dry run counts who would get it and hands back a token; the real send needs
 * that token. The target set is recomputed at send time, because a player may
 * have updated between the two clicks. Devices whose local clock reads 22:00–09:00
 * are not rung: they are queued for 10:00 their time.
 *
 * This is the same round the hourly job would send at `live_at` + 1 h, so the
 * owner's press and the schedule share one `(build, 1)` guard and a build is
 * still announced once.
 */
export async function announce(body: unknown, adminUser: string, now = new Date()) {
  const input = announceBody(body)
  const release = effective(await storedRelease())
  if (release.latest_build <= 0) throw new HttpError(400, 'There is no release to announce yet.')
  const build = release.latest_build

  if (input.dry_run) {
    const targets = await roundTargets(build, 1, now)
    return {
      build,
      devices: targets.devices.length,
      players: targets.players,
      confirm: issueConfirm('app_update', build, now),
    }
  }

  if (!input.confirm) throw new HttpError(400, 'A confirmation from the check is required.')
  consumeConfirm(input.confirm, 'app_update', build, now)
  if (!fcmSender.configured()) throw new HttpError(503, 'Push is not switched on, so nothing was sent.')

  if (!await reserveRound(build, 1, adminUser, now)) {
    throw new HttpError(409, 'This build has already been announced.')
  }
  const sent = await deliverRound(build, release, now, 1)
  return { build, devices: sent.devices, held: sent.held, players: sent.players }
}

/**
 * Reserve one round of one build before anything leaves.
 *
 * The `(build, round)` pair is the guard, and the build is part of the filter:
 * a build replaced between the read and this write gets no round from a stale
 * pass. Reserved with no devices so an hourly job cannot send the same round
 * twice while the first is still going out.
 */
async function reserveRound(build: number, round: AppUpdateRound, by: string, now: Date): Promise<boolean> {
  const reserved = await mongoColl.appRelease().updateOne(
    { _id: ANDROID, latest_build: build, announced: { $not: { $elemMatch: { build, round } } } },
    { $push: { announced: { build, round, at: now, by, devices: 0 } } },
  )
  return reserved.matchedCount > 0
}

/** Whether a round of a build has already gone out. */
function roundSent(doc: AppReleaseDoc | null, build: number, round: AppUpdateRound): boolean {
  return (doc?.announced ?? []).some((entry) => entry.build === build && entry.round === round)
}

/** The device count of a round, filled in once its phones are decided. */
async function recordRoundDevices(build: number, round: AppUpdateRound, devices: number): Promise<void> {
  await mongoColl.appRelease().updateOne(
    { _id: ANDROID, announced: { $elemMatch: { build, round } } },
    { $set: { 'announced.$.devices': devices } },
  )
}

/**
 * Send one reserved round. Returns what actually went out, not what was planned:
 * a provider failure means that phone was not reached, and saying otherwise
 * would make the console's number a lie.
 */
async function deliverRound(
  build: number,
  release: EffectiveRelease,
  now: Date,
  round: AppUpdateRound,
): Promise<{ devices: number; held: number; players: number }> {
  const targets = await roundTargets(build, round, now)
  const immediate = targets.devices.filter((device) => !isNight(device.tz_offset_minutes, now))
  const night = targets.devices.filter((device) => isNight(device.tz_offset_minutes, now))

  const payload = appUpdateNotification(release.notes[0], build)
  const results = await Promise.allSettled(immediate.map((device) => fcmSender.send(device, payload)))
  const devices = results.filter((result) => result.status === 'fulfilled' && result.value).length
  const held = await queueHeld(build, round, night, now)
  await recordRoundDevices(build, round, devices + held)
  return { devices, held, players: targets.players }
}

/**
 * Queue one delayed job per device clock, so each held phone is woken at 10:00
 * *its* time rather than a single instant. A queue failure is logged and does
 * not undo the round: the immediate phones have already been decided.
 */
async function queueHeld(build: number, round: AppUpdateRound, devices: PushDeviceDoc[], now: Date): Promise<number> {
  if (devices.length === 0) return 0
  const byOffset = new Map<number, Set<string>>()
  for (const device of devices) {
    const offset = device.tz_offset_minutes as number
    const players = byOffset.get(offset) ?? new Set<string>()
    players.add(String(device.player_id))
    byOffset.set(offset, players)
  }
  try {
    const queue = getMaintenanceQueue()
    for (const [offset, players] of byOffset) {
      const at = nextSendTime(offset, now)
      await queue.add('app-update-held', {
        task: 'app-update-held',
        build,
        playerIds: [...players],
        tzOffsetMinutes: offset,
      }, {
        delay: Math.max(0, at.getTime() - now.getTime()),
        jobId: `app-update-held-${build}-${round}-${offset}-${at.getTime()}`,
        removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
      })
    }
    return devices.length
  } catch (error) {
    log.error('app_release.held_queue_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/**
 * The `app-update-rounds` job: send every round that is due and unsent for the
 * build that is live now.
 *
 * A round is measured from `live_at`, so a missing hour catches up on the next
 * run — once, because the `(build, round)` guard is reserved before any phone is
 * rung. A build replaced by a newer one is no longer the current build, so its
 * remaining rounds never send.
 */
export async function sendDueRounds(now = new Date()): Promise<{
  build: number
  sent: Array<{ round: AppUpdateRound; devices: number; held: number; players: number }>
}> {
  const doc = await storedRelease()
  const release = effective(doc)
  if (release.latest_build <= 0) return { build: 0, sent: [] }
  if (doc?.auto_reminders === false) return { build: release.latest_build, sent: [] }
  // A round that cannot be pushed must not be marked sent: the switch being off
  // is a temporary state, and the next hour should try again.
  if (!fcmSender.configured()) return { build: release.latest_build, sent: [] }

  const liveAt = liveAtOf(doc)
  if (!liveAt) return { build: release.latest_build, sent: [] }

  const sent: Array<{ round: AppUpdateRound; devices: number; held: number; players: number }> = []
  for (const round of APP_UPDATE_ROUNDS) {
    if (now.getTime() < roundDueAt(liveAt, round).getTime()) continue
    if (!await reserveRound(release.latest_build, round, 'automatic', now)) continue
    const result = await deliverRound(release.latest_build, release, now, round)
    sent.push({ round, ...result })
  }
  if (sent.length > 0) {
    log.info('app_release.rounds_sent', { build: release.latest_build, rounds: sent.map((entry) => entry.round) })
  }
  return { build: release.latest_build, sent }
}

/**
 * The `app-update-held` job: send the phones it held, for players who are still
 * behind. Someone who updated overnight now has a session on the new build and
 * is skipped; someone who uninstalled has no device left.
 */
export async function sendHeldAppUpdate(
  data: { build: number; playerIds: string[]; tzOffsetMinutes: number },
  now = new Date(),
): Promise<{ sent: number }> {
  if (!fcmSender.configured()) return { sent: 0 }
  const playerIds = (data.playerIds ?? []).map(parseObjectId)
  const behind = await signedLatestBuilds(data.build, now, TARGET_DAYS, playerIds)
  if (behind.size === 0) return { sent: 0 }

  const devices = await mongoColl.pushDevices().find({
    player_id: { $in: [...behind.keys()].map(parseObjectId) },
    tz_offset_minutes: data.tzOffsetMinutes,
  }).toArray()
  if (devices.length === 0) return { sent: 0 }

  const release = effective(await storedRelease())
  const payload = appUpdateNotification(release.notes[0], data.build)
  const results = await Promise.allSettled(devices.map((device) => fcmSender.send(device, payload)))
  return { sent: results.filter((result) => result.status === 'fulfilled' && result.value).length }
}
