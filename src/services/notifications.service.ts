import { ObjectId } from 'mongodb'
import { mongoColl } from '../config/mongo'
import { getRedisClient } from '../config/redis'
import { log } from '../utils/logger'
import { HttpError } from '../utils/http-error'
import { parseObjectId } from '../utils/mongo-id'
import type { NotificationType, PlayerNotificationDoc } from '../models/notification.model'

/**
 * The in-app bell (group-chat.md, "In-app notifications").
 *
 * Three events leave a row: an unprompted direct message is scheduled, a
 * picture the player did not tap for is ready, and a film finishes. Every row
 * is written through {@link recordNotification} in the same path that already
 * tells the app, and a failure there is only ever logged — the message, picture
 * or film is never lost because a bell row could not be written.
 *
 * Rows hold no chat text. `title`/`body` come only from the contract's words
 * and a character's name; `image_url` is that character's portrait or the
 * film's cover. Optional keys are omitted rather than written null.
 */

export const NOTIFICATIONS_PAGE_SIZE = 30
export const NOTIFICATIONS_MAX_PER_PLAYER = 100
export const NOTIFICATIONS_READ_IDS_MAX = 100

/** What one row looks like on the wire: dates are ISO, ids are hex strings. */
export interface NotificationItem {
  id: string
  type: NotificationType
  instance_id: string
  character_id?: string
  title: string
  body: string
  image_url?: string
  created_at: string
  read_at?: string
}

/** The contract's words, and the character's name as the row's heading. */
export function notificationWords(type: NotificationType, name?: string): { title: string; body: string } | undefined {
  if (type === 'film_ready') return { title: 'Your film is ready', body: 'Your film is ready' }
  if (!name) return undefined
  return { title: name, body: `${name} sent you ${type === 'group_direct' ? 'a message' : 'a picture'}` }
}

export function publicNotification(row: PlayerNotificationDoc): NotificationItem {
  return {
    id: row._id.toHexString(),
    type: row.type,
    instance_id: row.instance_id.toHexString(),
    ...(row.character_id ? { character_id: row.character_id } : {}),
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
 */
export async function recordNotification(input: {
  playerId: string
  type: NotificationType
  instanceId: string
  characterId?: string
  name?: string
  imageUrl?: string
}): Promise<void> {
  try {
    const words = notificationWords(input.type, input.name)
    if (!words) return
    const row: PlayerNotificationDoc = {
      _id: new ObjectId(),
      player_id: parseObjectId(input.playerId),
      type: input.type,
      instance_id: parseObjectId(input.instanceId),
      ...(input.characterId ? { character_id: input.characterId } : {}),
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
  } catch (error) {
    log.warn('notification.record_failed', { type: input.type, error: error instanceof Error ? error.message : String(error) })
  }
}

/** A character's unprompted message is scheduled (the same path that pushes). */
export async function recordDirectMessage(input: { playerId: string; instanceId: string; characterId: string; name: string }): Promise<void> {
  await recordNotification({ ...input, type: 'group_direct',
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
      imageUrl: await memberPortrait(playerId, instanceId, row.character_id.toHexString()) })
  } catch (error) {
    log.warn('notification.record_failed', { type: 'group_selfie', error: error instanceof Error ? error.message : String(error) })
  }
}

/** A film finished, in any world. Its cover stands in for a face. */
export async function recordFilmReady(mediaId: string): Promise<void> {
  try {
    const row = await mongoColl.mediaAssets().findOne({ _id: parseObjectId(mediaId) })
    if (!row || row.kind !== 'video' || row.notified_at || !row.instance_id) return
    await recordNotification({ playerId: row.player_id.toHexString(), type: 'film_ready',
      instanceId: row.instance_id.toHexString(), ...(row.poster_url ? { imageUrl: row.poster_url } : {}) })
  } catch (error) {
    log.warn('notification.record_failed', { type: 'film_ready', error: error instanceof Error ? error.message : String(error) })
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
 * `POST /notifications/read`. Another player's id is silently not touched: the
 * filter is the player's own rows, so a stranger's id matches nothing.
 */
export async function markNotificationsRead(playerId: string, body: unknown): Promise<{ unread: number }> {
  const pid = parseObjectId(playerId)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'That request could not be read.')
  const input = body as Record<string, unknown>
  if (Object.keys(input).some(key => key !== 'ids' && key !== 'all')) throw new HttpError(400, 'That request could not be read.')
  if (input.all !== undefined && input.all !== true) throw new HttpError(400, 'That request could not be read.')
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
