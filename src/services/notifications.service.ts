import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { log } from '../utils/logger'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'
import { filmReadyNotification, storyReplyNotification } from './push/fcm'
import { pushToPlayerDevices } from './push/devices'
import type { NotificationThread, NotificationType, PlayerNotificationDoc } from '../models/notification.model'

/**
 * The in-app bell (group-chat.md, "In-app notifications").
 *
 * Four events leave a row: an unprompted direct message is scheduled, a picture
 * the player did not tap for is ready, a film finishes, and a reply the player
 * started finishes while no socket of theirs is on that save. Every row is
 * written through {@link recordNotification} (or {@link recordStoryReply}, which
 * replaces rather than stacks) in the same path that already tells the app, and
 * a failure there is only ever logged — the message, picture, film or reply is
 * never lost because a bell row could not be written.
 *
 * Rows hold no chat text. `title`/`body` come only from the contract's words
 * and a character's name; `image_url` is that character's portrait, the film's
 * poster or the world's cover. Optional keys are omitted rather than written
 * null, and `event_id` is internal: it is never on the wire.
 */

export const NOTIFICATIONS_PAGE_SIZE = 30
export const NOTIFICATIONS_MAX_PER_PLAYER = 100
export const NOTIFICATIONS_READ_IDS_MAX = 100
/** How long a socket's claim on one save outlives its last frame. */
export const WATCHING_TTL_SECONDS = 120
/** How long a player counts as having the app open; every frame renews it. */
export const ONLINE_TTL_SECONDS = 15 * 60

/** What one row looks like on the wire: dates are ISO, ids are hex strings. */
export interface NotificationItem {
  id: string
  type: NotificationType
  instance_id: string
  character_id?: string
  thread?: NotificationThread
  media_id?: string
  title: string
  body: string
  image_url?: string
  created_at: string
  read_at?: string
}

/**
 * The contract's words. A film and a story row lead with the save's own title;
 * a group reply names the speaker and a normal-world reply cannot. A group
 * without a speaker has no honest sentence, so it is refused.
 */
export function notificationWords(
  type: NotificationType,
  options: { name?: string; title?: string } = {},
): { title: string; body: string } | undefined {
  if (type === 'film_ready') return options.title ? { title: options.title, body: 'Your film is ready' } : undefined
  if (type === 'story_reply') {
    if (!options.title) return undefined
    return { title: options.title, body: options.name ? `${options.name} replied` : 'Your story has moved on' }
  }
  if (!options.name) return undefined
  return { title: options.name, body: `${options.name} sent you ${type === 'group_direct' ? 'a message' : 'a picture'}` }
}

export function publicNotification(row: PlayerNotificationDoc): NotificationItem {
  return {
    id: row._id.toHexString(),
    type: row.type,
    instance_id: row.instance_id.toHexString(),
    ...(row.character_id ? { character_id: row.character_id } : {}),
    ...(row.thread ? { thread: row.thread } : {}),
    ...(row.media_id ? { media_id: row.media_id } : {}),
    title: row.title,
    body: row.body,
    ...(row.image_url ? { image_url: row.image_url } : {}),
    created_at: row.created_at.toISOString(),
    ...(row.read_at ? { read_at: row.read_at.toISOString() } : {}),
  }
}

async function unreadCount(playerId: ObjectId): Promise<number> {
  return mongoColl.playerNotifications().countDocuments({ player_id: playerId, read_at: { $exists: false } })
}

/** At most 100 rows per player: the oldest go, which is the oldest `_id`. */
async function trimToCap(playerId: ObjectId): Promise<void> {
  const excess = await mongoColl.playerNotifications().countDocuments({ player_id: playerId }) - NOTIFICATIONS_MAX_PER_PLAYER
  if (excess <= 0) return
  const oldest = await mongoColl.playerNotifications()
    .find({ player_id: playerId }, { projection: { _id: 1 } })
    .sort({ _id: 1 })
    .limit(excess)
    .toArray()
  if (oldest.length) {
    await mongoColl.playerNotifications().deleteMany({ _id: { $in: oldest.map(row => row._id) } })
  }
}

/** The save's own title and cover: the world's, or a group's. Both live on its
 *  template, which is also where the app's library row reads them. */
async function worldHeader(instanceId: string): Promise<{ title: string; cover?: string } | undefined> {
  const instance = await mongoColl.worldInstances().findOne({ _id: parseObjectId(instanceId) },
    { projection: { template_id: 1 } })
  if (!instance) return undefined
  const template = await mongoColl.worldTemplates().findOne({ _id: instance.template_id },
    { projection: { title: 1, image_url: 1 } })
  if (typeof template?.title !== 'string' || !template.title) return undefined
  return { title: template.title,
    ...(typeof template.image_url === 'string' && template.image_url ? { cover: template.image_url } : {}) }
}

/** A character's stored face, if they have one. A missing face is no image, never an error. */
async function memberPortrait(playerId: string, instanceId: string, characterId: string): Promise<string | undefined> {
  try {
    const pid = parseObjectId(playerId), iid = parseObjectId(instanceId)
    const [instance, card] = await Promise.all([
      mongoColl.worldInstances().findOne({ _id: iid, player_id: pid }),
      mongoColl.characters().findOne({ _id: parseObjectId(characterId), instance_id: iid }),
    ])
    if (!instance || !card) return undefined
    // Loaded on use: the bell writes words, and the portrait resolver pulls in
    // the whole media stack, which unrelated audits stub out.
    const { portraitUrl, resolvePortraitHolder } = await import('./media/portraits')
    const holder = await resolvePortraitHolder(instance, card, { isSentient: false })
    return holder.portrait?.asset_key ? portraitUrl(holder.portrait.asset_key) : undefined
  } catch {
    return undefined
  }
}

/**
 * The one writer. It trims, counts and publishes the frame, and it never
 * throws: a caller's message, picture or film must survive a bell failure.
 * Returns the row it wrote, so a push can carry exactly the bell's words.
 */
export async function recordNotification(input: {
  playerId: string
  type: NotificationType
  instanceId: string
  characterId?: string
  name?: string
  imageUrl?: string
  title?: string
  /** Internal: the event this row is about. Never sent. */
  eventId?: string
  mediaId?: string
  thread?: NotificationThread
}): Promise<PlayerNotificationDoc | undefined> {
  try {
    const words = notificationWords(input.type, { name: input.name, title: input.title })
    if (!words) return undefined
    const row: PlayerNotificationDoc = {
      _id: new ObjectId(),
      player_id: parseObjectId(input.playerId),
      type: input.type,
      instance_id: parseObjectId(input.instanceId),
      ...(input.characterId ? { character_id: input.characterId } : {}),
      ...(input.eventId ? { event_id: parseObjectId(input.eventId) } : {}),
      ...(input.mediaId ? { media_id: input.mediaId } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      title: words.title,
      body: words.body,
      ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
      created_at: new Date(),
    }
    await mongoColl.playerNotifications().insertOne(row)
    await trimToCap(row.player_id)
    const unread = await unreadCount(row.player_id)
    // The same send path as every other frame: every socket of this player,
    // and only this player's channel.
    await getRedisClient().publish(`user:${input.playerId}:events`,
      JSON.stringify({ type: 'notification', item: publicNotification(row), unread }))
    return row
  } catch (error) {
    log.warn('notification.record_failed', { type: input.type, error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** A character's unprompted message is scheduled: always a direct thread. */
export async function recordDirectMessage(input: { playerId: string; instanceId: string; characterId: string; name: string }): Promise<void> {
  await recordNotification({ ...input, type: 'group_direct', thread: 'direct',
    imageUrl: await memberPortrait(input.playerId, input.instanceId, input.characterId) })
}

/** A picture the player did not tap for is ready. The tap itself is not news. */
export async function recordSelfieReady(mediaId: string): Promise<void> {
  try {
    const row = await mongoColl.mediaAssets().findOne({ _id: parseObjectId(mediaId) })
    if (!row || row.group_selfie !== true || row.tapped === true || row.notified_at) return
    if (!row.instance_id || !row.character_id) return
    const card = await mongoColl.characters().findOne({ _id: row.character_id, instance_id: row.instance_id })
    if (!card) return
    const playerId = row.player_id.toHexString(), instanceId = row.instance_id.toHexString()
    await recordNotification({ playerId, type: 'group_selfie', instanceId,
      characterId: row.character_id.toHexString(), name: card.canonical_name,
      thread: row.direct_with === undefined ? 'room' : 'direct',
      ...(row.event_id ? { eventId: row.event_id.toHexString() } : {}),
      imageUrl: await memberPortrait(playerId, instanceId, row.character_id.toHexString()) })
  } catch (error) {
    log.warn('notification.record_failed', { type: 'group_selfie', error: error instanceof Error ? error.message : String(error) })
  }
}

/** A film finished, in any world. Its cover stands in for a face, and the push
 *  is the row's own words with the film's id — never a line of the story. */
export async function recordFilmReady(mediaId: string): Promise<void> {
  try {
    const asset = await mongoColl.mediaAssets().findOne({ _id: parseObjectId(mediaId) })
    if (!asset || asset.kind !== 'video' || asset.notified_at || !asset.instance_id) return
    const instanceId = asset.instance_id.toHexString()
    const header = await worldHeader(instanceId)
    if (!header) return
    const playerId = asset.player_id.toHexString()
    const row = await recordNotification({ playerId, type: 'film_ready', instanceId, title: header.title,
      mediaId: asset._id.toHexString(),
      ...(asset.event_id ? { eventId: asset.event_id.toHexString() } : {}),
      ...(asset.poster_url ? { imageUrl: asset.poster_url } : {}) })
    // Sent after the row, and never awaited: a slow provider must not hold the
    // media pipeline open.
    if (row) void pushToPlayerDevices(playerId,
      filmReadyNotification(row.title, row.body, instanceId, asset._id.toHexString()))
  } catch (error) {
    log.warn('notification.record_failed', { type: 'film_ready', error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Whether a finished generation job is a story the player may have missed.
 * A `continue` is the player's own press — nothing enqueues one on its own —
 * so it counts like a typed line. A replay rewrites a turn already told, and a
 * group save writes its own row inside its processor.
 */
export function isStoryTurn(job: { mode?: string; session?: { kind?: string } }): boolean {
  return job.mode !== 'replay' && job.session?.kind !== 'group'
}

/**
 * A reply the player started has finished. The bell row is for the player who
 * is elsewhere: when a socket of theirs is on that save they are watching the
 * reply arrive, so nothing is written and nothing is pushed. One unread row per
 * save — a newer reply replaces the older unread one's time and words instead of
 * stacking a second.
 *
 * Its picture is the group's first speaker, or the world's cover; a face or a
 * cover that does not exist is left out rather than filled with a default.
 */
export async function recordStoryReply(input: {
  playerId: string
  instanceId: string
  eventId?: string
  /** Set for a group save: which place a tap opens. */
  thread?: NotificationThread
  characterId?: string
  name?: string
}): Promise<void> {
  try {
    if (await isWatching(input.playerId, input.instanceId)) return
    const header = await worldHeader(input.instanceId)
    if (!header) return
    // A group row names its speaker; without one there is no honest sentence.
    if (input.thread && !input.name) return
    const words = notificationWords('story_reply', { title: header.title, name: input.thread ? input.name : undefined })
    if (!words) return
    const imageUrl = input.thread && input.characterId
      ? await memberPortrait(input.playerId, input.instanceId, input.characterId)
      : header.cover
    const pid = parseObjectId(input.playerId), iid = parseObjectId(input.instanceId)
    const coll = mongoColl.playerNotifications()
    const next = {
      ...(input.eventId ? { event_id: parseObjectId(input.eventId) } : {}),
      ...(input.characterId ? { character_id: input.characterId } : {}),
      ...(input.thread ? { thread: input.thread } : {}),
      ...(imageUrl ? { image_url: imageUrl } : {}),
      title: words.title,
      body: words.body,
      created_at: new Date(),
    }
    const older = await coll.findOne({ player_id: pid, instance_id: iid, type: 'story_reply', read_at: { $exists: false } })
    if (older) {
      // The replaced row may have carried a face the new reply has not got.
      const staleImage = imageUrl ? {} : older.image_url ? { $unset: { image_url: 1 as const } } : {}
      await coll.updateOne({ _id: older._id }, { $set: next, ...staleImage })
    } else {
      await coll.insertOne({ _id: new ObjectId(), player_id: pid, instance_id: iid, type: 'story_reply', ...next } as PlayerNotificationDoc)
      await trimToCap(pid)
    }
    const saved = await coll.findOne({ player_id: pid, instance_id: iid, type: 'story_reply', read_at: { $exists: false } })
    if (!saved) return
    // The frame is only worth sending to a player who has the app open.
    if (await isPlayerOnline(input.playerId)) {
      const unread = await unreadCount(pid)
      await getRedisClient().publish(`user:${input.playerId}:events`,
        JSON.stringify({ type: 'notification', item: publicNotification(saved), unread }))
    }
    // Sent after the row and the frame, and never awaited: a slow provider must
    // not hold a finished turn (or its lock) open.
    void pushToPlayerDevices(input.playerId,
      storyReplyNotification(words.title, words.body, input.instanceId, input.thread))
  } catch (error) {
    log.warn('notification.record_failed', { type: 'story_reply', error: error instanceof Error ? error.message : String(error) })
  }
}

/** The reply a scheduled direct message was waiting for now exists: tie the row
 *  to it, so a rewind over that reply removes the row with it. */
export async function attachDirectRowEvent(input: { playerId: string; instanceId: string; characterId: string; eventId: string }): Promise<void> {
  try {
    await mongoColl.playerNotifications().updateOne({
      player_id: parseObjectId(input.playerId),
      instance_id: parseObjectId(input.instanceId),
      character_id: input.characterId,
      type: 'group_direct',
      read_at: { $exists: false },
      event_id: { $exists: false },
    }, { $set: { event_id: parseObjectId(input.eventId) } })
  } catch (error) {
    log.warn('notification.mark_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * A socket is looking at a save. Redis is the shared place the worker can read,
 * since the sockets live in the server process; a claim expires on its own, so
 * a crash can only delay a bell row by {@link WATCHING_TTL_SECONDS}.
 */
export async function markWatching(playerId: string, instanceId: string): Promise<void> {
  try { await getRedisClient().set(`watching:${playerId}:${instanceId}`, '1', 'EX', WATCHING_TTL_SECONDS) } catch { /* the bell is not worth failing a frame */ }
}

/** The last socket on that save closed. */
export async function clearWatching(playerId: string, instanceId: string): Promise<void> {
  try { await getRedisClient().del(`watching:${playerId}:${instanceId}`) } catch { /* see markWatching */ }
}

export async function isWatching(playerId: string, instanceId: string): Promise<boolean> {
  try { return (await getRedisClient().get(`watching:${playerId}:${instanceId}`)) !== null } catch { return false }
}

/** A player has the app open somewhere; renewed by every socket frame. */
export async function markPlayerOnline(playerId: string): Promise<void> {
  try { await getRedisClient().set(`online:${playerId}`, '1', 'EX', ONLINE_TTL_SECONDS) } catch { /* see markWatching */ }
}

export async function clearPlayerOnline(playerId: string): Promise<void> {
  try { await getRedisClient().del(`online:${playerId}`) } catch { /* see markWatching */ }
}

export async function isPlayerOnline(playerId: string): Promise<boolean> {
  try { return (await getRedisClient().get(`online:${playerId}`)) !== null } catch { return false }
}

/**
 * A rewind removes turns: the rows tied to them go with the media, so the bell
 * never opens something the player just un-wrote. Called next to the media
 * purge; a failure leaves the rows and is only logged.
 */
export async function purgeNotificationsForEvents(instanceId: ObjectId, eventIds: ObjectId[]): Promise<void> {
  if (!eventIds.length) return
  try {
    await mongoColl.playerNotifications().deleteMany({ instance_id: instanceId, event_id: { $in: eventIds } })
  } catch (error) {
    log.warn('notification.purge_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

function pageCursor(before: unknown): ObjectId | undefined {
  if (before === undefined) return undefined
  if (typeof before !== 'string' || !/^[a-fA-F0-9]{24}$/u.test(before)) throw new HttpError(400, 'That page could not be read.')
  return new ObjectId(before)
}

/** `GET /notifications?before=<id>`: newest first, 30 at a time, own rows only. */
export async function listNotifications(playerId: string, query: { before?: unknown } = {}): Promise<{ items: NotificationItem[]; unread: number }> {
  const pid = parseObjectId(playerId)
  const cursor = pageCursor(query.before)
  const rows = await mongoColl.playerNotifications()
    .find({ player_id: pid, ...(cursor ? { _id: { $lt: cursor } } : {}) })
    .sort({ _id: -1 })
    .limit(NOTIFICATIONS_PAGE_SIZE)
    .toArray()
  return { items: rows.map(publicNotification), unread: await unreadCount(pid) }
}

/**
 * `POST /notifications/read` with `{ ids }`, `{ all: true }` or `{ media_id }`
 * (a film opened from Keepsakes). Another player's id or film is silently not
 * touched: the filter is the player's own rows. Mixing `media_id` with ids or
 * all is refused, so one call always means one thing.
 */
export async function markNotificationsRead(playerId: string, body: unknown): Promise<{ unread: number }> {
  const pid = parseObjectId(playerId)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'That request could not be read.')
  const input = body as Record<string, unknown>
  const keys = Object.keys(input)
  if (keys.some(key => key !== 'ids' && key !== 'all' && key !== 'media_id')) throw new HttpError(400, 'That request could not be read.')
  if (input.all !== undefined && input.all !== true) throw new HttpError(400, 'That request could not be read.')
  if (input.media_id !== undefined) {
    if (keys.length !== 1) throw new HttpError(400, 'That request could not be read.')
    if (typeof input.media_id !== 'string' || !/^[a-fA-F0-9]{24}$/u.test(input.media_id)) throw new HttpError(400, 'That request could not be read.')
    await mongoColl.playerNotifications().updateMany({
      player_id: pid, type: 'film_ready', media_id: input.media_id, read_at: { $exists: false },
    }, { $set: { read_at: new Date() } })
    return { unread: await unreadCount(pid) }
  }
  if (input.all === true && input.ids !== undefined) throw new HttpError(400, 'That request could not be read.')
  if (input.all === true) {
    await mongoColl.playerNotifications().updateMany({ player_id: pid, read_at: { $exists: false } }, { $set: { read_at: new Date() } })
    return { unread: await unreadCount(pid) }
  }
  if (!Array.isArray(input.ids)) throw new HttpError(400, 'That request could not be read.')
  if (input.ids.length > NOTIFICATIONS_READ_IDS_MAX) throw new HttpError(400, 'That request could not be read.')
  const ids = input.ids.map(id => {
    if (typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/u.test(id)) throw new HttpError(400, 'That request could not be read.')
    return new ObjectId(id)
  })
  if (ids.length) {
    await mongoColl.playerNotifications().updateMany({ player_id: pid, _id: { $in: ids }, read_at: { $exists: false } },
      { $set: { read_at: new Date() } })
  }
  return { unread: await unreadCount(pid) }
}

/** Opening a direct thread clears its rows. Reading them again is harmless. */
export async function markThreadRead(input: { playerId: string; instanceId: string; characterId: string }): Promise<void> {
  try {
    await mongoColl.playerNotifications().updateMany({
      player_id: parseObjectId(input.playerId),
      instance_id: parseObjectId(input.instanceId),
      character_id: input.characterId,
      read_at: { $exists: false },
    }, { $set: { read_at: new Date() } })
  } catch (error) {
    log.warn('notification.mark_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Opening a save clears the reply rows it gathered while the player was away.
 *  Its thread rows are cleared by the thread's own open call. */
export async function markSaveStoryRepliesRead(input: { playerId: string; instanceId: string }): Promise<void> {
  try {
    await mongoColl.playerNotifications().updateMany({
      player_id: parseObjectId(input.playerId),
      instance_id: parseObjectId(input.instanceId),
      type: 'story_reply',
      read_at: { $exists: false },
    }, { $set: { read_at: new Date() } })
  } catch (error) {
    log.warn('notification.mark_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}
