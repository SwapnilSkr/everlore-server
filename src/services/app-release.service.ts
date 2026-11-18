import { randomBytes } from 'node:crypto'
import type { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import type { AppReleaseDoc } from '../models/app-release.model'
import type { PushDeviceDoc } from '../models/push-device.model'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../queues'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'
import { parseObjectId } from '../utils/mongo-id'
import { reviewerAccounts } from './reviewer-accounts'
import { appUpdateNotification, fcmSender } from './push/fcm'

/**
 * The Android release singleton and its announce push
 * (`everlore-docs/phases/update-nudge.md`).
 *
 * The rule that shapes everything lives with the app, not here: **Play decides
 * whether an update is actually available to a device.** The server only adds
 * the words, the floor below which the app stops, and one owner-triggered push
 * per build. So nothing in this module may guess that a build has reached a
 * phone — the push is an instruction to open the app, where Play answers.
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

/** Who an announcement reaches: devices of players below the live build. */
async function announceTargets(build: number, now: Date): Promise<AnnounceTargets> {
  const behind = await signedLatestBuilds(build, now, TARGET_DAYS)
  if (behind.size === 0) return { devices: [], players: 0 }
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

type ReleaseInput = EffectiveRelease & { confirm_block?: boolean }

function releaseBody(body: unknown): ReleaseInput {
  const input = asObject(body)
  refuseUnknown(input, ['latest_build', 'latest_version', 'min_build', 'notes', 'confirm_block'])

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
  if (min_build > latest_build) {
    throw new HttpError(400, 'The minimum build cannot be higher than the latest build.')
  }
  return {
    latest_build,
    latest_version: input.latest_version,
    min_build,
    notes,
    ...(input.confirm_block !== undefined ? { confirm_block: input.confirm_block } : {}),
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

const pendingConfirms = new Map<string, { build: number; expires: number }>()

function issueConfirm(build: number, now: Date): string {
  for (const [token, entry] of pendingConfirms) {
    if (entry.expires <= now.getTime()) pendingConfirms.delete(token)
  }
  const token = randomBytes(24).toString('base64url')
  pendingConfirms.set(token, { build, expires: now.getTime() + CONFIRM_TTL_MS })
  return token
}

/** Spent whether or not it was still valid: a replayed token is never accepted. */
function consumeConfirm(token: string, build: number, now: Date): void {
  const entry = pendingConfirms.get(token)
  pendingConfirms.delete(token)
  if (!entry || entry.expires <= now.getTime() || entry.build !== build) {
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

  return {
    _id: ANDROID,
    ...value,
    ...(doc?.updated_at ? { updated_at: doc.updated_at } : {}),
    announced: (doc?.announced ?? []).map((entry) => ({
      build: entry.build,
      at: entry.at,
      by: entry.by,
      devices: entry.devices,
    })),
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
 */
export async function saveRelease(body: unknown, now = new Date()) {
  const input = releaseBody(body)
  const doc = await storedRelease()
  const previous = effective(doc).min_build

  if (input.min_build > previous) {
    const blocked = await blockedPlayers(input.min_build, now)
    if (blocked > 0 && input.confirm_block !== true) {
      throw new HttpError(
        409,
        `${blocked} players are still on an older version. Confirm that they should be blocked before saving.`,
        { blocked_players: blocked },
      )
    }
  }

  await mongoColl.appRelease().updateOne(
    { _id: ANDROID },
    {
      $set: {
        latest_build: input.latest_build,
        latest_version: input.latest_version,
        min_build: input.min_build,
        notes: input.notes,
        updated_at: now,
      },
      $setOnInsert: { announced: [] },
    },
    { upsert: true },
  )
  invalidateAppRelease()
  return adminRelease(now)
}

/**
 * `POST /admin/app-release/announce`.
 *
 * A dry run counts who would get it and hands back a token; the real send needs
 * that token. The target set is recomputed at send time, because a player may
 * have updated between the two clicks. Devices whose local clock reads 22:00–09:00
 * are not rung: they are queued for 10:00 their time.
 */
export async function announce(body: unknown, adminUser: string, now = new Date()) {
  const input = announceBody(body)
  const release = effective(await storedRelease())
  if (release.latest_build <= 0) throw new HttpError(400, 'There is no release to announce yet.')
  const build = release.latest_build

  if (input.dry_run) {
    const targets = await announceTargets(build, now)
    return {
      build,
      devices: targets.devices.length,
      players: targets.players,
      confirm: issueConfirm(build, now),
    }
  }

  if (!input.confirm) throw new HttpError(400, 'A confirmation from the check is required.')
  consumeConfirm(input.confirm, build, now)
  if (!fcmSender.configured()) throw new HttpError(503, 'Push is not switched on, so nothing was sent.')

  const targets = await announceTargets(build, now)
  const immediate = targets.devices.filter((device) => !isNight(device.tz_offset_minutes, now))
  const held = targets.devices.filter((device) => isNight(device.tz_offset_minutes, now))

  // Reserve the announcement before anything leaves: the guard makes a build
  // announceable once even if two sends race. `devices` is every phone this
  // announcement is for, including the ones held for the morning.
  const reserved = await mongoColl.appRelease().updateOne(
    { _id: ANDROID, 'announced.build': { $ne: build } },
    { $push: { announced: { build, at: now, by: adminUser, devices: immediate.length + held.length } } },
  )
  if (reserved.matchedCount === 0) throw new HttpError(409, 'This build has already been announced.')

  const heldDevices = await queueHeld(build, held, now)
  const payload = appUpdateNotification(release.notes[0], build)
  const results = await Promise.allSettled(immediate.map((device) => fcmSender.send(device, payload)))
  const sent = results.filter((result) => result.status === 'fulfilled' && result.value).length
  return { build, devices: sent, held: heldDevices, players: targets.players }
}

/**
 * Queue one delayed job per device clock, so each held phone is woken at 10:00
 * *its* time rather than a single instant. A queue failure is logged and does
 * not undo the announcement: the immediate phones have already been decided.
 */
async function queueHeld(build: number, devices: PushDeviceDoc[], now: Date): Promise<number> {
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
        jobId: `app-update-held-${build}-${offset}-${at.getTime()}`,
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
