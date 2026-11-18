import type { ObjectId } from 'mongodb'
import { env } from '../config/env'
import { mongoColl } from '../config/mongo'
import type { ReleaseNoteDoc, ReleaseNoteItem } from '../models/release-note.model'
import { getMaintenanceQueue, QUEUE_RETENTION } from '../queues'
import { HttpError } from '../utils/http-error'
import { log } from '../utils/logger'
import { parseObjectId } from '../utils/mongo-id'
import { activeSignedPlayers, consumeConfirm, issueConfirm } from './app-release.service'
import { recordWhatsNewRows } from './notifications.service'
import { fcmSender, whatsNewNotification } from './push/fcm'

/**
 * "What's new" per release (`everlore-docs/phases/update-nudge.md`, part 2,
 * section B).
 *
 * The owner writes the words in the console; the server never filters them by a
 * word list (AGENTS: no hardcoded word lists). What it does enforce is shape: a
 * title that fits a card, 1–6 items, and an image that will actually load —
 * https, on the CDN's own host, so a note can never point the app at a stranger.
 *
 * A draft is never served to a player. Publishing is once: the second press is
 * a 409, because a player who already has the row should not get it again.
 */

const TITLE_MAX = 60
const INTRO_MAX = 200
const ITEMS_MIN = 1
const ITEMS_MAX = 6
const HEADING_MAX = 50
const BODY_MAX = 180
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const BUILD_MAX = 2_100_000_000
/** A note is for players who were here recently, not everyone who ever was. */
const AUDIENCE_DAYS = 90
const DAY_MS = 86_400_000
const SEND_HOUR = 10
const NIGHT_FROM_HOUR = 22
const NIGHT_UNTIL_HOUR = 9

/** The host an image must live on: the CDN's, and nothing else. */
function cdnHost(): string | null {
  const base = env.CDN_BASE_URL?.trim()
  if (!base) return null
  try {
    return new URL(base).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * An image URL is kept only when it is https and served from the CDN's own
 * host. An empty CDN base means no images are accepted at all, rather than
 * every https URL being trusted.
 */
export function acceptedImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'An image link must be a web address.')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new HttpError(400, 'That image link is not a web address.')
  }
  const host = cdnHost()
  if (!host) throw new HttpError(400, 'Images cannot be added yet. Leave the picture out for now.')
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== host) {
    throw new HttpError(400, 'Use an image link from our own pictures address.')
  }
  return url.toString()
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Send this note as an object.')
  }
  return body as Record<string, unknown>
}

function refuseUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key))
  if (unknown) throw new HttpError(400, `Unknown field: ${unknown}.`)
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`)
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new HttpError(400, `${field} must be between 1 and ${max} characters.`)
  }
  return trimmed
}

export type NoteInput = {
  version: string
  title: string
  intro?: string
  items: ReleaseNoteItem[]
}

/** The note as the owner sent it. The build comes from the path, not the body. */
export function noteBody(body: unknown): NoteInput {
  const input = asObject(body)
  refuseUnknown(input, ['version', 'title', 'intro', 'items'])

  if (typeof input.version !== 'string' || !VERSION_PATTERN.test(input.version)) {
    throw new HttpError(400, 'The version must look like 1.0.15.')
  }
  const title = text(input.title, 'The title', TITLE_MAX)
  const intro = input.intro === undefined || input.intro === null
    ? undefined
    : text(input.intro, 'The intro', INTRO_MAX)

  if (!Array.isArray(input.items)) throw new HttpError(400, 'A note needs a list of up to six things that changed.')
  if (input.items.length < ITEMS_MIN) throw new HttpError(400, 'A note needs at least one thing that changed.')
  if (input.items.length > ITEMS_MAX) throw new HttpError(400, `A note can have at most ${ITEMS_MAX} things that changed.`)

  const items = input.items.map((raw) => {
    const item = asObject(raw)
    refuseUnknown(item, ['heading', 'body', 'image_url'])
    return {
      heading: text(item.heading, 'Each heading', HEADING_MAX),
      body: text(item.body, 'Each description', BODY_MAX),
      ...(item.image_url === undefined || item.image_url === null
        ? {}
        : { image_url: acceptedImageUrl(item.image_url) }),
    }
  })

  return { version: input.version, title, intro, items }
}

export function parseBuild(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,10}$/u.test(value)) throw new HttpError(400, 'That release could not be read.')
  const build = Number(value)
  if (!Number.isSafeInteger(build) || build < 0 || build > BUILD_MAX) {
    throw new HttpError(400, 'That release could not be read.')
  }
  return build
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin reads
// ─────────────────────────────────────────────────────────────────────────────

/** How many rows a note wrote, and how many of them were read. */
async function rowCounts(note: ReleaseNoteDoc): Promise<{ rows: number; opened: number }> {
  if (note.status !== 'published') return { rows: 0, opened: 0 }
  const [rows, opened] = await Promise.all([
    mongoColl.playerNotifications().countDocuments({ type: 'whats_new', release_build: note._id }),
    mongoColl.playerNotifications().countDocuments({
      type: 'whats_new', release_build: note._id, read_at: { $exists: true },
    }),
  ])
  return { rows, opened }
}

/** `GET /admin/release-notes`: every note, newest build first. */
export async function listReleaseNotes(): Promise<{
  items: Array<{
    build: number
    version: string
    title: string
    status: 'draft' | 'published'
    published_at?: Date
    pushed_at?: Date
    rows: number
    opened: number
  }>
}> {
  const notes = await mongoColl.releaseNotes().find({}).sort({ _id: -1 }).toArray()
  const items = await Promise.all(notes.map(async (note) => {
    const counts = await rowCounts(note)
    return {
      build: note._id,
      version: note.version,
      title: note.title,
      status: note.status,
      ...(note.published_at ? { published_at: note.published_at } : {}),
      ...(note.pushed_at ? { pushed_at: note.pushed_at } : {}),
      ...counts,
    }
  }))
  return { items }
}

function publicNote(note: ReleaseNoteDoc) {
  return {
    build: note._id,
    version: note.version,
    title: note.title,
    ...(note.intro ? { intro: note.intro } : {}),
    items: note.items.map((item) => ({
      heading: item.heading,
      body: item.body,
      ...(item.image_url ? { image_url: item.image_url } : {}),
    })),
    ...(note.published_at ? { published_at: note.published_at } : {}),
  }
}

/** `GET /admin/release-notes/:build`: one note as the owner wrote it. */
export async function adminReleaseNote(rawBuild: unknown) {
  const build = parseBuild(rawBuild)
  const note = await mongoColl.releaseNotes().findOne({ _id: build })
  if (!note) throw new HttpError(404, 'That release has no note yet.')
  return {
    ...publicNote(note),
    status: note.status,
    ...(note.pushed_at ? { pushed_at: note.pushed_at } : {}),
    created_at: note.created_at,
    updated_at: note.updated_at,
    ...(await rowCounts(note)),
  }
}

/**
 * `GET /app/whats-new/:build`: a published note, exactly the keys the app draws.
 * A draft is a 404 here, the same as one that does not exist: the console's
 * unfinished words never reach a player.
 */
export async function publicReleaseNote(rawBuild: unknown) {
  const build = parseBuild(rawBuild)
  const note = await mongoColl.releaseNotes().findOne({ _id: build, status: 'published' })
  if (!note) throw new HttpError(404, 'That update note is no longer here.')
  return publicNote(note)
}

/**
 * `PUT /admin/release-notes/:build`: create or save a draft, or edit a published
 * note. Editing a live note is allowed on purpose — a typo in "what's new"
 * should be fixable without inventing a build — and the page always reads the
 * live document, so the fix is what players see next.
 */
export async function saveReleaseNote(rawBuild: unknown, body: unknown, now = new Date()) {
  const build = parseBuild(rawBuild)
  const input = noteBody(body)
  const existing = await mongoColl.releaseNotes().findOne({ _id: build })

  if (existing) {
    await mongoColl.releaseNotes().updateOne(
      { _id: build },
      {
        $set: { version: input.version, title: input.title, items: input.items, updated_at: now,
          ...(input.intro ? { intro: input.intro } : {}) },
        ...(input.intro ? {} : { $unset: { intro: '' } }),
      },
    )
  } else {
    await mongoColl.releaseNotes().insertOne({
      _id: build,
      version: input.version,
      title: input.title,
      ...(input.intro ? { intro: input.intro } : {}),
      items: input.items,
      status: 'draft',
      created_at: now,
      updated_at: now,
    })
  }
  return adminReleaseNote(String(build))
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The confirmation for a publish is its own kind, so a token from an update
 * check can never publish a note and one from a publish can never announce a
 * build. Issued here rather than in `app-release.service` so the notes' own
 * module owns its side of the pair.
 */
function issuePublishConfirm(build: number, now: Date): string {
  return issueConfirm('whats_new', build, now)
}

type PublishInput = { dry_run: boolean; push: boolean; confirm?: string }

export function publishBody(body: unknown): PublishInput {
  const input = asObject(body)
  refuseUnknown(input, ['dry_run', 'push', 'confirm'])
  if (typeof input.dry_run !== 'boolean') throw new HttpError(400, 'dry_run must be true or false.')
  if (typeof input.push !== 'boolean') throw new HttpError(400, 'push must be true or false.')
  if (input.confirm !== undefined && typeof input.confirm !== 'string') {
    throw new HttpError(400, 'The confirmation must be the token from the check.')
  }
  return {
    dry_run: input.dry_run,
    push: input.push,
    ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
  }
}

/** The row's words: the owner's title, and its intro or else its first heading. */
function rowWords(note: ReleaseNoteDoc): { title: string; body: string; imageUrl?: string } {
  return {
    title: note.title,
    body: note.intro?.trim() || note.items[0]?.heading || note.title,
    ...(note.items[0]?.image_url ? { imageUrl: note.items[0].image_url } : {}),
  }
}

/** Who a note reaches: every signed-in player active in the last 90 days. */
function noteTargets(now: Date) {
  return activeSignedPlayers(now, AUDIENCE_DAYS)
}

/**
 * `POST /admin/release-notes/:build/publish` with
 * `{ dry_run, push, confirm? }`.
 *
 * A dry run counts the players and devices it would reach and hands back a
 * token; the real send needs that token and refuses a second publish of a note
 * that is already live. Players on an older build get the row too — the page
 * tells them to update, which is the point of writing it.
 *
 * A published note is still editable afterwards; publishing it again is not the
 * same thing and is refused.
 */
export async function publishReleaseNote(rawBuild: unknown, body: unknown, now = new Date()) {
  const build = parseBuild(rawBuild)
  const input = publishBody(body)
  const note = await mongoColl.releaseNotes().findOne({ _id: build })
  if (!note) throw new HttpError(404, 'That release has no note yet.')

  const players = await noteTargets(now)

  if (input.dry_run) {
    const devices = players.length === 0 ? 0 : await mongoColl.pushDevices()
      .countDocuments({ player_id: { $in: players } })
    return { players: players.length, devices, confirm: issuePublishConfirm(build, now) }
  }

  if (!input.confirm) throw new HttpError(400, 'A confirmation from the check is required.')
  // Checked before anything is reserved: a note marked live with its push
  // silently dropped is worse than a publish the owner can simply retry.
  if (input.push && !fcmSender.configured()) throw new HttpError(503, 'Push is not switched on, so nothing was sent.')
  consumeConfirm(input.confirm, 'whats_new', build, now)

  // Reserved before anything is written: the filter on `status` is the guard, so
  // two presses that race cannot both write a row for every player, and a note
  // that is already live is refused here rather than by a second read.
  const reserved = await mongoColl.releaseNotes().updateOne(
    { _id: build, status: 'draft' },
    { $set: { status: 'published', published_at: now, updated_at: now } },
  )
  if (reserved.matchedCount === 0) throw new HttpError(409, 'This note has already been sent to players.')

  const words = rowWords(note)
  const rows = await recordWhatsNewRows(players, { build, ...words })

  let pushed = 0
  let held = 0
  if (input.push) {
    const payload = whatsNewNotification(note, build)
    const devices = players.length === 0 ? [] : await mongoColl.pushDevices()
      .find({ player_id: { $in: players } })
      .toArray()
    const immediate = devices.filter((device) => !isNight(device.tz_offset_minutes, now))
    const night = devices.filter((device) => isNight(device.tz_offset_minutes, now))
    const results = await Promise.allSettled(immediate.map((device) => fcmSender.send(device, payload)))
    pushed = results.filter((result) => result.status === 'fulfilled' && result.value).length
    held = await queueHeldWhatsNew(build, night, now)
    await mongoColl.releaseNotes().updateOne({ _id: build }, { $set: { pushed_at: now } })
  }

  return { build, players: players.length, rows, ...(input.push ? { devices: pushed, held } : {}) }
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
 * A note's push keeps the same night hold as an update round: nobody is woken
 * at 23:00 for news that will still be true in the morning.
 */
async function queueHeldWhatsNew(build: number, devices: Array<{ player_id: ObjectId; tz_offset_minutes?: number }>,
  now: Date): Promise<number> {
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
      await queue.add('whats-new-held', {
        task: 'whats-new-held',
        build,
        playerIds: [...players],
        tzOffsetMinutes: offset,
      }, {
        delay: Math.max(0, at.getTime() - now.getTime()),
        jobId: `whats-new-held-${build}-${offset}-${at.getTime()}`,
        removeOnComplete: QUEUE_RETENTION.maintenance.removeOnComplete,
        removeOnFail: QUEUE_RETENTION.maintenance.removeOnFail,
      })
    }
    return devices.length
  } catch (error) {
    log.error('release_note.held_queue_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

/**
 * The `whats-new-held` job: push the note to the phones that were asleep.
 *
 * Nothing is re-written here — the in-app rows went out at publish time. Only a
 * note that is still published is sent, so a note taken down overnight is not
 * announced in the morning.
 */
export async function sendHeldWhatsNew(
  data: { build: number; playerIds: string[]; tzOffsetMinutes: number },
): Promise<{ sent: number }> {
  if (!fcmSender.configured()) return { sent: 0 }
  const note = await mongoColl.releaseNotes().findOne({ _id: data.build, status: 'published' })
  if (!note) return { sent: 0 }

  const playerIds = (data.playerIds ?? []).map((id) => parseObjectId(id))
  const devices = await mongoColl.pushDevices().find({
    player_id: { $in: playerIds },
    tz_offset_minutes: data.tzOffsetMinutes,
  }).toArray()
  if (devices.length === 0) return { sent: 0 }

  const payload = whatsNewNotification(note, data.build)
  const results = await Promise.allSettled(devices.map((device) => fcmSender.send(device, payload)))
  return { sent: results.filter((result) => result.status === 'fulfilled' && result.value).length }
}
